/**
 * 핵심 스크리너 — "개인 매도 · 사모 매수".
 *
 *   조건 A: 개인 순매수량  < 0     (관찰기간 N일 누적)
 *   조건 B: 사모 순매수량  > 0     (동일 기간 누적)
 *   정렬키: 사모 순매수량 ÷ 유통주식수  (내림차순)
 *
 * 유통주식수 = 상장주식수 − 최대주주등 소유주식수 − 자기주식.
 * 세 값을 다 못 구한 종목은 상장주식수로 대체하되 floatBasis 를 'listed_shares' 로
 * 내려보내 UI 가 "상장주식수 기준" 배지를 반드시 띄우게 한다.
 */
import { query } from '../lib/core';
import { INVESTOR_LABEL, type InvestorType } from '../providers/investor-flow';

export type MarketFilter = 'ALL' | 'KOSPI' | 'KOSDAQ';

export interface ScreenerParams {
  /** 관찰기간의 마지막 거래일 */
  date: string;
  /** 관찰기간 N (거래일 수). 기본 5 */
  n: number;
  market: MarketFilter;
  /** 최소 거래대금(원) */
  minTradedValue: number;
  /** 조건 B 에 쓸 투자자 구분. 기본 private_fund */
  buyerType: InvestorType;
  limit: number;
}

export interface ScreenerRow {
  symbol: string;
  name: string;
  market: string;
  individualNetQty: number;
  buyerNetQty: number;
  buyerType: InvestorType;
  buyerLabel: string;
  floatShares: number | null;
  floatBasis: 'computed' | 'listed_shares';
  /** 사모 순매수 ÷ 유통주식수 (%) */
  ratioPct: number | null;
  close: number | null;
  changePct: number | null;
  tradedValue: number | null;
  insiderBuys: number;
  insiderLatestRcept: string | null;
  patterns: Array<{ pattern: string; score: number; confirmed: boolean }>;
}

export interface ScreenerResult {
  params: ScreenerParams;
  /** 실제로 집계에 쓴 거래일 목록(최신순) */
  windowDates: string[];
  /** 조건 B 데이터의 출처 provider */
  buyerSources: string[];
  /** 조건 A 데이터의 출처 provider */
  individualSources: string[];
  /** 기간합계(CSV) 를 썼는지 */
  mode: 'daily' | 'period';
  rows: ScreenerRow[];
  notes: string[];
}

const SELECT_ENRICH = `
  i.name,
  i.market,
  i.free_float_shares                             as float_shares,
  i.free_float_basis                              as float_basis,
  o.c                                             as close,
  o.traded_value                                  as traded_value,
  case when prev.c is not null and prev.c <> 0
       then round((o.c - prev.c) / prev.c * 100, 2)
       else null end                              as change_pct
`;

/** 관찰기간(개장일 N일, 최신순). */
export async function windowDates(date: string, n: number): Promise<string[]> {
  const rows = await query<{ d: string }>(
    `select to_char(date, 'YYYY-MM-DD') d
       from trading_days
      where is_open and date <= $1
      order by date desc
      limit $2`,
    [date, n],
  );
  return rows.map((r) => r.d);
}

