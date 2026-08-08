/**
 * OpenDART — 내부자(임원) 매수 · 유통주식수 계산 재료.
 *
 * ── 내부자 매수 판별 ────────────────────────────────────────────────────────
 * elestock.json 은 보고서 단위 요약(보고자·직위·소유증감수량)만 준다.
 * "언제, 어떤 방법으로" 샀는지는 보고서 원문에만 있다.
 * 보고서는 거래일로부터 5영업일 이내 제출이라 공시일과 실제 매수일이 다르므로
 * document.xml 을 받아 세부 변동내역의 변동일자·취득방법까지 파싱해 거래일로 매칭한다.
 *
 * ── 유통주식수 ─────────────────────────────────────────────────────────────
 * 유통주식수 = 상장주식수 − 최대주주등 소유주식수 − 자기주식
 * 세 값을 다 못 구하면 상장주식수로 대체하되 free_float_basis 를 'listed_shares' 로
 * 남겨 UI 가 "상장주식수 기준" 배지를 띄우게 한다. 조용히 대체하지 않는다.
 */
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { env, exec, fetchBuffer, fetchJson, parseNum, query } from '../lib/core';

const API = 'https://opendart.fss.or.kr/api';

/* ─────────────────────── corp_code ↔ 종목코드 매핑 ─────────────────────── */

export async function syncCorpCodes(): Promise<number> {
  const buf = await fetchBuffer(`${API}/corpCode.xml?crtfc_key=${env.openDartKey}`);
  const entry = new AdmZip(buf).getEntries().find((e) => e.entryName.endsWith('.xml'));
  if (!entry) throw new Error('corpCode.xml 을 zip 에서 찾지 못했습니다.');

  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
  const doc = parser.parse(entry.getData().toString('utf8')) as {
    result?: { list?: Array<{ corp_code: string; corp_name: string; stock_code?: string }> };
  };
  const list = doc.result?.list ?? [];

  const pairs = list
    .map((r) => ({ corp: String(r.corp_code).padStart(8, '0'), stock: String(r.stock_code ?? '').trim() }))
    .filter((r) => r.stock.length === 6);

  let n = 0;
  for (const p of pairs) {
    n += await exec(
      `update instruments set corp_code = $1 where symbol = $2 and corp_code is distinct from $1`,
      [p.corp, p.stock],
    );
  }
  return n;
}

/* ──────────────────────────── 내부자 매수 ──────────────────────────── */

interface ElestockRow {
  rcept_no: string;
  rcept_dt: string;
  corp_code: string;
  corp_name: string;
  repror: string;
  isu_exctv_rgist_at: string;
  isu_exctv_ofcps: string;
  isu_main_shrholdr: string;
  sp_stock_lmp_cnt: string;
  sp_stock_lmp_irds_cnt: string;
}

/** 대표이사·사내이사(등기임원) 인지 */
export function isOfficerOfInterest(position: string, registered: string): boolean {
  const p = position ?? '';
  if (/대표이사|사장|회장|부회장|대표집행임원/.test(p)) return true;
  if (/사내이사|등기이사|이사|감사/.test(p) && /등기/.test(registered ?? '')) return true;
  return false;
}

/** 취득방법이 장내매수인지 */
export function isOpenMarketBuy(method: string): boolean {
  const m = (method ?? '').replace(/\s/g, '');
  if (!m) return false;
  if (/매도|처분/.test(m)) return false;
  return /장내/.test(m) || /시장내매수/.test(m);
}

/** 특정 기업의 보고서 목록을 캐시에 적재. */
export async function syncInsiderReports(corpCode: string, symbol: string): Promise<number> {
  const url = `${API}/elestock.json?crtfc_key=${env.openDartKey}&corp_code=${corpCode}`;
  const json = await fetchJson<{ status: string; message: string; list?: ElestockRow[] }>(url, {
    intervalMs: 1100,
  });
  if (json.status === '013') return 0; // 조회된 데이터 없음
  if (json.status !== '000') throw new Error(`OpenDART elestock ${json.status}: ${json.message}`);

  let n = 0;
  for (const r of json.list ?? []) {
    n += await exec(
      `insert into insider_reports
         (rcept_no, corp_code, symbol, corp_name, disclosed_at, reporter, registered, position,
          main_holder, after_qty, change_qty)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (rcept_no) do update set
         symbol = excluded.symbol,
         change_qty = excluded.change_qty,
         after_qty = excluded.after_qty`,
      [
        r.rcept_no,
        corpCode,
        symbol,
        r.corp_name,
        r.rcept_dt,
        r.repror,
        r.isu_exctv_rgist_at,
        r.isu_exctv_ofcps,
        r.isu_main_shrholdr,
        parseNum(r.sp_stock_lmp_cnt),
        parseNum(r.sp_stock_lmp_irds_cnt),
      ],
    );
  }
  return n;
}

