/**
 * 투자자별 수급 provider.
 *
 * ── 라이선스 가드레일 ────────────────────────────────────────────────────────
 * 수급 데이터 접근은 InvestorFlowProvider 인터페이스 하나로만 이뤄진다.
 * 구현체 교체는 환경변수 INVESTOR_FLOW_PROVIDER 한 줄로 끝난다.
 * 원본은 재배포하지 않고 서비스는 파생 지표(비율·순위)만 노출한다.
 * 외부 요청은 core.fetchText 가 호스트별 최소 간격 + 지수 백오프를 강제한다.
 *
 * ── 2026-08 현재 소스 상태 ──────────────────────────────────────────────────
 * data.krx.co.kr(KRX Data Marketplace)는 통계 화면이 로그인 필수로 바뀌었다.
 * 비로그인 POST 는 getJsonData.cmd 에서 400 "LOGOUT" 을 돌려준다.
 * 따라서 사모 세분이 필요하면 KRX 계정을 넣거나(krx-marketplace) CSV 를
 * 내려받아 넣어야 한다(krx-csv). naver 는 사모를 제공하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import { bulkInsert, env, expand, fetchText, int, parseNum } from '../lib/core';
import { kisProvider } from './kis';

export type InvestorType =
  | 'individual'
  | 'foreign'
  | 'other_foreign'
  | 'institution_total'
  | 'financial_investment'
  | 'insurance'
  | 'investment_trust'
  | 'private_fund'
  | 'bank'
  | 'other_finance'
  | 'pension'
  | 'other_corp';

export const INVESTOR_LABEL: Record<InvestorType, string> = {
  individual: '개인',
  foreign: '외국인',
  other_foreign: '기타외국인',
  institution_total: '기관합계',
  financial_investment: '금융투자',
  insurance: '보험',
  investment_trust: '투신',
  private_fund: '사모',
  bank: '은행',
  other_finance: '기타금융',
  pension: '연기금',
  other_corp: '기타법인',
};

const KO_TO_TYPE: Array<[RegExp, InvestorType]> = [
  [/기타외국인/, 'other_foreign'],
  [/기타법인/, 'other_corp'],
  [/기타금융/, 'other_finance'],
  [/외국인/, 'foreign'],
  [/개인/, 'individual'],
  [/금융투자/, 'financial_investment'],
  [/보험/, 'insurance'],
  [/투신/, 'investment_trust'],
  [/사모/, 'private_fund'],
  [/은행/, 'bank'],
  [/연기금/, 'pension'],
  [/기관/, 'institution_total'],
];

export function investorTypeFromKorean(s: string): InvestorType | null {
  for (const [re, t] of KO_TO_TYPE) if (re.test(s)) return t;
  return null;
}

export interface FlowRow {
  symbol: string;
  date: string;
  investorType: InvestorType;
  netBuyQty: number;
  netBuyAmount: number | null;
}

export interface PeriodFlowRow {
  symbol: string;
  startDate: string;
  endDate: string;
  investorType: InvestorType;
  netBuyQty: number;
  netBuyAmount: number | null;
}

export interface InvestorFlowProvider {
  readonly id: string;
  readonly label: string;
  /** 이 provider 가 공급할 수 있는 투자자 구분 */
  readonly covers: InvestorType[];
  /** 설정이 갖춰져 실제로 쓸 수 있는지 */
  available(): Promise<boolean>;
  /** 일별 데이터. from~to 사이 전부를 돌려준다. 미지원이면 undefined. */
  fetchDaily?(symbols: string[], from: string, to: string): Promise<FlowRow[]>;
  /** 기간합계 데이터(CSV 등). 미지원이면 undefined. */
  fetchPeriods?(): Promise<PeriodFlowRow[]>;
}

/* ───────────────────────────── naver ───────────────────────────── */

interface NaverTrendRow {
  itemCode: string;
  bizdate: string;
  foreignerPureBuyQuant: string;
  organPureBuyQuant: string;
  individualPureBuyQuant: string;
  closePrice: string;
}

/**
 * 네이버 증권 모바일 API. 무료·무로그인·전종목.
 * 한 번 요청하면 최근 약 20영업일이 한꺼번에 온다 — 종목당 1회로 관찰기간을 덮는다.
 * 제공 구분은 개인·외국인·기관합계 셋뿐이다. 사모 세분은 없다.
 */
