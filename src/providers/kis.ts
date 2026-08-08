/**
 * 한국투자증권(KIS) Open API provider.
 *
 * ── 왜 이게 중요한가 ────────────────────────────────────────────────────────
 * KRX Data Marketplace 가 로그인 월로 막힌 뒤 사모 세분은 CSV 수동 내려받기밖에
 * 방법이 없었다. 그런데 KIS 의 `investor-trade-by-stock-daily`(FHPTJ04160001)가
 * 사모펀드(pe_fund_ntby_vol)를 포함한 투자자 12구분을 일별로 전부 준다.
 * 2026-08-07 검증: 파마리서치(214450) 사모 3일 합계 365,977 = KRX CSV 원본과 일치.
 *
 * ── 계정 종류 ──────────────────────────────────────────────────────────────
 *   모의(기본) https://openapivts.koreainvestment.com:29443  초당 2건
 *   실전       https://openapi.koreainvestment.com:9443      초당 20건
 * 과거 일별 데이터는 모의에서도 실데이터다. 다만 당일 장중 실시간 시세는
 * 모의 서버 값이라 실시간 분봉/프로그램매매는 실전 계정이 있어야 의미가 있다.
 *
 * 접근토큰은 발급이 1분당 1회로 제한되고 유효기간이 24시간이라 파일에 캐시한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bulkInsert, compact, expand, parseNum, sleep } from '../lib/core';
import type { FlowRow, InvestorFlowProvider, InvestorType } from './investor-flow';

/* ──────────────────────────── 설정 ──────────────────────────── */

const DOMAIN = (process.env.KIS_DOMAIN ?? 'https://openapivts.koreainvestment.com:29443').replace(/\/$/, '');
const APP_KEY = () => process.env.KIS_APP_KEY ?? '';
const APP_SECRET = () => process.env.KIS_APP_SECRET ?? '';
const RATE_PER_SEC = Number(process.env.KIS_RATE_PER_SEC ?? (DOMAIN.includes('vts') ? 2 : 15));
const TOKEN_CACHE =
  process.env.KIS_TOKEN_CACHE ??
  path.join(process.env.LOCALAPPDATA ?? '.', 'supply-demand-dashboard', 'kis-token.json');

export const kisConfigured = () => Boolean(APP_KEY() && APP_SECRET());
export const kisIsPaper = () => DOMAIN.includes('vts');

/* ──────────────────────── 레이트 리미터 ──────────────────────── */

/** 초당 RATE_PER_SEC 건. 모의는 2건만 넘어도 즉시 거절당한다. */
let windowStart = 0;
let windowCount = 0;
async function gate() {
  for (;;) {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount < RATE_PER_SEC) {
      windowCount++;
      return;
    }
    await sleep(1000 - (now - windowStart) + 20);
  }
}

/* ──────────────────────────── 토큰 ──────────────────────────── */

interface CachedToken {
  access_token: string;
  expires_at: number;
  app_key_tail: string;
  domain: string;
}

let memToken: CachedToken | null = null;

function readCache(): CachedToken | null {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8')) as CachedToken;
    if (raw.domain !== DOMAIN) return null;
    if (raw.app_key_tail !== APP_KEY().slice(-6)) return null;
    if (raw.expires_at < Date.now() + 60_000) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(t: CachedToken) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
    fs.writeFileSync(TOKEN_CACHE, JSON.stringify(t), 'utf8');
  } catch {
    /* 캐시 실패는 치명적이지 않다 */
  }
}