/** 일별 수급(investor_flow_daily) 기반 — 기본 경로. */
export async function runScreener(params: ScreenerParams): Promise<ScreenerResult> {
  const dates = await windowDates(params.date, params.n);
  const notes: string[] = [];
  if (dates.length === 0) {
    return {
      params,
      windowDates: [],
      buyerSources: [],
      individualSources: [],
      mode: 'daily',
      rows: [],
      notes: ['거래일 캘린더에 해당 기간이 없습니다. 먼저 일봉 배치를 돌리세요.'],
    };
  }
  if (dates.length < params.n) {
    notes.push(`요청한 ${params.n}거래일 중 ${dates.length}일만 DB에 있어 그 기간으로 집계했습니다.`);
  }

  const raw = await query<Record<string, string | null>>(
    `
    with win as (select unnest($1::date[]) as date),
    ind as (
      select f.symbol, sum(f.net_buy_qty) qty, array_agg(distinct f.source) srcs
        from investor_flow_daily f join win w on w.date = f.date
       where f.investor_type = 'individual'
       group by f.symbol
    ),
    buy as (
      select f.symbol, sum(f.net_buy_qty) qty, array_agg(distinct f.source) srcs
        from investor_flow_daily f join win w on w.date = f.date
       where f.investor_type = $2
       group by f.symbol
    )
    select ind.symbol,
           ind.qty  as individual_qty,
           buy.qty  as buyer_qty,
           ind.srcs as individual_srcs,
           buy.srcs as buyer_srcs,
           ${SELECT_ENRICH}
      from ind
      join buy  on buy.symbol = ind.symbol
      join instruments i on i.symbol = ind.symbol
      join ohlcv_daily o on o.symbol = ind.symbol and o.date = $3
      left join lateral (
        select c from ohlcv_daily p
         where p.symbol = ind.symbol and p.date < $3
         order by p.date desc limit 1
      ) prev on true
     where ind.qty < 0
       and buy.qty > 0
       and o.traded_value >= $4
       and ($5 = 'ALL' or i.market = $5)
       and i.free_float_shares is not null
       and i.free_float_shares > 0
     order by buy.qty::numeric / i.free_float_shares desc
     limit $6
    `,
    [dates, params.buyerType, params.date, params.minTradedValue, params.market, params.limit],
  );

  return finalize(params, dates, raw, 'daily', notes);
}

/**
 * KRX CSV 기간합계 기반 — 사모 세분을 CSV 로만 확보한 경우.
 * 조건 A(개인)도 같은 [start, end] 구간의 일별 합으로 계산해 기간을 정확히 맞춘다.
 */
export async function runScreenerFromPeriod(
  params: ScreenerParams,
  start: string,
  end: string,
): Promise<ScreenerResult> {
  const dates = (
    await query<{ d: string }>(
      `select to_char(date,'YYYY-MM-DD') d from trading_days
        where is_open and date between $1 and $2 order by date desc`,
      [start, end],
    )
  ).map((r) => r.d);

  const raw = await query<Record<string, string | null>>(
    `
    with ind as (
      select f.symbol, sum(f.net_buy_qty) qty, array_agg(distinct f.source) srcs
        from investor_flow_daily f
       where f.investor_type = 'individual' and f.date between $1 and $2
       group by f.symbol
    ),
    buy as (
      select p.symbol, sum(p.net_buy_qty) qty, array_agg(distinct p.source) srcs
        from investor_flow_period p
       where p.investor_type = $3 and p.start_date = $1 and p.end_date = $2
       group by p.symbol
    )
    select buy.symbol,
           ind.qty  as individual_qty,
           buy.qty  as buyer_qty,
           ind.srcs as individual_srcs,
           buy.srcs as buyer_srcs,
           ${SELECT_ENRICH}
      from buy
      join ind on ind.symbol = buy.symbol
      join instruments i on i.symbol = buy.symbol
      join ohlcv_daily o on o.symbol = buy.symbol and o.date = $2
      left join lateral (
        select c from ohlcv_daily p2
         where p2.symbol = buy.symbol and p2.date < $2
         order by p2.date desc limit 1
      ) prev on true
     where ind.qty < 0
       and buy.qty > 0
       and o.traded_value >= $4
       and ($5 = 'ALL' or i.market = $5)
       and i.free_float_shares is not null
       and i.free_float_shares > 0
     order by buy.qty::numeric / i.free_float_shares desc
     limit $6
    `,
    [start, end, params.buyerType, params.minTradedValue, params.market, params.limit],
  );

  return finalize({ ...params, date: end, n: dates.length }, dates, raw, 'period', [
    `KRX CSV 기간합계(${start} ~ ${end})로 조건 B를 계산했습니다. 조건 A(개인)도 같은 구간의 일별 합입니다.`,
  ]);
}