export const naverProvider: InvestorFlowProvider = {
  id: 'naver',
  label: '네이버 증권 (개인·외국인·기관합계)',
  covers: ['individual', 'foreign', 'institution_total'],
  async available() {
    return true;
  },
  async fetchDaily(symbols, from, to) {
    const out: FlowRow[] = [];
    for (const symbol of symbols) {
      const url = `https://m.stock.naver.com/api/stock/${symbol}/trend?pageSize=30&page=1`;
      let rows: NaverTrendRow[];
      try {
        const text = await fetchText(url, {
          intervalMs: 300,
          retries: 2,
          headers: { Referer: 'https://m.stock.naver.com/' },
        });
        rows = JSON.parse(text) as NaverTrendRow[];
      } catch {
        continue; // 개별 종목 실패는 건너뛴다. 배치 로그에 건수로 남는다.
      }
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        if (!r.bizdate) continue;
        const date = expand(r.bizdate);
        if (date < from || date > to) continue;
        out.push(
          { symbol, date, investorType: 'individual', netBuyQty: int(r.individualPureBuyQuant), netBuyAmount: null },
          { symbol, date, investorType: 'foreign', netBuyQty: int(r.foreignerPureBuyQuant), netBuyAmount: null },
          { symbol, date, investorType: 'institution_total', netBuyQty: int(r.organPureBuyQuant), netBuyAmount: null },
        );
      }
    }
    return out;
  },
};

/* ──────────────────────────── krx-csv ──────────────────────────── */

/**
 * KRX Data Marketplace 에서 사람이 내려받은 CSV 를 읽는다.
 * 로그인 월을 우회하지 않으면서 사모 세분을 넣을 수 있는 경로다.
 *
 * 파일명에서 기간과 투자자 구분을 읽는다. 아래 형식을 모두 인식한다.
 *   26.07.27~26.07.29_사모펀드 순매수 상위 종목.csv
 *   20260727-20260729_private_fund.csv
 *   20260805_사모.csv
 * 컬럼(헤더 한글, CP949 또는 UTF-8):
 *   종목코드, 종목명, 거래량_매도, 거래량_매수, 거래량_순매수,
 *   거래대금_매도, 거래대금_매수, 거래대금_순매수
 */
function parseFileMeta(filename: string): { start: string; end: string; type: InvestorType } | null {
  const base = path.basename(filename).replace(/\.csv$/i, '');

  const yy = String.raw`\d{2}\.\d{2}\.\d{2}`;
  const ymd8 = String.raw`\d{8}`;
  let start: string | null = null;
  let end: string | null = null;

  const twoShort = new RegExp(`(${yy})\\s*[~\\-]\\s*(${yy})`).exec(base);
  const twoLong = new RegExp(`(${ymd8})\\s*[~\\-]\\s*(${ymd8})`).exec(base);
  const oneLong = new RegExp(`(?:^|[^0-9])(${ymd8})(?:[^0-9]|$)`).exec(base);
  const oneShort = new RegExp(`(?:^|[^0-9.])(${yy})(?:[^0-9.]|$)`).exec(base);

  const fromShort = (s: string) => `20${s.replace(/\./g, '-')}`;
  const fromLong = (s: string) => expand(s);

  if (twoShort) {
    start = fromShort(twoShort[1]);
    end = fromShort(twoShort[2]);
  } else if (twoLong) {
    start = fromLong(twoLong[1]);
    end = fromLong(twoLong[2]);
  } else if (oneLong) {
    start = end = fromLong(oneLong[1]);
  } else if (oneShort) {
    start = end = fromShort(oneShort[1]);
  }
  if (!start || !end) return null;

  const type =
    investorTypeFromKorean(base) ??
    (Object.keys(INVESTOR_LABEL) as InvestorType[]).find((t) => base.includes(t)) ??
    null;
  if (!type) return null;

  return { start, end, type };
}

function decodeCsv(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  // CP949 파일을 utf8 로 읽으면 치환문자가 대량 발생한다. 그때만 cp949 로 다시 읽는다.
  const bad = (utf8.match(/�/g) ?? []).length;
  return bad > 3 ? iconv.decode(buf, 'cp949') : utf8;
}

