'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import PriceChart, { PATTERN_KO, type ChartBar, type PatternInfo } from '@/components/PriceChart';
import SymbolSearch from '@/components/SymbolSearch';

interface FlowRow {
  date: string;
  investor_type: string;
  net_buy_qty: string;
  net_buy_amount: string | null;
  source: string;
}
interface PeriodRow {
  start: string;
  end: string;
  investor_type: string;
  net_buy_qty: string;
  source: string;
}
interface MemberRow {
  date: string;
  member_name: string;
  buy_qty: string;
  sell_qty: string;
  net_qty: string;
  source: string;
}
interface InsiderRow {
  rcept_no: string;
  trade_date: string | null;
  disclosed_at: string;
  officer_name: string | null;
  position: string | null;
  change_qty: string;
  method: string | null;
  is_open_market_buy: boolean;
  dartUrl: string;
}
interface MinuteRow {
  ts: string;
  o: string; h: string; l: string; c: string; volume: string;
  pgm_buy: string | null; pgm_sell: string | null; pgm_net: string | null; pgm_net_amt: string | null;
}

interface Payload {
  flowMarkers?: Array<{ date: string; investor_type: string; net_buy_qty: string; float_ratio_pct: string | null }>;
  lines?: Array<{ price: number; kind: 'support' | 'resistance'; touches: number; strength: number }>;
  lineSignals?: Array<{ signal: string; score: string; detail: Record<string, unknown> }>;
  minute?: MinuteRow[];
  programDaily?: Array<{ date: string; buy_qty: string; sell_qty: string; net_qty: string; net_amt: string }>;
  signalLabels?: Record<string, string>;
  stageLabels?: Record<string, string>;
  instrument: {
    symbol: string;
    name: string;
    market: string;
    listed_shares: string | null;
    major_holder_shares: string | null;
    treasury_shares: string | null;
    free_float_shares: string | null;
    free_float_basis: 'computed' | 'listed_shares';
    free_float_updated_at: string | null;
  };
  bars: ChartBar[];
  flow: FlowRow[];
  periods: PeriodRow[];
  members: MemberRow[];
  insiders: InsiderRow[];
  patterns: PatternInfo[];
  investorLabels: Record<string, string>;
  error?: string;
}

const nf = new Intl.NumberFormat('ko-KR');
const num = (v: unknown) => {
  const x = Number(v);
  return v === null || v === undefined || Number.isNaN(x) ? '-' : nf.format(Math.round(x));
};
const SERIES_COLOR: Record<string, string> = {
  individual: 'var(--up)',
  foreign: 'var(--down)',
  institution_total: 'var(--ok)',
  private_fund: 'var(--fg)',
  investment_trust: 'var(--accent)',
  pension: 'var(--fg-muted)',
};

