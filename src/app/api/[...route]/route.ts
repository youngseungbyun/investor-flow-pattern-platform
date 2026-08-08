/**
 * 단일 API 표면.
 *
 *   GET  /api/status
 *   GET  /api/periods
 *   GET  /api/screener?date&n&market&minTradedValue&buyerType&limit&mode&start&end
 *   GET  /api/patterns?date&pattern&minScore&confirmedOnly&limit
 *   GET  /api/stock/{symbol}?date&days
 *   GET  /api/drawings?symbol
 *   PUT  /api/drawings?symbol            (body: 도형 배열)
 *   GET  /api/udf/config|time|symbols|search|history      ← TradingView UDF
 */
import { NextResponse } from 'next/server';
import { env, exec, query, todayKst } from '@/lib/core';
import {
  availablePeriods,
  runScreener,
  runScreenerFromPeriod,
  type MarketFilter,
  type ScreenerParams,
} from '@/domain/screener';
import { INVESTOR_LABEL, activeProviders, type InvestorType } from '@/providers/investor-flow';
import { dartViewerUrl } from '@/providers/dart';
import { kisInfo } from '@/providers/kis';
import { PATTERN_CATALOG, STAGE_KO } from '@/domain/patterns';
import { SIGNAL_KO, linesForSymbol } from '@/domain/lines';
import { DEFAULT_RULE, runRule, type Rule } from '@/domain/rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ route: string[] }> };

const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
const bad = (message: string, status = 400) => json({ error: message }, status);

