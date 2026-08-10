/**
 * 수급 조건 빌더 — 수급 × 패턴 × 라인을 임의로 조합해 종목을 뽑는다.
 *
 * 사용자가 원한 대표 조건은 이렇게 표현된다.
 *
 *   "사모펀드가 하루에 유통주식수의 1% 이상 순매수한 날이
 *    역헤드앤숄더 또는 컵앤핸들 패턴 기간 안에 있고,
 *    지금은 넥라인 부근이거나 돌파 후 눌림목인 종목"
 *
 *   flow:    [{ investorType:'private_fund', side:'buy', metric:'float_pct',
 *               op:'>=', value:1, scope:'pattern_window', agg:'daily_max' }]
 *   pattern: { patterns:['inverse_head_shoulders','cup_with_handle'],
 *              stages:['near_pivot','pullback'] }
 *
 * flow 조건은 AND 로 결합한다.
 */
import { query } from '../lib/core';
import { INVESTOR_LABEL, type InvestorType } from '../providers/investor-flow';
import { PATTERN_BY_ID, STAGE_KO, type Direction, type Stage } from './patterns';

/* ───────────────────────── 수급 이벤트 ───────────────────────── */

/**
 * investor_flow_daily 를 "유통주식수 대비 %"·"평소 거래대금 대비 배수"로 정규화해
 * flow_events 에 적재한다. 조건 빌더는 이 테이블만 본다.
 */
export async function computeFlowEvents(fromDate: string, toDate: string): Promise<number> {
  await query(
    `
    insert into flow_events
      (symbol, date, investor_type, net_buy_qty, net_buy_amount,
       float_ratio_pct, turnover_x, float_basis)
    select f.symbol, f.date, f.investor_type, f.net_buy_qty, f.net_buy_amount,
           case when i.free_float_shares > 0
                then round(f.net_buy_qty::numeric / i.free_float_shares * 100, 6) end,
           case when av.avg_tv > 0 and f.net_buy_amount is not null
                then round(abs(f.net_buy_amount)::numeric / av.avg_tv, 4) end,
           i.free_float_basis
      from investor_flow_daily f
      join instruments i on i.symbol = f.symbol
      left join lateral (
        select avg(t.traded_value)::numeric as avg_tv
          from (select traded_value
                  from ohlcv_daily o2
                 where o2.symbol = f.symbol and o2.date < f.date
                 order by o2.date desc
                 limit 20) t
      ) av on true
     where f.date between $1 and $2
    on conflict (symbol, date, investor_type) do update set
      net_buy_qty = excluded.net_buy_qty,
      net_buy_amount = excluded.net_buy_amount,
      float_ratio_pct = excluded.float_ratio_pct,
      turnover_x = excluded.turnover_x,
      float_basis = excluded.float_basis
    `,
    [fromDate, toDate],
  );
  const r = await query<{ n: string }>(
    `select count(*)::text n from flow_events where date between $1 and $2`,
    [fromDate, toDate],
  );
  return Number(r[0]?.n ?? 0);
}

/* ───────────────────────── 조건 타입 ───────────────────────── */

export type FlowMetric = 'float_pct' | 'amount' | 'turnover_x' | 'qty';
/** recent = 기준일부터 과거 windowDays 거래일 / pattern_window = 매칭된 패턴의 시작~종료 구간 */
export type FlowScope = 'recent' | 'pattern_window';
/** sum = 구간 합계 / daily_max = 구간 내 하루 최대치 (하루에 몰아서 들어온 것을 잡는다) */
export type FlowAgg = 'sum' | 'daily_max';

export interface FlowCondition {
  investorType: InvestorType;
  /** buy = 순매수(양수) 기준, sell = 순매도(음수 절대값) 기준 */
  side: 'buy' | 'sell';
  metric: FlowMetric;
  op: '>=' | '<=';
  value: number;
  scope: FlowScope;
  windowDays: number;
  agg: FlowAgg;
}

export interface PatternCondition {
  patterns?: string[];
  directions?: Direction[];
  stages?: Stage[];
  minScore?: number;
  /** 현재가와 돌파선 이격 절대값 상한(%) */
  maxDistancePct?: number;
}

export interface LineCondition {
  signals?: string[];
  minScore?: number;
}

export interface Rule {
  date: string;
  market: 'ALL' | 'KOSPI' | 'KOSDAQ';
  minTradedValue: number;
  flow: FlowCondition[];
  pattern?: PatternCondition;
  line?: LineCondition;
  limit: number;
  sortBy: 'flow' | 'score' | 'traded_value';
}