async function finalize(
  params: ScreenerParams,
  dates: string[],
  raw: Record<string, string | null>[],
  mode: 'daily' | 'period',
  notes: string[],
): Promise<ScreenerResult> {
  const symbols = raw.map((r) => String(r.symbol));
  const insiders = await insiderMap(symbols, dates.at(-1) ?? params.date, params.date);
  const patterns = await patternMap(symbols, params.date);

  const buyerSources = new Set<string>();
  const individualSources = new Set<string>();

  const rows: ScreenerRow[] = raw.map((r) => {
    const symbol = String(r.symbol);
    const buyerQty = Number(r.buyer_qty ?? 0);
    const floatShares = r.float_shares === null ? null : Number(r.float_shares);
    (r.buyer_srcs as unknown as string[] | null)?.forEach((s) => buyerSources.add(s));
    (r.individual_srcs as unknown as string[] | null)?.forEach((s) => individualSources.add(s));
    const ins = insiders.get(symbol);
    return {
      symbol,
      name: String(r.name ?? ''),
      market: String(r.market ?? ''),
      individualNetQty: Number(r.individual_qty ?? 0),
      buyerNetQty: buyerQty,
      buyerType: params.buyerType,
      buyerLabel: INVESTOR_LABEL[params.buyerType],
      floatShares,
      floatBasis: (r.float_basis as 'computed' | 'listed_shares') ?? 'listed_shares',
      ratioPct: floatShares && floatShares > 0 ? (buyerQty / floatShares) * 100 : null,
      close: r.close === null ? null : Number(r.close),
      changePct: r.change_pct === null ? null : Number(r.change_pct),
      tradedValue: r.traded_value === null ? null : Number(r.traded_value),
      insiderBuys: ins?.count ?? 0,
      insiderLatestRcept: ins?.rcept ?? null,
      patterns: patterns.get(symbol) ?? [],
    };
  });

  return {
    params,
    windowDates: dates,
    buyerSources: [...buyerSources],
    individualSources: [...individualSources],
    mode,
    rows,
    notes,
  };
}

async function insiderMap(symbols: string[], from: string, to: string) {
  const map = new Map<string, { count: number; rcept: string }>();
  if (!symbols.length) return map;
  const rows = await query<{ symbol: string; n: string; rcept_no: string }>(
    `select symbol, count(*) n, max(rcept_no) rcept_no
       from insider_trades
      where symbol = any($1) and is_open_market_buy and change_qty > 0
        and trade_date between $2 and $3
      group by symbol`,
    [symbols, from, to],
  );
  for (const r of rows) map.set(r.symbol, { count: Number(r.n), rcept: r.rcept_no });
  return map;
}

async function patternMap(symbols: string[], date: string) {
  const map = new Map<string, Array<{ pattern: string; score: number; confirmed: boolean }>>();
  if (!symbols.length) return map;
  const rows = await query<{ symbol: string; pattern: string; score: string; confirmed: boolean }>(
    `select symbol, pattern, score, confirmed from pattern_hits
      where symbol = any($1) and date = $2`,
    [symbols, date],
  );
  for (const r of rows) {
    const list = map.get(r.symbol) ?? [];
    list.push({ pattern: r.pattern, score: Number(r.score), confirmed: r.confirmed });
    map.set(r.symbol, list);
  }
  return map;
}

/** 임포트된 CSV 기간 목록 — UI 프리셋용. */
export async function availablePeriods(): Promise<
  Array<{ start: string; end: string; investorType: string; symbols: number; source: string }>
> {
  return query(
    `select to_char(start_date,'YYYY-MM-DD') as start,
            to_char(end_date,'YYYY-MM-DD')   as end,
            investor_type                    as "investorType",
            count(*)::int                    as symbols,
            min(source)                      as source
       from investor_flow_period
      group by 1,2,3
      order by 2 desc, 1 desc`,
  );
}