export async function GET(req: Request, ctx: Ctx) {
  const { route } = await ctx.params;
  const q = new URL(req.url).searchParams;

  try {
    switch (route[0]) {
      case 'status':
        return json(await statusPayload());
      case 'periods':
        return json({ periods: await availablePeriods() });
      case 'screener':
        return json(await screenerPayload(q));
      case 'patterns':
        return json(await patternsPayload(q));
      case 'stock':
        if (!route[1]) return bad('symbol 이 필요합니다.');
        return json(await stockPayload(route[1], q));
      case 'catalog':
        return json(catalogPayload());
      case 'lines':
        return json(await linesPayload(q));
      case 'series':
        return json(await marketSeries());
      case 'rule':
        return json(await runRule(ruleFromQuery(q)));
      case 'drawings':
        return json(await getDrawings(q.get('symbol')));
      case 'udf':
        return udf(route.slice(1), q);
      default:
        return bad(`알 수 없는 경로: /api/${route.join('/')}`, 404);
    }
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const { route } = await ctx.params;
  try {
    if (route[0] === 'rule') {
      const body = (await req.json()) as Partial<Rule>;
      const rule: Rule = { ...DEFAULT_RULE, date: todayKst(), ...body } as Rule;
      return json(await runRule(rule));
    }
    return bad(`알 수 없는 경로: /api/${route.join('/')}`, 404);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  const { route } = await ctx.params;
  if (route[0] !== 'drawings') return bad('지원하지 않는 경로', 404);
  const symbol = new URL(req.url).searchParams.get('symbol');
  if (!symbol) return bad('symbol 이 필요합니다.');
  const payload = await req.json();
  await exec(
    `insert into chart_drawings (user_id, symbol, payload_json, updated_at)
     values ($1,$2,$3, now())
     on conflict (user_id, symbol) do update
       set payload_json = excluded.payload_json, updated_at = now()`,
    [env.defaultUserId, symbol, JSON.stringify(payload)],
  );
  return json({ ok: true, symbol, count: Array.isArray(payload) ? payload.length : 0 });
}

/* ───────────────────────────── status ───────────────────────────── */

/**
 * 시장 전체 수급 30일 시계열. 개인·외국인·기관합계의 일별 순매수 금액 합.
 * 상단 벤토의 미니 차트가 이걸 그린다. 종목 화면과 같은 색 규약을 쓴다.
 */
async function marketSeries() {
  const rows = await query<{ d: string; t: string; amt: string }>(
    `select to_char(date,'YYYY-MM-DD') d, investor_type t, sum(net_buy_amount)::bigint amt
       from investor_flow_daily
      where investor_type in ('individual','foreign','institution_total')
        and net_buy_amount is not null
      group by date, investor_type
      order by date`,
  );
  const byDate = new Map<string, Record<string, string | number>>();
  for (const r of rows) {
    const row = byDate.get(r.d) ?? { date: r.d.slice(5) };
    row[r.t] = Math.round(Number(r.amt) / 1e8); // 억원
    byDate.set(r.d, row);
  }
  return { rows: [...byDate.values()] };
}

async function statusPayload() {
  const runs = await query(
    `select to_char(date,'YYYY-MM-DD') date, step, status, row_count, error, provider,
            to_char(ran_at, 'YYYY-MM-DD HH24:MI') ran_at
       from batch_runs
      where date = (select max(date) from batch_runs)
      order by step`,
  );
  const counts = await query(
    `select
       (select count(*) from ohlcv_daily)          as ohlcv,
       (select count(*) from investor_flow_daily)  as flow_daily,
       (select count(*) from investor_flow_period) as flow_period,
       (select count(*) from insider_trades)       as insider,
       (select count(*) from pattern_hits)         as patterns,
       (select count(*) from pattern_hits where confirmed) as patterns_confirmed,
       (select count(*) from instruments)          as instruments,
       (select count(*) from instruments where free_float_basis = 'computed') as float_computed,
       (select to_char(max(date),'YYYY-MM-DD') from trading_days where is_open) as last_trading_day`,
  );
  const providers = (await activeProviders()).map((p) => ({
    id: p.id,
    label: p.label,
    covers: p.covers.map((c) => INVESTOR_LABEL[c]),
  }));
  const failed = runs.filter((r) => r.status === 'failed').length;
  return {
    runs,
    counts: counts[0] ?? {},
    providers,
    configuredProviders: env.investorFlowProviders,
    overall: runs.length === 0 ? 'none' : failed > 0 ? 'partial' : 'ok',
  };
}

/* ──────────────────────────── catalog ──────────────────────────── */

/** UI 드롭다운이 참조하는 단일 카탈로그 (투자자 구분 / 패턴 / 단계 / 라인 시그널) */
function catalogPayload() {
  return {
    investors: (Object.keys(INVESTOR_LABEL) as InvestorType[]).map((id) => ({
      id,
      ko: INVESTOR_LABEL[id],
      group:
        id === 'individual' ? '개인'
        : id === 'foreign' || id === 'other_foreign' ? '외국인'
        : id === 'other_corp' ? '기타법인'
        : '기관',
    })),
    patterns: PATTERN_CATALOG,
    stages: Object.entries(STAGE_KO).map(([id, ko]) => ({ id, ko })),
    lineSignals: Object.entries(SIGNAL_KO).map(([id, ko]) => ({ id, ko })),
    metrics: [
      { id: 'float_pct', ko: '유통주식수 대비 %' },
      { id: 'amount', ko: '순매수 금액(원)' },
      { id: 'turnover_x', ko: '평소 거래대금 대비 배수' },
      { id: 'qty', ko: '순매수 수량(주)' },
    ],
    kis: kisInfo(),
    defaultRule: DEFAULT_RULE,
  };
}

/* ────────────────────────── 조건 빌더 ────────────────────────── */

/** GET 으로도 규칙을 넘길 수 있게 rule=<json> 을 받는다. */
function ruleFromQuery(q: URLSearchParams): Rule {
  const raw = q.get('rule');
  const base: Rule = { ...DEFAULT_RULE, date: q.get('date') ?? todayKst() } as Rule;
  if (!raw) return base;
  try {
    return { ...base, ...(JSON.parse(raw) as Partial<Rule>) } as Rule;
  } catch {
    return base;
  }
}

/* ──────────────────────────── lines ──────────────────────────── */

async function linesPayload(q: URLSearchParams) {
  const date = q.get('date') ?? todayKst();
  const from = q.get('from') || null;
  const signal = q.get('signal');
  const minScore = Number(q.get('minScore') ?? 40);
  const limit = Math.min(300, Number(q.get('limit') ?? 100));
  const market = q.get('market') ?? 'ALL';
  const minTradedValue = Number(q.get('minTradedValue') ?? 1_000_000_000);

  const rows = await query(
    `select s.symbol, i.name, i.market, s.signal, s.score, s.detail_json as detail,
            o.c as close, o.traded_value,
            case when prev.c is not null and prev.c <> 0
                 then round((o.c - prev.c) / prev.c * 100, 2) end as change_pct,
            coalesce(pat.tags, '[]'::jsonb) as patterns
       from (
         select distinct on (symbol, signal) *
           from line_signals
          where date between coalesce($7::date, $1::date) and $1::date
          order by symbol, signal, date desc
       ) s
       join instruments i on i.symbol = s.symbol
       join ohlcv_daily o on o.symbol = s.symbol and o.date = s.date
       left join lateral (
         select c from ohlcv_daily p where p.symbol = s.symbol and p.date < s.date
          order by p.date desc limit 1
       ) prev on true
       left join lateral (
         select jsonb_agg(jsonb_build_object(
                  'pattern', ph.pattern, 'direction', ph.direction,
                  'stage', ph.stage, 'score', ph.score)) as tags
           from pattern_hits ph
          where ph.symbol = s.symbol and ph.date = s.date and ph.score >= 55
       ) pat on true
      where ($2::text is null or s.signal = $2)
        and s.score >= $3
        and o.traded_value >= $4
        and ($5 = 'ALL' or i.market = $5)
      order by s.score desc
      limit $6`,
    [date, signal, minScore, minTradedValue, market, limit, from],
  );
  return { date, signal, minScore, count: rows.length, signalLabels: SIGNAL_KO, rows };
}

/* ──────────────────────────── screener ──────────────────────────── */

function screenerParams(q: URLSearchParams): ScreenerParams {
  return {
    date: q.get('date') ?? todayKst(),
    n: Number(q.get('n') ?? 5),
    market: (q.get('market') ?? 'ALL') as MarketFilter,
    minTradedValue: Number(q.get('minTradedValue') ?? 1_000_000_000),
    buyerType: (q.get('buyerType') ?? 'private_fund') as InvestorType,
    limit: Math.min(500, Number(q.get('limit') ?? 100)),
  };
}

async function screenerPayload(q: URLSearchParams) {
  const params = screenerParams(q);
  if (q.get('mode') === 'period') {
    const start = q.get('start');
    const end = q.get('end');
    if (!start || !end) throw new Error('period 모드는 start/end 가 필요합니다.');
    return runScreenerFromPeriod(params, start, end);
  }
  return runScreener(params);
}

/* ──────────────────────────── patterns ──────────────────────────── */

async function patternsPayload(q: URLSearchParams) {
  const date = q.get('date') ?? todayKst();
  const patterns = q.get('patterns')?.split(',').filter(Boolean) ?? null;
  const directions = q.get('directions')?.split(',').filter(Boolean) ?? null;
  const stages = q.get('stages')?.split(',').filter(Boolean) ?? null;
  const minScore = Number(q.get('minScore') ?? 60);
  const limit = Math.min(300, Number(q.get('limit') ?? 150));
  const market = q.get('market') ?? 'ALL';
  const minTradedValue = Number(q.get('minTradedValue') ?? 1_000_000_000);
  // 수급 태그: 이 임계값 이상 들어온 주체만 칩으로 붙인다
  const flowMinPct = Number(q.get('flowMinPct') ?? 0.3);
  // 기간 모드: from 이 오면 [from, date] 범위의 스캔을 모두 훑되,
  // 같은 종목·패턴은 기간 내 최신 스캔 하나만 대표로 남긴다.
  const from = q.get('from') || null;

  const rows = await query(
    `select p.symbol, i.name, i.market, p.pattern, p.direction, p.kind, p.stage,
            p.score, p.confirmed, p.pivot_price, p.distance_pct,
            to_char(p.breakout_date,'YYYY-MM-DD') breakout_date,
            to_char(p.start_date,'YYYY-MM-DD') start_date,
            to_char(p.end_date,'YYYY-MM-DD') end_date,
            p.evidence_json as evidence,
            o.c as close, o.traded_value,
            coalesce(fl.tags, '[]'::jsonb) as flow_tags,
            coalesce(ls.tags, '[]'::jsonb) as line_tags
       from (
         select distinct on (symbol, pattern) *
           from pattern_hits
          where date between coalesce($10::date, $1::date) and $1::date
          order by symbol, pattern, date desc
       ) p
       join instruments i on i.symbol = p.symbol
       join ohlcv_daily o on o.symbol = p.symbol and o.date = p.date
       left join lateral (
         select jsonb_agg(t) as tags from (
           select e.investor_type, max(e.float_ratio_pct) as float_pct,
                  to_char(max(e.date),'YYYY-MM-DD') as on_date
             from flow_events e
            where e.symbol = p.symbol
              and e.date between coalesce(p.start_date, p.date - 60) and p.date
              and e.float_ratio_pct >= $6
            group by e.investor_type
            order by max(e.float_ratio_pct) desc
            limit 4
         ) t
       ) fl on true
       left join lateral (
         select jsonb_agg(jsonb_build_object('signal', s.signal, 'score', s.score)) as tags
           from line_signals s where s.symbol = p.symbol and s.date = p.date
       ) ls on true
      where p.score >= $2
        and ($3::text[] is null or p.pattern = any($3))
        and ($4::text[] is null or p.direction = any($4))
        and ($5::text[] is null or p.stage = any($5))
        and o.traded_value >= $7
        and ($8 = 'ALL' or i.market = $8)
      order by p.score desc
      limit $9`,
    [date, minScore, patterns, directions, stages, flowMinPct, minTradedValue, market, limit, from],
  );
  return {
    date,
    from,
    minScore,
    count: rows.length,
    stageLabels: STAGE_KO,
    signalLabels: SIGNAL_KO,
    investorLabels: INVESTOR_LABEL,
    catalog: PATTERN_CATALOG,
    rows,
  };
}

/* ───────────────────────────── stock ───────────────────────────── */

async function stockPayload(symbol: string, q: URLSearchParams) {
  const date = q.get('date') ?? todayKst();
  const days = Math.min(400, Number(q.get('days') ?? 120));

  const instrument = (
    await query(
      `select symbol, name, market, isin, corp_code,
              listed_shares, major_holder_shares, treasury_shares,
              free_float_shares, free_float_basis,
              to_char(free_float_updated_at,'YYYY-MM-DD') free_float_updated_at
         from instruments where symbol = $1`,
      [symbol],
    )
  )[0];
  if (!instrument) throw new Error(`종목을 찾을 수 없습니다: ${symbol}`);

  const bars = await query(
    `select to_char(date,'YYYY-MM-DD') date, o, h, l, c, volume, traded_value
       from ohlcv_daily where symbol = $1 and date <= $2
       order by date desc limit $3`,
    [symbol, date, days],
  );
  bars.reverse();

  const flow = await query(
    `select to_char(date,'YYYY-MM-DD') date, investor_type, net_buy_qty, net_buy_amount, source
       from investor_flow_daily
      where symbol = $1 and date <= $2
      order by date desc limit $3`,
    [symbol, date, days * 12],
  );

  const periods = await query(
    `select to_char(start_date,'YYYY-MM-DD') start, to_char(end_date,'YYYY-MM-DD') "end",
            investor_type, net_buy_qty, net_buy_amount, source
       from investor_flow_period where symbol = $1 order by end_date desc`,
    [symbol],
  );

  const members = await query(
    `select to_char(date,'YYYY-MM-DD') date, member_name, buy_qty, sell_qty,
            (buy_qty - sell_qty) as net_qty, source
       from member_flow_daily where symbol = $1 and date <= $2
       order by date desc, (buy_qty - sell_qty) desc limit 60`,
    [symbol, date],
  );

  const insiders = (
    await query(
      `select rcept_no, to_char(trade_date,'YYYY-MM-DD') trade_date,
              to_char(disclosed_at,'YYYY-MM-DD') disclosed_at,
              officer_name, position, registered, change_qty, method, is_open_market_buy
         from insider_trades where symbol = $1
         order by trade_date desc nulls last limit 50`,
      [symbol],
    )
  ).map((r) => ({ ...r, dartUrl: dartViewerUrl(String(r.rcept_no)) }));

  // 스캔 날짜를 섞으면 같은 패턴이 날짜별로 중복돼 내려간다(쌍바닥 08-05 + 08-06).
  // 종목 상세가 보여줄 것은 "지금 이 종목의 패턴"이므로 최신 스캔 날짜 하나로 한정한다.
  const patterns = await query(
    `select pattern, score, confirmed, evidence_json as evidence,
            to_char(date,'YYYY-MM-DD') date, direction, stage,
            pivot_price, distance_pct
       from pattern_hits
      where symbol = $1
        and date = (select max(date) from pattern_hits where symbol = $1)
      order by score desc
      limit 8`,
    [symbol],
  );

  // 차트 봉에 얹을 수급 마커.
  // 고정 임계값만 쓰면 대형주는 유통주식수가 커서 아무것도 안 잡힌다(삼성전자 0.3% = 1,750만주).
  // 그래서 임계값을 넘긴 날이 없으면 "유입/유출이 가장 컸던 상위 N일"을 대신 보여준다.
  const markerMinPct = Number(q.get('markerMinPct') ?? 0.3);
  const markerLimit = Math.min(80, Number(q.get('markerLimit') ?? 30));
  const markerSql = (minPct: number) =>
    query(
      `select to_char(e.date,'YYYY-MM-DD') date, e.investor_type, e.net_buy_qty, e.net_buy_amount,
              e.float_ratio_pct, e.turnover_x, e.float_basis
         from flow_events e
        where e.symbol = $1 and e.date <= $2::date and e.date >= ($2::date - $3::int)
          and e.investor_type <> 'institution_total'
          and abs(coalesce(e.float_ratio_pct, 0)) >= $4::numeric
        order by abs(e.float_ratio_pct) desc nulls last
        limit $5::int`,
      [symbol, date, days, minPct, markerLimit],
    );
  let flowMarkers = await markerSql(markerMinPct);
  let markerFallback = false;
  if (flowMarkers.length === 0) {
    flowMarkers = await markerSql(0);
    markerFallback = flowMarkers.length > 0;
  }

  const programDaily = await query(
    `select to_char(date,'YYYY-MM-DD') date, buy_qty, sell_qty, net_qty, net_amt
       from program_trade_daily where symbol = $1 and date <= $2
       order by date desc limit 60`,
    [symbol, date],
  );

  // KIS 분봉 API 는 요청 날짜와 무관하게 "최근 세션" 분봉만 준다.
  // 그래서 일봉 기준일로 조회하면 대개 빈 결과가 나온다.
  // 명시 지정이 없으면 이 종목이 실제로 보유한 최신 분봉 날짜를 쓴다.
  const minuteDate =
    q.get('minuteDate') ??
    (
      await query<{ d: string | null }>(
        `select to_char(max(ts) at time zone 'Asia/Seoul', 'YYYY-MM-DD') d
           from ohlcv_minute where symbol = $1`,
        [symbol],
      )
    )[0]?.d ??
    date;
  const minute = await query(
    `select to_char(m.ts at time zone 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS') ts,
            m.o, m.h, m.l, m.c, m.volume,
            p.buy_qty as pgm_buy, p.sell_qty as pgm_sell, p.net_qty as pgm_net, p.net_amt as pgm_net_amt
       from ohlcv_minute m
       left join program_trade_minute p on p.symbol = m.symbol and p.ts = m.ts
      where m.symbol = $1 and m.ts >= $2::date and m.ts < ($2::date + 1)
      order by m.ts`,
    [symbol, minuteDate],
  );

  const lines = await linesForSymbol(symbol, date);
  const lineSignals = await query(
    `select signal, score, detail_json as detail from line_signals where symbol = $1 and date = $2`,
    [symbol, date],
  );

  return {
    instrument,
    bars,
    flow,
    flowMarkers,
    markerFallback,
    markerMinPct,
    periods,
    members,
    insiders,
    patterns,
    programDaily,
    minute,
    lines,
    lineSignals,
    signalLabels: SIGNAL_KO,
    stageLabels: STAGE_KO,
    investorLabels: INVESTOR_LABEL,
  };
}

async function getDrawings(symbol: string | null) {
  if (!symbol) throw new Error('symbol 이 필요합니다.');
  const row = (
    await query<{ payload_json: unknown }>(
      `select payload_json from chart_drawings where user_id = $1 and symbol = $2`,
      [env.defaultUserId, symbol],
    )
  )[0];
  return { symbol, drawings: row?.payload_json ?? [] };
}

/* ───────────────────────── TradingView UDF ───────────────────────── */

/**
 * Charting Library(Advanced Charts) 는 시세를 직접 주지 않는다.
 * 승인 전에도 개발이 막히지 않도록 UDF 엔드포인트를 먼저 만들어 둔다.
 * 라이브러리를 넣으면 datafeed URL 만 /api/udf 로 가리키면 된다.
 */
async function udf(path: string[], q: URLSearchParams) {
  switch (path[0]) {
    case 'config':
      return json({
        supports_search: true,
        supports_group_request: false,
        supports_marks: false,
        supports_timescale_marks: false,
        supports_time: true,
        supported_resolutions: ['1D', '1W', '1M'],
        exchanges: [
          { value: '', name: '전체', desc: '전체' },
          { value: 'KOSPI', name: 'KOSPI', desc: '유가증권' },
          { value: 'KOSDAQ', name: 'KOSDAQ', desc: '코스닥' },
        ],
        symbols_types: [{ name: '주식', value: 'stock' }],
      });

    case 'time':
      return new NextResponse(String(Math.floor(Date.now() / 1000)), {
        headers: { 'Content-Type': 'text/plain' },
      });

    case 'symbols': {
      const raw = q.get('symbol') ?? '';
      const symbol = raw.includes(':') ? raw.split(':')[1] : raw;
      const row = (
        await query(`select symbol, name, market from instruments where symbol = $1`, [symbol])
      )[0];
      if (!row) return json({ s: 'error', errmsg: 'unknown_symbol' });
      return json({
        name: row.symbol,
        ticker: row.symbol,
        description: `${row.name} (${row.symbol})`,
        type: 'stock',
        session: '0900-1530',
        timezone: 'Asia/Seoul',
        exchange: row.market,
        listed_exchange: row.market,
        minmov: 1,
        pricescale: 1,
        has_intraday: false,
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: ['1D', '1W', '1M'],
        volume_precision: 0,
        data_status: 'endofday',
      });
    }

    case 'search': {
      const term = (q.get('query') ?? '').trim();
      const rows = await query(
        `select symbol, name, market from instruments
          where symbol like $1 or name ilike $2
          order by symbol limit 30`,
        [`${term}%`, `%${term}%`],
      );
      return json(
        rows.map((r) => ({
          symbol: r.symbol,
          full_name: r.symbol,
          description: `${r.name} (${r.symbol})`,
          exchange: r.market,
          ticker: r.symbol,
          type: 'stock',
        })),
      );
    }

    case 'history': {
      const raw = q.get('symbol') ?? '';
      const symbol = raw.includes(':') ? raw.split(':')[1] : raw;
      const from = Number(q.get('from') ?? 0);
      const to = Number(q.get('to') ?? Math.floor(Date.now() / 1000));
      const rows = await query<{ t: string; o: string; h: string; l: string; c: string; v: string }>(
        `select extract(epoch from date)::bigint::text t, o, h, l, c, volume v
           from ohlcv_daily
          where symbol = $1
            and date >= to_timestamp($2)::date
            and date <= to_timestamp($3)::date
            and c is not null
          order by date`,
        [symbol, from, to],
      );
      if (rows.length === 0) {
        const next = (
          await query<{ d: string | null }>(
            `select extract(epoch from max(date))::bigint::text d from ohlcv_daily where symbol = $1`,
            [symbol],
          )
        )[0];
        return json({ s: 'no_data', nextTime: next?.d ? Number(next.d) : undefined });
      }
      return json({
        s: 'ok',
        t: rows.map((r) => Number(r.t)),
        o: rows.map((r) => Number(r.o)),
        h: rows.map((r) => Number(r.h)),
        l: rows.map((r) => Number(r.l)),
        c: rows.map((r) => Number(r.c)),
        v: rows.map((r) => Number(r.v)),
      });
    }

    default:
      return bad(`알 수 없는 UDF 경로: ${path.join('/')}`, 404);
  }
}
