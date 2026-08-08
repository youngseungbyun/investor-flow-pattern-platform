/**
 * DATA.go.kr 금융위원회 주식시세정보 수집기.
 *
 * 응답 필드는 아래가 전부다(투자자 구분 없음):
 *   basDt, srtnCd, isinCd, itmsNm, mrktCtg, clpr, vs, fltRt, mkp, hipr, lopr,
 *   trqu, trPrc, lstgStCnt, mrktTotAmt
 * 정확일치 srtnCd 파라미터는 없다. 단일 종목 조회는 likeSrtnCd 로 받은 뒤
 * 서버에서 정확히 필터링해야 엉뚱한 종목이 섞이지 않는다.
 */
import { bulkInsert, compact, env, exec, fetchJson, int, isWeekend, parseNum, todayKst } from '../lib/core';

const BASE =
  'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

interface RawItem {
  basDt: string;
  srtnCd: string;
  isinCd: string;
  itmsNm: string;
  mrktCtg: string;
  clpr: string;
  vs: string;
  fltRt: string;
  mkp: string;
  hipr: string;
  lopr: string;
  trqu: string;
  trPrc: string;
  lstgStCnt: string;
  mrktTotAmt: string;
}

interface ApiResponse {
  response?: {
    header?: { resultCode?: string; resultMsg?: string };
    body?: {
      totalCount?: number;
      numOfRows?: number;
      pageNo?: number;
      items?: { item?: RawItem[] | RawItem };
    };
  };
}

export interface DailyQuote {
  symbol: string;
  isin: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ' | 'KONEX' | 'OTHER';
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  volume: number;
  tradedValue: number;
  listedShares: number | null;
  marketCap: number | null;
}

function normMarket(v: string): DailyQuote['market'] {
  const s = (v ?? '').toUpperCase();
  if (s.includes('KOSPI')) return 'KOSPI';
  if (s.includes('KOSDAQ')) return 'KOSDAQ';
  if (s.includes('KONEX')) return 'KONEX';
  return 'OTHER';
}

function asArray(item: RawItem[] | RawItem | undefined): RawItem[] {
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

/** 하루치 전 종목 시세. 휴장일이면 빈 배열. */
export async function fetchDay(dateIso: string): Promise<DailyQuote[]> {
  const out: DailyQuote[] = [];
  const numOfRows = 4000;
  for (let page = 1; page <= 10; page++) {
    const url = new URL(BASE);
    url.searchParams.set('serviceKey', env.dataGoKrKey);
    url.searchParams.set('resultType', 'json');
    url.searchParams.set('numOfRows', String(numOfRows));
    url.searchParams.set('pageNo', String(page));
    url.searchParams.set('basDt', compact(dateIso));

    const json = await fetchJson<ApiResponse>(url.toString());
    const code = json.response?.header?.resultCode;
    if (code && code !== '00') {
      throw new Error(`DATA.go.kr 오류 ${code}: ${json.response?.header?.resultMsg ?? ''}`);
    }
    const body = json.response?.body;
    const items = asArray(body?.items?.item);
    for (const it of items) {
      if (!it.srtnCd) continue;
      out.push({
        symbol: it.srtnCd,
        isin: it.isinCd,
        name: it.itmsNm,
        market: normMarket(it.mrktCtg),
        o: parseNum(it.mkp),
        h: parseNum(it.hipr),
        l: parseNum(it.lopr),
        c: parseNum(it.clpr),
        volume: int(it.trqu),
        tradedValue: int(it.trPrc),
        listedShares: parseNum(it.lstgStCnt),
        marketCap: parseNum(it.mrktTotAmt),
      });
    }
    const total = body?.totalCount ?? 0;
    if (out.length >= total || items.length === 0) break;
  }
  return out;
}

export interface IngestResult {
  date: string;
  /** true=개장 확정, false=휴장 확정, null=아직 판단 불가(공시 지연) */
  isOpen: boolean | null;
  instruments: number;
  quotes: number;
}

/**
 * DATA.go.kr 은 당일 시세를 대개 다음 영업일 오전에 올린다.
 * 그래서 "응답이 비었다"를 곧바로 휴장으로 단정하면 거래일 캘린더가 오염된다.
 * 최근 며칠은 판단을 보류하고, 확실히 지난 날짜만 휴장으로 확정한다.
 */
const PENDING_DAYS = Number(process.env.OHLCV_PENDING_DAYS ?? 3);

/** 하루치를 DB 에 멱등 반영한다. 같은 날짜로 두 번 돌려도 행이 늘지 않는다. */
export async function ingestDay(dateIso: string): Promise<IngestResult> {
  const quotes = await fetchDay(dateIso);

  if (quotes.length === 0) {
    const ageDays = Math.round(
      (Date.parse(`${todayKst()}T00:00:00Z`) - Date.parse(`${dateIso}T00:00:00Z`)) / 86_400_000,
    );
    const decided = isWeekend(dateIso) || ageDays > PENDING_DAYS;

    if (decided) {
      await exec(
        `insert into trading_days (date, is_open, source) values ($1, false, 'datagokr')
         on conflict (date) do update set is_open = excluded.is_open`,
        [dateIso],
      );
      return { date: dateIso, isOpen: false, instruments: 0, quotes: 0 };
    }
    // 공시 지연일 수 있다. 캘린더를 건드리지 않고 보류한다.
    return { date: dateIso, isOpen: null, instruments: 0, quotes: 0 };
  }

  // 종목 마스터. free_float_* 는 여기서 덮어쓰지 않는다(별도 단계가 계산).
  const instrumentRows = quotes.map((q) => [
    q.symbol,
    q.isin,
    q.name,
    q.market,
    q.listedShares,
    dateIso,
  ]);
  const instruments = await bulkInsert(
    'instruments',
    ['symbol', 'isin', 'name', 'market', 'listed_shares', 'last_seen_date'],
    instrumentRows,
    `on conflict (symbol) do update set
       isin = excluded.isin,
       name = excluded.name,
       market = excluded.market,
       listed_shares = excluded.listed_shares,
       last_seen_date = greatest(instruments.last_seen_date, excluded.last_seen_date),
       updated_at = now()`,
  );

  // 아직 유통주식수를 실제로 계산하지 못한 종목만 상장주식수로 임시 대체한다.
  // basis 가 'listed_shares' 로 남으므로 UI 에서 배지를 띄울 수 있다.
  await exec(
    `update instruments
        set free_float_shares = listed_shares
      where free_float_basis = 'listed_shares'
        and listed_shares is not null
        and free_float_shares is distinct from listed_shares`,
  );

  const quoteRows = quotes.map((q) => [
    q.symbol,
    dateIso,
    q.o,
    q.h,
    q.l,
    q.c,
    q.volume,
    q.tradedValue,
    q.marketCap,
    q.listedShares,
  ]);
  const inserted = await bulkInsert(
    'ohlcv_daily',
    ['symbol', 'date', 'o', 'h', 'l', 'c', 'volume', 'traded_value', 'market_cap', 'listed_shares'],
    quoteRows,
    `on conflict (symbol, date) do update set
       o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
       volume = excluded.volume, traded_value = excluded.traded_value,
       market_cap = excluded.market_cap, listed_shares = excluded.listed_shares`,
  );

  await exec(
    `insert into trading_days (date, is_open, source) values ($1, true, 'datagokr')
     on conflict (date) do update set is_open = excluded.is_open`,
    [dateIso],
  );

  return { date: dateIso, isOpen: true, instruments, quotes: inserted };
}