export default function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const [data, setData] = useState<Payload | null>(null);
  const [windowDays, setWindowDays] = useState(20);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    (async () => {
      try {
        // 주봉·월봉을 만들려면 일봉이 많이 필요하다. 마커는 화면에서 주체·세기로
        // 거르므로 서버에서 미리 줄이지 않고 넉넉히 받는다.
        const res = await fetch(`/api/stock/${symbol}?days=400&markerMinPct=0&markerLimit=400`);
        const body = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok || !body || typeof body.error === 'string') {
          throw new Error(body?.error ?? `응답 ${res.status}`);
        }
        setData(body as Payload);
      } catch (e: unknown) {
        if (!alive) return;
        setData(null);
        setErr(e instanceof Error ? e.message : '불러오지 못했어요');
      }
    })();
    return () => {
      alive = false;
    };
  }, [symbol]);

  const dates = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.flow.map((f) => f.date))].sort().slice(-windowDays);
  }, [data, windowDays]);

  const types = useMemo(() => {
    if (!data) return [];
    const order = [
      'individual', 'foreign', 'institution_total', 'financial_investment', 'insurance',
      'investment_trust', 'private_fund', 'bank', 'other_finance', 'pension', 'other_corp', 'other_foreign',
    ];
    const present = new Set(data.flow.map((f) => f.investor_type));
    return order.filter((t) => present.has(t));
  }, [data]);

  const matrix = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    data?.flow.forEach((f) => {
      if (!m.has(f.date)) m.set(f.date, new Map());
      m.get(f.date)?.set(f.investor_type, Number(f.net_buy_qty));
    });
    return m;
  }, [data]);

  const cumulative = useMemo(() => {
    const acc: Record<string, number> = {};
    return dates.map((d) => {
      const row: Record<string, string | number> = { date: d.slice(5) };
      for (const t of types) {
        acc[t] = (acc[t] ?? 0) + (matrix.get(d)?.get(t) ?? 0);
        row[t] = acc[t];
      }
      return row;
    });
  }, [dates, types, matrix]);

  if (err) {
    return (
      <Shell>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">종목 정보를 불러오지 못했어요</h2>
              <p className="panel-desc">잠시 후 다시 시도해 주세요.</p>
            </div>
            <button onClick={() => window.location.reload()} className="btn btn-ghost shrink-0">
              다시 시도
            </button>
          </div>
          <div className="panel-body">
            <p className="sunken px-3 py-2 text-[12px] text-faint">{err}</p>
          </div>
        </section>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <div className="space-y-4">
          <div className="skel h-8 w-64" />
          <div className="panel grid grid-cols-2 divide-x divide-line md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="px-4 py-3.5">
                <div className="skel h-3 w-16" />
                <div className="skel mt-2 h-7 w-28" />
              </div>
            ))}
          </div>
          <div className="panel">
            <div className="panel-head"><div className="skel h-4 w-40" /></div>
            <div className="skel m-4 h-[460px]" />
          </div>
        </div>
      </Shell>
    );
  }

  const inst = data.instrument;
  const last = data.bars.at(-1);
  const prev = data.bars.at(-2);
  const change =
    last && prev && Number(prev.c) !== 0 ? ((Number(last.c) - Number(prev.c)) / Number(prev.c)) * 100 : null;

  return (
    <Shell>
      {/* 종목명·시세를 스크롤 내내 붙여 둔다. 아래로 다섯 개 패널이 이어지는데
          지금 어느 종목을 보고 있는지가 화면에서 사라지면 안 된다. */}
      <header className="sticky top-0 z-30 -mx-5 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-bg/95 px-5 py-2.5 backdrop-blur-sm">
        <Link href="/" className="btn btn-quiet !px-2 !py-1 !text-[12.5px]">
          ← 스크리너
        </Link>
        <h1 className="text-[17px] font-semibold tracking-[-0.012em]">{inst.name}</h1>
        <span className="num text-[12.5px] text-faint">{inst.symbol}</span>
        <span className="tag tag-mute">{inst.market}</span>
        {last && (
          <span className="ml-1 flex items-baseline gap-2">
            <span className="num text-[19px] font-medium tracking-[-0.02em]">{num(last.c)}</span>
            <span className={`num text-[13px] font-semibold ${(change ?? 0) >= 0 ? 'up' : 'down'}`}>
              {change === null ? '' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
            </span>
          </span>
        )}
        <div className="ml-auto">
          <SymbolSearch />
        </div>
      </header>

      <section className="panel mb-4 grid grid-cols-2 divide-x divide-line md:grid-cols-4">
        <Stat label="상장주식수" value={num(inst.listed_shares)} />
        <Stat label="최대주주등 소유" value={num(inst.major_holder_shares)} />
        <Stat label="자기주식" value={num(inst.treasury_shares)} />
        <Stat
          label="유통주식수"
          value={num(inst.free_float_shares)}
          badge={
            inst.free_float_basis === 'computed'
              ? { text: `실계산 ${inst.free_float_updated_at ?? ''}`, tone: 'emerald' }
              : { text: '상장주식수 기준', tone: 'amber' }
          }
        />
      </section>
      {inst.free_float_basis === 'listed_shares' && (
        <p className="mb-4 rounded-[var(--r-field)] bg-[var(--gold-soft)] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn">
          최대주주 소유분과 자기주식을 아직 확보하지 못해 <b>상장주식수를 유통주식수 대신</b> 쓰고 있어요.
          이 종목의 비율 지표는 실제보다 작게 나와요.
        </p>
      )}

      <section className="mb-4">
        <PriceChart
          symbol={symbol}
          bars={data.bars}
          patterns={data.patterns}
          flowMarkers={data.flowMarkers ?? []}
          supportLines={data.lines ?? []}
          investorLabels={data.investorLabels}
        />
      </section>

      <ProgramPanel data={data} />

      <section className="card mb-4">
        <div className="panel-head flex-wrap items-center gap-3">
          <h2 className="panel-title">투자자별 수급</h2>
          <div className="flex gap-1">
            {[1, 5, 20, 60].map((d) => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                className="chip"
                data-on={windowDays === d ? 'true' : 'false'}
              >
                {d}일
              </button>
            ))}
          </div>
          <span className="text-xs text-faint">
            출처 {[...new Set(data.flow.map((f) => f.source))].join(', ') || '없음'}
            {!types.includes('private_fund') && ' · 사모 세분은 현재 provider 가 제공하지 않습니다'}
          </span>
        </div>

        {cumulative.length > 0 && (
          <div className="h-64 px-2 pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cumulative}>
                <CartesianGrid stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} tickFormatter={(v) => nf.format(Number(v))} width={78} />
                <Tooltip formatter={(v) => nf.format(Number(v))} labelFormatter={(l) => `${l} 누적`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {types.map((t) => (
                  <Line
                    key={t}
                    type="monotone"
                    dataKey={t}
                    name={data.investorLabels[t] ?? t}
                    stroke={SERIES_COLOR[t] ?? '#64748b'}
                    dot={false}
                    strokeWidth={1.8}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-line-strong text-xs text-mute">
              <tr>
                <th className="px-3 py-2 text-left font-medium">일자</th>
                {types.map((t) => (
                  <th key={t} className="px-3 py-2 text-right font-medium">
                    {data.investorLabels[t] ?? t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {[...dates].reverse().map((d) => (
                <tr key={d} className="hover:bg-surface-2">
                  <td className="px-3 py-1.5 text-mute">{d}</td>
                  {types.map((t) => {
                    const v = matrix.get(d)?.get(t);
                    return (
                      <td
                        key={t}
                        className={`px-3 py-1.5 text-right tabular-nums ${
                          (v ?? 0) > 0 ? 'up' : (v ?? 0) < 0 ? 'down' : 'text-faint'
                        }`}
                      >
                        {v === undefined ? '-' : nf.format(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t-2 border-line bg-surface-2 font-semibold">
                <td className="px-3 py-2">{dates.length}일 누적</td>
                {types.map((t) => {
                  const sum = dates.reduce((a, d) => a + (matrix.get(d)?.get(t) ?? 0), 0);
                  return (
                    <td
                      key={t}
                      className={`px-3 py-2 text-right tabular-nums ${sum > 0 ? 'up' : 'down'}`}
                    >
                      {nf.format(sum)}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>

        {data.periods.length > 0 && (
          <div className="panel-body">
            <h3 className="mb-2 text-xs font-semibold text-mute">KRX CSV 기간합계</h3>
            <div className="flex flex-wrap gap-2">
              {data.periods.map((p) => (
                <span
                  key={`${p.start}-${p.investor_type}`}
                  className="input px-2 py-1 text-xs text-mute"
                >
                  {p.start}~{p.end} · {data.investorLabels[p.investor_type] ?? p.investor_type}{' '}
                  <b className={Number(p.net_buy_qty) > 0 ? 'up' : 'down'}>
                    {num(p.net_buy_qty)}
                  </b>{' '}
                  <span className="text-faint">({p.source})</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="panel-head panel-title">거래원별 (증권사 창구)</h2>
          {data.members.length === 0 ? (
            <p className="panel-body text-xs text-mute">
              아직 데이터가 없어요. 거래원별 수급은 KRX Data Marketplace 계약이 필요해요.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line-strong text-xs text-mute">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">일자</th>
                  <th className="px-3 py-2 text-left font-medium">회원사</th>
                  <th className="px-3 py-2 text-right font-medium">매수</th>
                  <th className="px-3 py-2 text-right font-medium">매도</th>
                  <th className="px-3 py-2 text-right font-medium">순매수</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {data.members.map((m, i) => (
                  <tr key={`${m.date}-${m.member_name}-${i}`}>
                    <td className="px-3 py-1.5 text-mute">{m.date}</td>
                    <td className="px-3 py-1.5">{m.member_name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num(m.buy_qty)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num(m.sell_qty)}</td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        Number(m.net_qty) > 0 ? 'up' : 'down'
                      }`}
                    >
                      {num(m.net_qty)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2 className="panel-head panel-title">
            임원 소유상황 변동 (거래일 기준)
          </h2>
          {data.insiders.length === 0 ? (
            <p className="panel-body text-xs text-mute">수집된 변동내역이 없어요.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line-strong text-xs text-mute">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">거래일</th>
                  <th className="px-3 py-2 text-left font-medium">공시일</th>
                  <th className="px-3 py-2 text-left font-medium">직위</th>
                  <th className="px-3 py-2 text-right font-medium">증감</th>
                  <th className="px-3 py-2 text-left font-medium">방법</th>
                  <th className="px-3 py-2 text-left font-medium">원문</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {data.insiders.map((r, i) => (
                  <tr key={`${r.rcept_no}-${i}`} className={r.is_open_market_buy ? 'bg-[var(--ok-soft)]' : ''}>
                    <td className="px-3 py-1.5">{r.trade_date ?? '-'}</td>
                    <td className="px-3 py-1.5 text-mute">{r.disclosed_at}</td>
                    <td className="px-3 py-1.5">{r.position ?? '-'}</td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        Number(r.change_qty) > 0 ? 'up' : 'down'
                      }`}
                    >
                      {num(r.change_qty)}
                    </td>
                    <td className="px-3 py-1.5">
                      {r.method ?? '-'}
                      {r.is_open_market_buy && (
                        <span className="ml-1.5 rounded tag tag-ok">
                          장내매수
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <a
                        href={r.dartUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-mute underline"
                      >
                        DART
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {data.patterns.length > 0 && (
        <section className="card mt-4">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">패턴 판정 근거</h2>
              <p className="panel-desc">점수가 어떻게 나왔는지 항목별로 보여줘요</p>
            </div>
          </div>
          <div className="panel-body space-y-2">
            {data.patterns.map((p) => (
              <PatternEvidence key={`${p.pattern}-${p.date ?? ''}`} p={p} />
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}

/**
 * 프로그램매매 · 프로그램 제외 외국인 물량 패널.
 *
 * 분봉 프로그램 데이터는 장중에만 채워진다(KIS 실시간). 비어 있으면 그 사실을 그대로 알린다.
 * 프로그램 제외 외국인 = 외국인 순매수 − 프로그램 순매수 (근사치임을 명시한다).
 */
function ProgramPanel({ data }: { data: Payload }) {
  const minute = data.minute ?? [];
  const programDaily = data.programDaily ?? [];
  const inst = data.instrument;
  const floatShares = Number(inst.free_float_shares ?? 0);

  // 일별: 외국인 순매수 vs 프로그램 순매수
  const foreignByDate = new Map<string, number>();
  for (const f of data.flow) if (f.investor_type === 'foreign') foreignByDate.set(f.date, Number(f.net_buy_qty));

  const avgTv =
    data.bars.length > 1
      ? data.bars.slice(-21, -1).reduce((a, b) => a + Number(b.traded_value ?? 0), 0) / Math.max(1, data.bars.slice(-21, -1).length)
      : 0;

  const rows = programDaily.slice(0, 10).map((p) => {
    const pgmNet = Number(p.net_qty);
    const frgn = foreignByDate.get(p.date) ?? null;
    const exProgram = frgn === null ? null : frgn - pgmNet;
    const bar = data.bars.find((b) => b.date === p.date);
    const price = bar ? Number(bar.c) : 0;
    return {
      date: p.date,
      pgmNet,
      pgmAmt: Number(p.net_amt),
      frgn,
      exProgram,
      exFloatPct: exProgram !== null && floatShares > 0 ? (exProgram / floatShares) * 100 : null,
      exAmount: exProgram !== null ? exProgram * price : null,
      tvRatio: bar && avgTv > 0 ? (Number(bar.traded_value ?? 0) / avgTv - 1) * 100 : null,
    };
  });

  const minuteChart = minute.map((m) => ({
    t: m.ts.slice(11, 16),
    net: Number(m.pgm_net ?? 0),
    price: Number(m.c),
  }));

  return (
    <section className="card mb-4">
      <div className="flex flex-wrap items-center panel-head flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">프로그램매매 · 프로그램 제외 외국인</h2>
        <span className="text-xs text-faint">
          프로그램 제외 외국인 = 외국인 순매수 − 프로그램 순매수 (근사치)
        </span>
      </div>

      {minuteChart.length > 0 ? (
        <div className="h-56 px-2 pt-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={minuteChart}>
              <CartesianGrid stroke="var(--border)" />
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--fg-muted)' }} minTickGap={24} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--fg-muted)' }} tickFormatter={(v) => nf.format(Number(v))} width={76} />
              <Tooltip formatter={(v) => nf.format(Number(v))} labelFormatter={(l) => `${l} 프로그램 순매수`} />
              <Bar dataKey="net" isAnimationActive={false}>
                {minuteChart.map((m, i) => (
                  <Cell key={i} fill={m.net >= 0 ? 'var(--up)' : 'var(--down)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="panel-body text-xs text-mute">
          분봉 프로그램매매 데이터가 없어요. KIS가 장중에만 내려주는 데이터라 09:00~15:30 사이에{' '}
          <code className="rounded bg-surface-3 px-1">npm run batch -- minute</code> 로 수집해 주세요.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b border-line-strong text-xs text-mute">
            <tr>
              <th className="px-3 py-2 text-left font-medium">일자</th>
              <th className="px-3 py-2 text-right font-medium">프로그램 순매수</th>
              <th className="px-3 py-2 text-right font-medium">외국인 순매수</th>
              <th className="px-3 py-2 text-right font-medium">프로그램 제외 외국인</th>
              <th className="px-3 py-2 text-right font-medium">유통 대비</th>
              <th className="px-3 py-2 text-right font-medium">금액</th>
              <th className="px-3 py-2 text-right font-medium">거래대금 평소 대비</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-xs text-mute">
                  프로그램매매 일별 데이터가 없어요. <code className="rounded bg-surface-3 px-1">npm run batch -- program</code> 로 수집해 주세요.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.date} className="hover:bg-surface-2">
                <td className="px-3 py-1.5 text-mute">{r.date}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${r.pgmNet >= 0 ? 'up' : 'down'}`}>
                  {num(r.pgmNet)}
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${(r.frgn ?? 0) >= 0 ? 'up' : 'down'}`}>
                  {r.frgn === null ? '-' : num(r.frgn)}
                </td>
                <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${(r.exProgram ?? 0) >= 0 ? 'up' : 'down'}`}>
                  {r.exProgram === null ? '-' : num(r.exProgram)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.exFloatPct === null ? '-' : `${r.exFloatPct.toFixed(3)}%`}
                  {inst.free_float_basis === 'listed_shares' && r.exFloatPct !== null && (
                    <span className="ml-1 rounded tag tag-warn">상장 기준</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.exAmount === null ? '-' : `${Math.round(r.exAmount / 1e8).toLocaleString()}억`}
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${(r.tvRatio ?? 0) >= 0 ? 'up' : 'down'}`}>
                  {r.tvRatio === null ? '-' : `${r.tvRatio >= 0 ? '+' : ''}${r.tvRatio.toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * 패턴 근거 한 건.
 *
 * 예전에는 evidence JSON 을 통째로 <pre> 에 부어 놨다. 개발용 출력이지 제품 화면이 아니고,
 * 이름표도 두 패턴만 맞고 나머지 14종은 전부 "컵앤핸들"로 잘못 찍혔다.
 * 판정에 실제로 쓰인 값만 한국어 이름으로 세워 보여 주고, 원본은 접어 둔다.
 */
const EV_KO: Array<[key: string, ko: string, fmt: (v: number) => string]> = [
  ['breakoutVolumeRatio', '돌파봉 거래량', (v) => `평소의 ${v.toFixed(2)}배`],
  ['formationVolumeRatio', '형성 중 거래량', (v) => `전반부의 ${v.toFixed(2)}배`],
  ['distancePct', '돌파선까지', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`],
  ['pivotPrice', '돌파선', (v) => nfmt(v)],
  ['barsSinceBreakout', '돌파 후', (v) => `${v}거래일`],
  ['barsSinceFormed', '완성 후', (v) => `${v}거래일`],
  ['freshness', '최신성 계수', (v) => v.toFixed(2)],
];
const nfmt = (v: number) => new Intl.NumberFormat('ko-KR').format(Math.round(v));

function PatternEvidence({ p }: { p: PatternInfo }) {
  const ev = p.evidence ?? {};
  const rows = EV_KO.map(([key, ko, fmt]) => {
    const raw = ev[key];
    const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(v) ? { ko, text: fmt(v), key } : null;
  }).filter((r) => r !== null);

  const stage = typeof ev.stage === 'string' ? ev.stage : p.stage;
  const heavy = Number(ev.breakoutVolumeRatio ?? 0) >= 1.5;

  return (
    <div className="sunken px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[13px] font-semibold">{PATTERN_KO[p.pattern] ?? p.pattern}</span>
        {stage && <span className="tag tag-mute">{STAGE_KO[stage] ?? stage}</span>}
        {heavy && <span className="tag tag-up">거래량 실림</span>}
        <span className="num ml-auto text-[13px] font-semibold">{Number(p.score).toFixed(0)}점</span>
      </div>
      {rows.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {rows.map((r) => (
            <div key={r.key} className="flex items-baseline justify-between gap-2">
              <dt className="text-[11.5px] text-faint">{r.ko}</dt>
              <dd className="num text-[12px] text-fg">{r.text}</dd>
            </div>
          ))}
        </dl>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11.5px] text-faint">원본 값</summary>
        <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[var(--r-field)] bg-bg p-2.5 text-[11px] text-mute">
          {JSON.stringify(p.evidence, null, 2)}
        </pre>
      </details>
    </div>
  );
}

const STAGE_KO: Record<string, string> = {
  forming: '형성중',
  near_pivot: '돌파선 부근',
  breakout: '돌파',
  pullback: '눌림목',
  failed: '돌파 실패',
};

function Shell({ children }: { children: React.ReactNode }) {
  // 지면은 s0 다. 예전에는 s2 라 카드(s1)가 지면보다 어두워, 테두리를 걷어낸 뒤로는
  // 카드가 배경에 파묻혀 경계가 뒤집혀 보였다.
  return (
    <main className="min-h-screen bg-bg text-fg">
      <div className="mx-auto max-w-[1500px] px-5 pb-10">{children}</div>
    </main>
  );
}

function Stat({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: { text: string; tone: 'emerald' | 'amber' };
}) {
  return (
    <div className="px-4 py-3.5">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mt-1.5">{value}</div>
      {badge && (
        <span
          className={`mt-2 ${badge.tone === 'emerald' ? 'tag tag-violet' : 'tag tag-warn'}`}
        >
          {badge.text}
        </span>
      )}
    </div>
  );
}