function pick(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const hit = Object.keys(row).find((k) => k.replace(/[\s"]/g, '') === n);
    if (hit) return row[hit];
  }
  return undefined;
}

export const krxCsvProvider: InvestorFlowProvider = {
  id: 'krx-csv',
  label: 'KRX Data Marketplace CSV (수동 내려받기)',
  covers: Object.keys(INVESTOR_LABEL) as InvestorType[],
  async available() {
    const dir = path.resolve(process.cwd(), env.krxCsvDir);
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.csv'));
  },
  async fetchPeriods() {
    const dir = path.resolve(process.cwd(), env.krxCsvDir);
    if (!fs.existsSync(dir)) return [];
    const out: PeriodFlowRow[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'))) {
      const meta = parseFileMeta(file);
      if (!meta) {
        console.warn(`  [krx-csv] 파일명에서 기간/투자자 구분을 못 읽어 건너뜀: ${file}`);
        continue;
      }
      const text = decodeCsv(fs.readFileSync(path.join(dir, file)));
      const records = parseCsv(text, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true,
        relax_column_count: true,
      }) as Record<string, string>[];
      for (const r of records) {
        const code = pick(r, '종목코드', 'symbol', '단축코드');
        if (!code) continue;
        const symbol = code.replace(/[^0-9A-Za-z]/g, '').padStart(6, '0');
        const qty = parseNum(pick(r, '거래량_순매수', '순매수거래량', '순매수량'));
        if (qty === null) continue;
        out.push({
          symbol,
          startDate: meta.start,
          endDate: meta.end,
          investorType: meta.type,
          netBuyQty: qty,
          netBuyAmount: parseNum(pick(r, '거래대금_순매수', '순매수거래대금')),
        });
      }
    }
    return out;
  },
};

/* ────────────────────── krx-marketplace (계정 필요) ────────────────────── */

const KRX_BASE = 'https://data.krx.co.kr';

/**
 * KRX Data Marketplace 자동 수집.
 *
 * 주의 — 2026-08 확인 사항:
 *   비로그인 상태에서 /comm/bldAttendant/getJsonData.cmd 는 400 "LOGOUT" 을 반환한다.
 *   통계 화면이 회원 전용으로 바뀌었기 때문이다. 따라서 본인 계정이 반드시 필요하다.
 *   KRX_MARKETPLACE_ID / KRX_MARKETPLACE_PW 가 비어 있으면 이 provider 는 비활성이다.
 *   상용 배포 전에는 KRX Data Marketplace 이용 계약이 필요하다(README 참조).
 */
export const krxMarketplaceProvider: InvestorFlowProvider = {
  id: 'krx-marketplace',
  label: 'KRX Data Marketplace (자동 로그인)',
  covers: Object.keys(INVESTOR_LABEL) as InvestorType[],
  async available() {
    return Boolean(env.krxMarketplaceId && env.krxMarketplacePw);
  },
  async fetchDaily(symbols, from, to) {
    if (!(await krxMarketplaceProvider.available())) {
      throw new Error(
        'krx-marketplace provider 는 KRX_MARKETPLACE_ID / KRX_MARKETPLACE_PW 가 있어야 동작합니다. ' +
          'data.krx.co.kr 은 통계 화면이 로그인 필수입니다.',
      );
    }
    const jar = new Map<string, string>();
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (res: Response) => {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    };

    // 1) 세션 발급 → 2) 로그인 → 3) 통계 조회
    absorb(await fetch(`${KRX_BASE}/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020101`));
    const loginRes = await fetch(`${KRX_BASE}/contents/MDC/COMS/client/MDCCOMS001.cmd`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: `${KRX_BASE}/contents/MDC/COMS/client/MDCCOMS001.cmd`,
        Cookie: cookie(),
      },
      body: new URLSearchParams({
        userId: env.krxMarketplaceId,
        userPw: env.krxMarketplacePw,
      }).toString(),
      redirect: 'manual',
    });
    absorb(loginRes);

    const out: FlowRow[] = [];
    for (const symbol of symbols) {
      const isin = await krxIsin(symbol, cookie());
      if (!isin) continue;
      const body = new URLSearchParams({
        bld: 'dbms/MDC/STAT/standard/MDCSTAT02303',
        inqTpCd: '2',
        trdVolVal: '1',
        askBid: '3',
        isuCd: isin,
        strtDd: from.replace(/-/g, ''),
        endDd: to.replace(/-/g, ''),
        detailView: '1',
        money: '1',
        csvxls_isNo: 'false',
      }).toString();
      const text = await fetchText(`${KRX_BASE}/comm/bldAttendant/getJsonData.cmd`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `${KRX_BASE}/contents/MDC/MDI/mdiLoader/index.cmd`,
          Cookie: cookie(),
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
      });
      if (text.trim() === 'LOGOUT') {
        throw new Error('KRX 로그인이 유효하지 않습니다. 계정 정보를 확인하세요.');
      }
      const json = JSON.parse(text) as { output?: Record<string, string>[] };
      for (const r of json.output ?? []) {
        const date = r.TRD_DD?.replace(/\//g, '-');
        if (!date) continue;
        const map: Array<[InvestorType, string]> = [
          ['financial_investment', 'TRDVAL1'],
          ['insurance', 'TRDVAL2'],
          ['investment_trust', 'TRDVAL3'],
          ['private_fund', 'TRDVAL4'],
          ['bank', 'TRDVAL5'],
          ['other_finance', 'TRDVAL6'],
          ['pension', 'TRDVAL7'],
          ['institution_total', 'TRDVAL8'],
          ['other_corp', 'TRDVAL9'],
          ['individual', 'TRDVAL10'],
          ['foreign', 'TRDVAL11'],
          ['other_foreign', 'TRDVAL12'],
        ];
        for (const [type, key] of map) {
          const qty = parseNum(r[key]);
          if (qty === null) continue;
          out.push({ symbol, date, investorType: type, netBuyQty: qty, netBuyAmount: null });
        }
      }
    }
    return out;
  },
};