export async function accessToken(): Promise<string> {
  if (!kisConfigured()) throw new Error('KIS_APP_KEY / KIS_APP_SECRET 가 필요합니다.');
  if (memToken && memToken.expires_at > Date.now() + 60_000) return memToken.access_token;

  const cached = readCache();
  if (cached) {
    memToken = cached;
    return cached.access_token;
  }

  const res = await fetch(`${DOMAIN}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: APP_KEY(),
      appsecret: APP_SECRET(),
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_code?: string;
    error_description?: string;
  };
  if (!body.access_token) {
    throw new Error(`KIS 토큰 발급 실패 ${body.error_code ?? res.status}: ${body.error_description ?? ''}`);
  }
  const token: CachedToken = {
    access_token: body.access_token,
    expires_at: Date.now() + (body.expires_in ?? 86400) * 1000,
    app_key_tail: APP_KEY().slice(-6),
    domain: DOMAIN,
  };
  memToken = token;
  writeCache(token);
  return token.access_token;
}

/* ──────────────────────────── 호출 ──────────────────────────── */

interface KisResponse {
  rt_cd?: string;
  msg1?: string;
  msg_cd?: string;
  [k: string]: unknown;
}

async function call<T extends object>(
  urlPath: string,
  trId: string,
  params: Record<string, string>,
  retries = 3,
): Promise<T & KisResponse> {
  type R = T & KisResponse;
  const token = await accessToken();
  const url = new URL(DOMAIN + urlPath);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let last = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    await gate();
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: APP_KEY(),
        appsecret: APP_SECRET(),
        tr_id: trId,
        custtype: 'P',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
    const text = await res.text();
    let json: R;
    try {
      json = JSON.parse(text) as R;
    } catch {
      last = `NON-JSON ${res.status}: ${text.slice(0, 120)}`;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    // 초당 거래건수 초과는 재시도로 흡수한다.
    if (json.rt_cd !== '0' && /초당|EGW00201/.test(`${json.msg1 ?? ''}${json.msg_cd ?? ''}`)) {
      last = String(json.msg1 ?? '').trim();
      await sleep(1100 * (attempt + 1));
      continue;
    }
    return json;
  }
  throw new Error(`KIS ${trId} 실패: ${last}`);
}

/* ─────────────────── 투자자별 수급 (핵심) ─────────────────── */

/**
 * KIS 응답 필드 → 우리 investor_type 매핑.
 * 수량/금액 필드 이름 규칙이 구분마다 달라(vol/qty, tr_pbmn/pbmn) 명시적으로 적는다.
 */
const INVESTOR_FIELDS: Array<{ type: InvestorType; qty: string; amt: string }> = [
  { type: 'individual', qty: 'prsn_ntby_qty', amt: 'prsn_ntby_tr_pbmn' },
  { type: 'foreign', qty: 'frgn_ntby_qty', amt: 'frgn_ntby_tr_pbmn' },
  { type: 'other_foreign', qty: 'frgn_nreg_ntby_qty', amt: 'frgn_nreg_ntby_pbmn' },
  { type: 'institution_total', qty: 'orgn_ntby_qty', amt: 'orgn_ntby_tr_pbmn' },
  { type: 'financial_investment', qty: 'scrt_ntby_qty', amt: 'scrt_ntby_tr_pbmn' },
  { type: 'insurance', qty: 'insu_ntby_qty', amt: 'insu_ntby_tr_pbmn' },
  { type: 'investment_trust', qty: 'ivtr_ntby_qty', amt: 'ivtr_ntby_tr_pbmn' },
  { type: 'private_fund', qty: 'pe_fund_ntby_vol', amt: 'pe_fund_ntby_tr_pbmn' },
  { type: 'bank', qty: 'bank_ntby_qty', amt: 'bank_ntby_tr_pbmn' },
  { type: 'other_finance', qty: 'mrbn_ntby_qty', amt: 'mrbn_ntby_tr_pbmn' },
  { type: 'pension', qty: 'fund_ntby_qty', amt: 'fund_ntby_tr_pbmn' },
  { type: 'other_corp', qty: 'etc_corp_ntby_vol', amt: 'etc_corp_ntby_tr_pbmn' },
];

/** 이 provider 가 실제로 공급하는 투자자 구분 (기타단체 etc_orgt 는 분석 가치가 낮아 제외) */
export const KIS_COVERS: InvestorType[] = INVESTOR_FIELDS.map((f) => f.type);

/**
 * 종목별 투자자매매동향(일별). 한 번 호출에 최근 30영업일이 온다.
 * endDate 기준 과거 30영업일이 반환되므로, 더 긴 기간이 필요하면 endDate 를 옮겨가며 여러 번 부른다.
 */
export async function fetchInvestorFlow(symbol: string, endDateIso: string): Promise<FlowRow[]> {
  const j = await call<{ output2?: Record<string, string>[] }>(
    '/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily',
    'FHPTJ04160001',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: symbol,
      FID_INPUT_DATE_1: compact(endDateIso),
      FID_ORG_ADJ_PRC: '',
      FID_ETC_CLS_CODE: '',
    },
  );
  if (j.rt_cd !== '0') return [];

  const out: FlowRow[] = [];
  for (const r of j.output2 ?? []) {
    const date = r.stck_bsop_date ? expand(r.stck_bsop_date) : null;
    if (!date) continue;
    for (const f of INVESTOR_FIELDS) {
      const qty = parseNum(r[f.qty]);
      if (qty === null) continue;
      // KIS 의 거래대금 필드는 백만원 단위다. 우리 스키마는 전부 원 단위로 통일한다.
      const amtMillion = parseNum(r[f.amt]);
      out.push({
        symbol,
        date,
        investorType: f.type,
        netBuyQty: qty,
        netBuyAmount: amtMillion === null ? null : Math.round(amtMillion * 1_000_000),
      });
    }
  }
  return out;
}

/* ─────────────────── InvestorFlowProvider 구현 ─────────────────── */

export const kisProvider: InvestorFlowProvider = {
  id: 'kis',
  label: `한국투자증권 Open API (${kisIsPaper() ? '모의' : '실전'}) · 투자자 12구분`,
  covers: KIS_COVERS,
  async available() {
    return kisConfigured();
  },
  async fetchDaily(symbols, from, to) {
    const out: FlowRow[] = [];
    for (const symbol of symbols) {
      try {
        const rows = await fetchInvestorFlow(symbol, to);
        for (const r of rows) if (r.date >= from && r.date <= to) out.push(r);
      } catch {
        // 개별 종목 실패는 건너뛴다. 배치 로그에 총 건수로 남는다.
      }
    }
    return out;
  },
};

/* ──────────────────────────── 분봉 ──────────────────────────── */

export interface MinuteBar {
  symbol: string;
  ts: string; // ISO
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  tradedValue: number;
}

/** KST 'YYYY-MM-DD' + 'HHMMSS' → ISO 문자열(+09:00) */
function kstIso(dateIso: string, hhmmss: string): string {
  const hh = hhmmss.slice(0, 2);
  const mm = hhmmss.slice(2, 4);
  const ss = hhmmss.slice(4, 6) || '00';
  return `${dateIso}T${hh}:${mm}:${ss}+09:00`;
}

/**
 * 분봉. KIS 는 한 번에 30건만 주고 "이 시각 이전"으로 거슬러 올라간다.
 * 커서를 옮겨가며 하루치를 모은다(09:00~15:30 → 약 14회).
 */
export async function fetchMinuteBars(symbol: string, dateIso: string, maxCalls = 14): Promise<MinuteBar[]> {
  const seen = new Map<string, MinuteBar>();
  let cursor = '153000';

  for (let i = 0; i < maxCalls; i++) {
    const j = await call<{ output2?: Record<string, string>[] }>(
      '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
      'FHKST03010200',
      {
        FID_ETC_CLS_CODE: '',
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: symbol,
        FID_INPUT_HOUR_1: cursor,
        FID_PW_DATA_INCU_YN: 'Y',
      },
    );
    if (j.rt_cd !== '0') break;
    const rows = j.output2 ?? [];
    if (rows.length === 0) break;

    let oldest = cursor;
    for (const r of rows) {
      const d = r.stck_bsop_date ? expand(r.stck_bsop_date) : dateIso;
      const t = r.stck_cntg_hour;
      if (!t) continue;
      const ts = kstIso(d, t);
      if (!seen.has(ts)) {
        seen.set(ts, {
          symbol,
          ts,
          o: parseNum(r.stck_oprc) ?? 0,
          h: parseNum(r.stck_hgpr) ?? 0,
          l: parseNum(r.stck_lwpr) ?? 0,
          c: parseNum(r.stck_prpr) ?? 0,
          volume: parseNum(r.cntg_vol) ?? 0,
          tradedValue: parseNum(r.acml_tr_pbmn) ?? 0,
        });
      }
      if (t < oldest) oldest = t;
    }
    if (oldest === cursor) break;
    const asMin = Number(oldest.slice(0, 2)) * 60 + Number(oldest.slice(2, 4)) - 1;
    if (asMin < 9 * 60) break;
    cursor = `${String(Math.floor(asMin / 60)).padStart(2, '0')}${String(asMin % 60).padStart(2, '0')}00`;
  }
  return [...seen.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

/* ────────────────────── 프로그램매매 ────────────────────── */

export interface ProgramMinute {
  symbol: string;
  ts: string;
  sellQty: number;
  buyQty: number;
  netQty: number;
  sellAmt: number;
  buyAmt: number;
  netAmt: number;
}

/** 종목별 프로그램매매추이(체결) — 장중 시간대별 */
export async function fetchProgramMinute(symbol: string, dateIso: string): Promise<ProgramMinute[]> {
  const j = await call<{ output?: Record<string, string>[] }>(
    '/uapi/domestic-stock/v1/quotations/program-trade-by-stock',
    'FHPPG04650101',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol },
  );
  if (j.rt_cd !== '0') return [];

  // 프로그램매매는 초 단위로 내려와 분봉(분 단위)과 조인이 어긋난다. 분으로 절삭한다.
  // 절삭하면 같은 분에 여러 건이 겹치므로 분당 1건만 남긴다.
  // 응답은 최신순이라 먼저 나온 것이 그 분의 최종 누계다.
  const byMinute = new Map<string, ProgramMinute>();
  for (const r of j.output ?? []) {
    const t = r.stck_cntg_hour ?? r.bsop_hour;
    if (!t || t.length < 4) continue;
    const ts = kstIso(dateIso, `${t.slice(0, 4)}00`);
    if (byMinute.has(ts)) continue;
    byMinute.set(ts, {
      symbol,
      ts,
      sellQty: parseNum(r.whol_smtn_seln_vol) ?? 0,
      buyQty: parseNum(r.whol_smtn_shnu_vol) ?? 0,
      netQty: parseNum(r.whol_smtn_ntby_qty) ?? 0,
      sellAmt: parseNum(r.whol_smtn_seln_tr_pbmn) ?? 0,
      buyAmt: parseNum(r.whol_smtn_shnu_tr_pbmn) ?? 0,
      netAmt: parseNum(r.whol_smtn_ntby_tr_pbmn) ?? 0,
    });
  }
  return [...byMinute.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface ProgramDaily extends Omit<ProgramMinute, 'ts'> {
  date: string;
}

/** 종목별 프로그램매매(일별) — 30영업일 */
export async function fetchProgramDaily(symbol: string, endDateIso: string): Promise<ProgramDaily[]> {
  const j = await call<{ output?: Record<string, string>[] }>(
    '/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily',
    'FHPPG04650201',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol, FID_INPUT_DATE_1: compact(endDateIso) },
  );
  if (j.rt_cd !== '0') return [];
  const out: ProgramDaily[] = [];
  for (const r of j.output ?? []) {
    if (!r.stck_bsop_date) continue;
    out.push({
      symbol,
      date: expand(r.stck_bsop_date),
      sellQty: parseNum(r.whol_smtn_seln_vol) ?? 0,
      buyQty: parseNum(r.whol_smtn_shnu_vol) ?? 0,
      netQty: parseNum(r.whol_smtn_ntby_qty) ?? 0,
      sellAmt: parseNum(r.whol_smtn_seln_tr_pbmn) ?? 0,
      buyAmt: parseNum(r.whol_smtn_shnu_tr_pbmn) ?? 0,
      netAmt: parseNum(r.whol_smtn_ntby_tr_pbmn) ?? 0,
    });
  }
  return out;
}

/* ────────────────────── 거래원(회원사) ────────────────────── */

/** 특정 회원사의 종목별 일별 순매수 */
export async function fetchMemberDaily(
  symbol: string,
  memberCode: string,
  fromIso: string,
  toIso: string,
): Promise<Array<{ date: string; buyQty: number; sellQty: number; netQty: number }>> {
  const j = await call<{ output?: Record<string, string>[] }>(
    '/uapi/domestic-stock/v1/quotations/inquire-member-daily',
    'FHPST04540000',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: symbol,
      FID_INPUT_ISCD_2: memberCode,
      FID_INPUT_DATE_1: compact(fromIso),
      FID_INPUT_DATE_2: compact(toIso),
      FID_SCTN_CLS_CODE: '',
    },
  );
  if (j.rt_cd !== '0') return [];
  return (j.output ?? [])
    .filter((r) => r.stck_bsop_date)
    .map((r) => ({
      date: expand(r.stck_bsop_date),
      buyQty: parseNum(r.total_shnu_qty) ?? 0,
      sellQty: parseNum(r.total_seln_qty) ?? 0,
      netQty: parseNum(r.ntby_qty) ?? 0,
    }));
}

/* ──────────────────────────── 저장 ──────────────────────────── */

export async function saveMinuteBars(bars: MinuteBar[]): Promise<number> {
  if (!bars.length) return 0;
  return bulkInsert(
    'ohlcv_minute',
    ['symbol', 'ts', 'o', 'h', 'l', 'c', 'volume', 'traded_value'],
    bars.map((b) => [b.symbol, b.ts, b.o, b.h, b.l, b.c, b.volume, b.tradedValue]),
    `on conflict (symbol, ts) do update set
       o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
       volume = excluded.volume, traded_value = excluded.traded_value`,
  );
}

export async function saveProgramMinute(rows: ProgramMinute[]): Promise<number> {
  if (!rows.length) return 0;
  return bulkInsert(
    'program_trade_minute',
    ['symbol', 'ts', 'sell_qty', 'buy_qty', 'net_qty', 'sell_amt', 'buy_amt', 'net_amt'],
    rows.map((r) => [r.symbol, r.ts, r.sellQty, r.buyQty, r.netQty, r.sellAmt, r.buyAmt, r.netAmt]),
    `on conflict (symbol, ts) do update set
       sell_qty = excluded.sell_qty, buy_qty = excluded.buy_qty, net_qty = excluded.net_qty,
       sell_amt = excluded.sell_amt, buy_amt = excluded.buy_amt, net_amt = excluded.net_amt`,
  );
}

export async function saveProgramDaily(rows: ProgramDaily[]): Promise<number> {
  if (!rows.length) return 0;
  return bulkInsert(
    'program_trade_daily',
    ['symbol', 'date', 'sell_qty', 'buy_qty', 'net_qty', 'sell_amt', 'buy_amt', 'net_amt'],
    rows.map((r) => [r.symbol, r.date, r.sellQty, r.buyQty, r.netQty, r.sellAmt, r.buyAmt, r.netAmt]),
    `on conflict (symbol, date) do update set
       sell_qty = excluded.sell_qty, buy_qty = excluded.buy_qty, net_qty = excluded.net_qty,
       sell_amt = excluded.sell_amt, buy_amt = excluded.buy_amt, net_amt = excluded.net_amt`,
  );
}

export const kisInfo = () => ({
  configured: kisConfigured(),
  paper: kisIsPaper(),
  domain: DOMAIN,
  ratePerSec: RATE_PER_SEC,
});