export const DEFAULT_RULE: Omit<Rule, 'date'> = {
  market: 'ALL',
  minTradedValue: 1_000_000_000,
  flow: [
    {
      investorType: 'private_fund',
      side: 'buy',
      metric: 'float_pct',
      op: '>=',
      // 1% 로 두면 대부분의 날에 결과가 0건이 되어 "데이터가 없다"로 읽힌다.
      // 실측 상위 1% 선이 0.3% 근처라 여기에 맞춘다. 화면에서 언제든 올릴 수 있다.
      value: 0.3,
      // 기본은 '최근'. 'pattern_window' 는 패턴 형성 구간(보통 20~150봉) 안에서
      // 수급을 찾는데, 수급 데이터가 그만큼 쌓이기 전에는 교집합이 거의 비어
      // 결과가 0건이 된다. 데이터가 충분히 쌓이면 화면에서 바꿔 쓰면 된다.
      scope: 'recent',
      windowDays: 5,
      agg: 'daily_max',
    },
  ],
  pattern: {
    patterns: ['inverse_head_shoulders', 'cup_with_handle'],
    stages: ['near_pivot', 'pullback'],
    minScore: 50,
  },
  limit: 100,
  sortBy: 'flow',
};

/* ───────────────────────── 결과 타입 ───────────────────────── */

export interface RuleMatchFlow {
  investorType: InvestorType;
  label: string;
  metric: FlowMetric;
  value: number;
  onDate: string | null;
  netBuyQty: number | null;
  netBuyAmount: number | null;
  floatBasis: 'computed' | 'listed_shares';
}

export interface RuleRow {
  symbol: string;
  name: string;
  market: string;
  close: number | null;
  changePct: number | null;
  tradedValue: number | null;
  floatShares: number | null;
  floatBasis: 'computed' | 'listed_shares';
  flows: RuleMatchFlow[];
  patterns: Array<{
    pattern: string;
    ko: string;
    direction: Direction;
    stage: Stage;
    stageKo: string;
    score: number;
    pivotPrice: number | null;
    distancePct: number | null;
    breakoutDate: string | null;
    startDate: string | null;
    endDate: string | null;
  }>;
  lines: Array<{ signal: string; score: number; detail: Record<string, unknown> }>;
  insiderBuys: number;
  rank: number;
}

export interface RuleResult {
  rule: Rule;
  windowDates: string[];
  rows: RuleRow[];
  notes: string[];
  sources: string[];
}

/* ───────────────────────── 실행 ───────────────────────── */

const METRIC_COL: Record<FlowMetric, string> = {
  float_pct: 'float_ratio_pct',
  amount: 'net_buy_amount',
  turnover_x: 'turnover_x',
  qty: 'net_buy_qty',
};