const isinCache = new Map<string, string>();
async function krxIsin(symbol: string, cookie: string): Promise<string | null> {
  if (isinCache.has(symbol)) return isinCache.get(symbol) ?? null;
  const text = await fetchText(`${KRX_BASE}/comm/bldAttendant/getJsonData.cmd`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: `${KRX_BASE}/contents/MDC/MDI/mdiLoader/index.cmd`,
      Cookie: cookie,
    },
    body: new URLSearchParams({
      bld: 'dbms/comm/finder/finder_stkisu',
      mktsel: 'ALL',
      typeNo: '0',
      searchText: symbol,
    }).toString(),
  });
  const json = JSON.parse(text) as { block1?: Array<{ full_code: string; short_code: string }> };
  const hit = json.block1?.find((b) => b.short_code === symbol);
  if (!hit) return null;
  isinCache.set(symbol, hit.full_code);
  return hit.full_code;
}

/* ──────────────────────── licensed (정식 계약) ──────────────────────── */

export const licensedProvider: InvestorFlowProvider = {
  id: 'licensed',
  label: '정식 계약 API',
  covers: Object.keys(INVESTOR_LABEL) as InvestorType[],
  async available() {
    return Boolean(env.licensedApiBase && env.licensedApiKey);
  },
  async fetchDaily(symbols, from, to) {
    const url = new URL('/investor-flow/daily', env.licensedApiBase);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('symbols', symbols.join(','));
    const text = await fetchText(url.toString(), {
      headers: { Authorization: `Bearer ${env.licensedApiKey}` },
    });
    return JSON.parse(text) as FlowRow[];
  },
};

/* ──────────────────────────── registry ──────────────────────────── */

const ALL: Record<string, InvestorFlowProvider> = {
  // 사모 포함 12구분을 API 로 자동 수집한다. KRX CSV 수동 경로를 대체한다.
  kis: kisProvider,
  naver: naverProvider,
  'krx-csv': krxCsvProvider,
  'krx-marketplace': krxMarketplaceProvider,
  licensed: licensedProvider,
};

/** INVESTOR_FLOW_PROVIDER 순서대로, 실제로 쓸 수 있는 provider 만 돌려준다. */
export async function activeProviders(): Promise<InvestorFlowProvider[]> {
  const out: InvestorFlowProvider[] = [];
  for (const id of env.investorFlowProviders) {
    const p = ALL[id];
    if (!p) {
      console.warn(`  [flow] 알 수 없는 provider: ${id}`);
      continue;
    }
    if (await p.available()) out.push(p);
    else console.warn(`  [flow] provider 비활성(설정 부족): ${id}`);
  }
  return out;
}

/** 현재 설정으로 실제 공급 가능한 투자자 구분의 합집합. */
export async function coveredInvestorTypes(): Promise<InvestorType[]> {
  const set = new Set<InvestorType>();
  for (const p of await activeProviders()) p.covers.forEach((t) => set.add(t));
  return [...set];
}

/* ──────────────────────────── persistence ──────────────────────────── */

export async function saveDaily(rows: FlowRow[], source: string): Promise<number> {
  if (!rows.length) return 0;
  return bulkInsert(
    'investor_flow_daily',
    ['symbol', 'date', 'investor_type', 'net_buy_qty', 'net_buy_amount', 'source'],
    rows.map((r) => [r.symbol, r.date, r.investorType, r.netBuyQty, r.netBuyAmount, source]),
    `on conflict (symbol, date, investor_type) do update set
       net_buy_qty = excluded.net_buy_qty,
       net_buy_amount = excluded.net_buy_amount,
       source = excluded.source,
       updated_at = now()`,
  );
}

export async function savePeriods(rows: PeriodFlowRow[], source: string): Promise<number> {
  if (!rows.length) return 0;
  return bulkInsert(
    'investor_flow_period',
    ['symbol', 'start_date', 'end_date', 'investor_type', 'net_buy_qty', 'net_buy_amount', 'source'],
    rows.map((r) => [r.symbol, r.startDate, r.endDate, r.investorType, r.netBuyQty, r.netBuyAmount, source]),
    `on conflict (symbol, start_date, end_date, investor_type) do update set
       net_buy_qty = excluded.net_buy_qty,
       net_buy_amount = excluded.net_buy_amount,
       source = excluded.source,
       updated_at = now()`,
  );
}