export interface ReportDetail {
  tradeDate: string | null;
  officer: string | null;
  method: string | null;
  qty: number;
  unitPrice: number | null;
}

/** 보고서 원문(document.xml)에서 세부 변동내역을 뽑는다. */
export async function parseReportDetail(rceptNo: string): Promise<ReportDetail[]> {
  const buf = await fetchBuffer(`${API}/document.xml?crtfc_key=${env.openDartKey}&rcept_no=${rceptNo}`);
  let xml = '';
  try {
    xml = new AdmZip(buf)
      .getEntries()
      .map((e) => e.getData().toString('utf8'))
      .join('\n');
  } catch {
    xml = buf.toString('utf8');
  }
  if (!xml.trim()) return [];

  // 세부변동내역 표의 한 행은 아래 순서다(공시 서식 고정).
  //   [취득/처분방법 | 변동일 | 증권종류 | 변동전 | 증감 | 변동후 | 단가 | 비고]
  // 열 위치를 그대로 믿지 않고 "변동전 + 증감 = 변동후" 항등식으로 증감 열을 특정한다.
  const out: ReportDetail[] = [];
  const trBlocks = xml.match(/<TR[\s\S]*?<\/TR>/gi) ?? [];
  for (const tr of trBlocks) {
    const cells = (tr.match(/<T[DE][\s\S]*?<\/T[DE]>/gi) ?? []).map((c) =>
      c
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (cells.length < 5) continue;

    const dateIdx = cells.findIndex((c) =>
      /^((?:19|20)\d{2})\s*[-.년/]\s*(\d{1,2})\s*[-.월/]\s*(\d{1,2})/.test(c),
    );
    if (dateIdx < 1) continue; // 방법 열이 앞에 있어야 하므로 0 은 제외 (합계 행 걸러짐)

    const dateHit = /((?:19|20)\d{2})\s*[-.년/]\s*(\d{1,2})\s*[-.월/]\s*(\d{1,2})/.exec(cells[dateIdx]);
    if (!dateHit) continue;

    const method = cells[dateIdx - 1];
    if (!method || !/취득|처분|매수|매도|장내|장외|증여|상속|무상|유상|행사|기타|전환/.test(method)) continue;

    const nums = cells.slice(dateIdx + 1).map((c) => parseNum(c.replace(/[^0-9,+-]/g, '')));
    let qty: number | null = null;
    let price: number | null = null;
    for (let i = 0; i + 2 < nums.length; i++) {
      const [b, d, a] = [nums[i], nums[i + 1], nums[i + 2]];
      if (b === null || d === null || a === null) continue;
      if (b + d !== a) continue;
      qty = d;
      price = nums[i + 3] ?? null;
      break;
    }
    if (qty === null || qty === 0) continue;

    const pad = (s: string) => s.padStart(2, '0');
    out.push({
      tradeDate: `${dateHit[1]}-${pad(dateHit[2])}-${pad(dateHit[3])}`,
      officer: null,
      method,
      qty,
      unitPrice: price,
    });
  }
  return out;
}

/**
 * pending 상태 보고서의 원문을 파싱해 insider_trades 를 채운다.
 *
 * 보고서는 거래일로부터 5영업일 이내 제출이라 공시일과 실제 매수일이 다르다.
 * 그래서 최근 공시만 훑으면 놓치는 건이 생긴다 — sinceDays 를 관찰기간보다 넉넉히
 * 잡아 공시 지연분까지 소급해서 잡는다.
 */
export async function enrichPendingReports(
  limit = 60,
  sinceDays = 120,
): Promise<{ parsed: number; trades: number; skippedOld: number }> {
  // 관찰 범위 밖(오래된) 보고서는 원문을 받지 않고 건너뛴다. 조용히 버리지 않고 상태로 남긴다.
  const skippedOld = await exec(
    `update insider_reports set detail_status = 'skipped'
      where detail_status = 'pending'
        and disclosed_at < (current_date - ($1::int))`,
    [sinceDays],
  );

  const pending = await query<{
    rcept_no: string;
    symbol: string;
    disclosed_at: string;
    reporter: string;
    position: string;
    registered: string;
  }>(
    `select rcept_no, symbol, to_char(disclosed_at,'YYYY-MM-DD') disclosed_at,
            reporter, position, registered
       from insider_reports
      where detail_status = 'pending'
        and symbol is not null
        and change_qty > 0
      order by disclosed_at desc
      limit $1`,
    [limit],
  );

  let parsed = 0;
  let trades = 0;
  for (const r of pending) {
    if (!isOfficerOfInterest(r.position, r.registered)) {
      await exec(`update insider_reports set detail_status = 'skipped' where rcept_no = $1`, [r.rcept_no]);
      continue;
    }
    try {
      for (const d of await parseReportDetail(r.rcept_no)) {
        if (d.qty <= 0) continue;
        trades += await exec(
          `insert into insider_trades
             (rcept_no, symbol, trade_date, disclosed_at, officer_name, position, registered,
              change_qty, method, is_open_market_buy, unit_price)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict (rcept_no, symbol, officer_name, trade_date, change_qty, method) do nothing`,
          [
            r.rcept_no,
            r.symbol,
            d.tradeDate,
            r.disclosed_at,
            d.officer ?? r.reporter,
            r.position,
            /등기/.test(r.registered ?? ''),
            d.qty,
            d.method,
            isOpenMarketBuy(d.method ?? ''),
            d.unitPrice,
          ],
        );
      }
      await exec(`update insider_reports set detail_status = 'parsed' where rcept_no = $1`, [r.rcept_no]);
      parsed++;
    } catch (e) {
      await exec(
        `update insider_reports set detail_status = 'failed', detail_error = $2 where rcept_no = $1`,
        [r.rcept_no, e instanceof Error ? e.message : String(e)],
      );
    }
  }
  return { parsed, trades, skippedOld };
}

/* ──────────────────────────── 유통주식수 ──────────────────────────── */

interface HyslrRow {
  nm: string;
  relate: string;
  stock_knd: string;
  trmend_posesn_stock_co: string;
}

interface TreasuryRow {
  acqs_mth1: string;
  acqs_mth2: string;
  acqs_mth3: string;
  stock_knd: string;
  trmend_qy: string;
}

/**
 * 최대주주등 소유주식수 + 자기주식 → free_float_shares 계산.
 * 둘 다 못 구하면 basis 를 'listed_shares' 로 남긴다.
 */
export async function computeFreeFloat(
  symbol: string,
  corpCode: string,
  bsnsYear: string,
  reprtCode = '11011',
): Promise<{ basis: 'computed' | 'listed_shares'; free: number | null }> {
  const inst = await query<{ listed_shares: string | null }>(
    `select listed_shares from instruments where symbol = $1`,
    [symbol],
  );
  const listed = parseNum(inst[0]?.listed_shares);
  if (!listed) return { basis: 'listed_shares', free: null };

  let major: number | null = null;
  let treasury: number | null = null;

  try {
    const j = await fetchJson<{ status: string; list?: HyslrRow[] }>(
      `${API}/hyslrSttus.json?crtfc_key=${env.openDartKey}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}`,
      { intervalMs: 1100 },
    );
    if (j.status === '000') {
      const sum = (j.list ?? [])
        .filter((r) => !r.stock_knd || /보통주/.test(r.stock_knd))
        .filter((r) => !/계$/.test((r.nm ?? '').trim()))
        .reduce((acc, r) => acc + (parseNum(r.trmend_posesn_stock_co) ?? 0), 0);
      major = sum > 0 ? sum : null;
    }
  } catch {
    major = null;
  }

  try {
    const j = await fetchJson<{ status: string; list?: TreasuryRow[] }>(
      `${API}/tesstkAcqsDspsSttus.json?crtfc_key=${env.openDartKey}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}`,
      { intervalMs: 1100 },
    );
    if (j.status === '000') {
      const sum = (j.list ?? [])
        .filter((r) => /합\s*계|총\s*계/.test(`${r.acqs_mth1 ?? ''}${r.acqs_mth2 ?? ''}${r.acqs_mth3 ?? ''}`))
        .filter((r) => !r.stock_knd || /보통주/.test(r.stock_knd))
        .reduce((acc, r) => acc + (parseNum(r.trmend_qy) ?? 0), 0);
      treasury = sum > 0 ? sum : null;
    }
  } catch {
    treasury = null;
  }

  if (major === null && treasury === null) {
    await exec(
      `update instruments
          set free_float_shares = listed_shares,
              free_float_basis = 'listed_shares',
              free_float_updated_at = now()
        where symbol = $1`,
      [symbol],
    );
    return { basis: 'listed_shares', free: listed };
  }

  const free = Math.max(0, listed - (major ?? 0) - (treasury ?? 0));
  await exec(
    `update instruments
        set major_holder_shares = $2,
            treasury_shares = $3,
            free_float_shares = $4,
            free_float_basis = 'computed',
            free_float_updated_at = now()
      where symbol = $1`,
    [symbol, major, treasury, free],
  );
  return { basis: 'computed', free };
}

export function dartViewerUrl(rceptNo: string): string {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}