export async function runRule(rule: Rule): Promise<RuleResult> {
  const notes: string[] = [];
  const maxWindow = Math.max(1, ...rule.flow.map((f) => f.windowDays));
  const dates = (
    await query<{ d: string }>(
      `select to_char(date,'YYYY-MM-DD') d from trading_days
        where is_open and date <= $1 order by date desc limit $2`,
      [rule.date, maxWindow],
    )
  ).map((r) => r.d);

  if (dates.length === 0) {
    return { rule, windowDates: [], rows: [], notes: ['거래일 캘린더에 해당 기간이 없습니다.'], sources: [] };
  }

  /* 1) 패턴 후보 */
  const pc = rule.pattern;
  const patternRows = await query<{
    symbol: string; pattern: string; direction: Direction; stage: Stage; score: string;
    pivot_price: string | null; distance_pct: string | null;
    breakout_date: string | null; start_date: string | null; end_date: string | null;
  }>(
    `select symbol, pattern, direction, stage, score, pivot_price, distance_pct,
            to_char(breakout_date,'YYYY-MM-DD') breakout_date,
            to_char(start_date,'YYYY-MM-DD') start_date,
            to_char(end_date,'YYYY-MM-DD') end_date
       from pattern_hits
      where date = $1
        and ($2::text[] is null or pattern = any($2))
        and ($3::text[] is null or direction = any($3))
        and ($4::text[] is null or stage = any($4))
        and score >= $5
        and ($6::numeric is null or abs(coalesce(distance_pct, 0)) <= $6)`,
    [
      rule.date,
      pc?.patterns?.length ? pc.patterns : null,
      pc?.directions?.length ? pc.directions : null,
      pc?.stages?.length ? pc.stages : null,
      pc?.minScore ?? 0,
      pc?.maxDistancePct ?? null,
    ],
  );

  const patternBySymbol = new Map<string, typeof patternRows>();
  for (const r of patternRows) {
    const list = patternBySymbol.get(r.symbol) ?? [];
    list.push(r);
    patternBySymbol.set(r.symbol, list);
  }

  const requirePattern = Boolean(pc && (pc.patterns?.length || pc.directions?.length || pc.stages?.length));
  let candidates: string[] | null = requirePattern ? [...patternBySymbol.keys()] : null;
  if (requirePattern && candidates && candidates.length === 0) {
    return { rule, windowDates: dates, rows: [], notes: ['패턴 조건을 만족하는 종목이 없습니다.'], sources: [] };
  }

  /* 2) 수급 조건 AND 결합 */
  const flowMatches = new Map<string, RuleMatchFlow[]>();
  for (const cond of rule.flow) {
    const col = METRIC_COL[cond.metric];
    const expr = cond.side === 'buy' ? `e.${col}` : `-e.${col}`;
    const windowFrom = dates[Math.min(dates.length, cond.windowDays) - 1];
    const patternJoin =
      cond.scope === 'pattern_window'
        ? `join pattern_hits p on p.symbol = e.symbol and p.date = $1::date
             and e.date between p.start_date and p.end_date`
        : '';
    // pattern_window 에서도 $3 을 한 번은 참조해야 Postgres 가 파라미터 타입을 정할 수 있다.
    const recentFilter =
      cond.scope === 'pattern_window' ? '($3::date is not null or true)' : 'e.date >= $3::date';

    const sql =
      cond.agg === 'daily_max'
        ? `select distinct on (e.symbol)
                  e.symbol, ${expr} as v, to_char(e.date,'YYYY-MM-DD') on_date,
                  e.net_buy_qty::text net_buy_qty, e.net_buy_amount::text net_buy_amount, e.float_basis
             from flow_events e
             ${patternJoin}
            where e.investor_type = $2
              and ${recentFilter}
              and e.date <= $1::date
              and ${expr} ${cond.op} $4
              and ($5::text[] is null or e.symbol = any($5))
            order by e.symbol, v desc`
        : `select e.symbol, sum(${expr}) as v, null::text on_date,
                  sum(e.net_buy_qty)::text net_buy_qty, sum(e.net_buy_amount)::text net_buy_amount,
                  min(e.float_basis) float_basis
             from flow_events e
             ${patternJoin}
            where e.investor_type = $2
              and ${recentFilter}
              and e.date <= $1::date
              and ($5::text[] is null or e.symbol = any($5))
            group by e.symbol
           having sum(${expr}) ${cond.op} $4`;

    const rows = await query<{
      symbol: string; v: string; on_date: string | null;
      net_buy_qty: string | null; net_buy_amount: string | null; float_basis: string;
    }>(sql, [rule.date, cond.investorType, windowFrom, cond.value, candidates]);

    const hitSymbols = new Set(rows.map((r) => r.symbol));
    candidates = candidates ? candidates.filter((s) => hitSymbols.has(s)) : [...hitSymbols];

    for (const r of rows) {
      if (!hitSymbols.has(r.symbol)) continue;
      const list = flowMatches.get(r.symbol) ?? [];
      list.push({
        investorType: cond.investorType,
        label: INVESTOR_LABEL[cond.investorType],
        metric: cond.metric,
        value: Number(r.v),
        onDate: r.on_date,
        netBuyQty: r.net_buy_qty === null ? null : Number(r.net_buy_qty),
        netBuyAmount: r.net_buy_amount === null ? null : Number(r.net_buy_amount),
        floatBasis: (r.float_basis as 'computed' | 'listed_shares') ?? 'listed_shares',
      });
      flowMatches.set(r.symbol, list);
    }

    if (candidates.length === 0) {
      // 임계값이 너무 센 것인지 데이터가 없는 것인지 구분해 준다.
      // 실제 최대 관측치를 같이 알려주면 사용자가 바로 보정할 수 있다.
      const observed = await query<{ mx: string | null; p99: string | null; n: string }>(
        `select round(max(${col}), 4)::text mx,
                round(percentile_cont(0.99) within group (order by ${col})::numeric, 4)::text p99,
                count(*)::text n
           from flow_events
          where investor_type = $1 and date >= $2::date and date <= $3::date`,
        [cond.investorType, windowFrom, rule.date],
      );
      const o = observed[0];
      const unit = cond.metric === 'float_pct' ? '%' : cond.metric === 'turnover_x' ? '배' : '';
      const metricKo =
        cond.metric === 'float_pct' ? '유통주식수 대비' : cond.metric === 'turnover_x' ? '평소 거래량 대비' : '순매수';
      notes.push(
        `${INVESTOR_LABEL[cond.investorType]} ${metricKo} ${cond.value}${unit} ${cond.op === '>=' ? '이상' : '이하'} 조건에 맞는 종목이 없어요. ` +
          (Number(o?.n ?? 0) === 0
            ? '이 기간에는 해당 투자자 구분의 데이터가 아직 없어요.'
            : `이 기간 실제 최대는 ${o?.mx ?? '-'}${unit}, 상위 1% 선은 ${o?.p99 ?? '-'}${unit}예요.`),
      );
      return { rule, windowDates: dates, rows: [], notes, sources: [] };
    }
  }

  if (!candidates) candidates = [];

  /* 3) 라인 조건 */
  const lineRows = await query<{ symbol: string; signal: string; score: string; detail_json: Record<string, unknown> }>(
    `select symbol, signal, score, detail_json from line_signals
      where date = $1 and ($2::text[] is null or symbol = any($2))
        and ($3::text[] is null or signal = any($3))
        and score >= $4`,
    [
      rule.date,
      candidates.length ? candidates : null,
      rule.line?.signals?.length ? rule.line.signals : null,
      rule.line?.minScore ?? 0,
    ],
  );
  const linesBySymbol = new Map<string, typeof lineRows>();
  for (const r of lineRows) {
    const list = linesBySymbol.get(r.symbol) ?? [];
    list.push(r);
    linesBySymbol.set(r.symbol, list);
  }
  if (rule.line?.signals?.length) candidates = candidates.filter((s) => linesBySymbol.has(s));

  if (candidates.length === 0) {
    notes.push('라인 조건까지 통과한 종목이 없습니다.');
    return { rule, windowDates: dates, rows: [], notes, sources: [] };
  }

  /* 4) 시세·종목 정보 + 내부자 */
  const meta = await query<{
    symbol: string; name: string; market: string; close: string | null; traded_value: string | null;
    change_pct: string | null; free_float_shares: string | null; free_float_basis: string;
  }>(
    `select i.symbol, i.name, i.market, o.c as close, o.traded_value,
            case when prev.c is not null and prev.c <> 0
                 then round((o.c - prev.c) / prev.c * 100, 2) end as change_pct,
            i.free_float_shares, i.free_float_basis
       from instruments i
       join ohlcv_daily o on o.symbol = i.symbol and o.date = $1
       left join lateral (
         select c from ohlcv_daily p where p.symbol = i.symbol and p.date < $1
          order by p.date desc limit 1
       ) prev on true
      where i.symbol = any($2)
        and o.traded_value >= $3
        and ($4 = 'ALL' or i.market = $4)`,
    [rule.date, candidates, rule.minTradedValue, rule.market],
  );

  const insiders = new Map<string, number>();
  for (const r of await query<{ symbol: string; n: string }>(
    `select symbol, count(*) n from insider_trades
      where symbol = any($1) and is_open_market_buy and change_qty > 0
        and trade_date >= $2::date - 90
      group by symbol`,
    [candidates, rule.date],
  )) {
    insiders.set(r.symbol, Number(r.n));
  }

  const rows: RuleRow[] = meta.map((m) => ({
    symbol: m.symbol,
    name: m.name,
    market: m.market,
    close: m.close === null ? null : Number(m.close),
    changePct: m.change_pct === null ? null : Number(m.change_pct),
    tradedValue: m.traded_value === null ? null : Number(m.traded_value),
    floatShares: m.free_float_shares === null ? null : Number(m.free_float_shares),
    floatBasis: (m.free_float_basis as 'computed' | 'listed_shares') ?? 'listed_shares',
    flows: flowMatches.get(m.symbol) ?? [],
    patterns: (patternBySymbol.get(m.symbol) ?? []).map((p) => ({
      pattern: p.pattern,
      ko: PATTERN_BY_ID.get(p.pattern)?.ko ?? p.pattern,
      direction: p.direction,
      stage: p.stage,
      stageKo: STAGE_KO[p.stage] ?? p.stage,
      score: Number(p.score),
      pivotPrice: p.pivot_price === null ? null : Number(p.pivot_price),
      distancePct: p.distance_pct === null ? null : Number(p.distance_pct),
      breakoutDate: p.breakout_date,
      startDate: p.start_date,
      endDate: p.end_date,
    })),
    lines: (linesBySymbol.get(m.symbol) ?? []).map((l) => ({
      signal: l.signal,
      score: Number(l.score),
      detail: l.detail_json,
    })),
    insiderBuys: insiders.get(m.symbol) ?? 0,
    rank: 0,
  }));

  const keyOf = (r: RuleRow) => {
    if (rule.sortBy === 'traded_value') return r.tradedValue ?? 0;
    if (rule.sortBy === 'score') return Math.max(0, ...r.patterns.map((p) => p.score));
    return Math.max(0, ...r.flows.map((f) => f.value));
  };
  rows.sort((a, b) => keyOf(b) - keyOf(a));
  rows.forEach((r, i) => (r.rank = i + 1));

  const sources = (
    await query<{ source: string }>(`select distinct source from investor_flow_daily where date = any($1)`, [dates])
  ).map((r) => r.source);

  return { rule, windowDates: dates, rows: rows.slice(0, rule.limit), notes, sources };
}
