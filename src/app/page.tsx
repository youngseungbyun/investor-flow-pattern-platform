'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { MagnifyingGlass, Moon, Plus, Sun, X } from '@phosphor-icons/react/dist/ssr';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import NumberTicker from '@/components/NumberTicker';

/* ══════════════════════════ 타입 ══════════════════════════ */

type Direction = 'bullish' | 'bearish' | 'neutral';
type Stage = 'forming' | 'near_pivot' | 'breakout' | 'pullback' | 'failed';

interface Catalog {
  investors: Array<{ id: string; ko: string; group: string }>;
  patterns: Array<{ id: string; ko: string; direction: Direction; kind: string }>;
  stages: Array<{ id: string; ko: string }>;
  lineSignals: Array<{ id: string; ko: string }>;
  metrics: Array<{ id: string; ko: string }>;
  kis: { configured: boolean; paper: boolean; ratePerSec: number };
  defaultRule: RuleBody;
}

interface FlowCondition {
  investorType: string;
  side: 'buy' | 'sell';
  metric: string;
  op: '>=' | '<=';
  value: number;
  scope: 'recent' | 'pattern_window';
  windowDays: number;
  agg: 'sum' | 'daily_max';
}

interface RuleBody {
  market: string;
  minTradedValue: number;
  flow: FlowCondition[];
  pattern?: { patterns?: string[]; directions?: Direction[]; stages?: Stage[]; minScore?: number };
  line?: { signals?: string[]; minScore?: number };
  limit: number;
  sortBy: 'flow' | 'score' | 'traded_value';
}

interface RuleRow {
  symbol: string; name: string; market: string;
  close: number | null; changePct: number | null; tradedValue: number | null;
  floatShares: number | null; floatBasis: 'computed' | 'listed_shares';
  flows: Array<{ label: string; metric: string; value: number; onDate: string | null }>;
  patterns: Array<{ pattern: string; ko: string; direction: Direction; stage: Stage; stageKo: string; score: number; pivotPrice: number | null; distancePct: number | null }>;
  lines: Array<{ signal: string; score: number; detail: Record<string, unknown> }>;
  insiderBuys: number;
  rank: number;
}

interface Status {
  runs: Array<{ date: string; step: string; status: string; row_count: number; ran_at: string }>;
  counts: Record<string, string | null>;
  providers: Array<{ id: string; label: string; covers: string[] }>;
  overall: string;
}

/* ══════════════════════════ 포맷 ══════════════════════════ */

const nf = new Intl.NumberFormat('ko-KR');
const num = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? '-' : nf.format(Math.round(v));
const won = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '-';
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e12) return `${s}${(a / 1e12).toFixed(2)}조`;
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(0)}억`;
  return nf.format(v);
};
const signed = (v: number, digits = 2, unit = '%') =>
  `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${unit}`;

const DIR_TAG: Record<Direction, string> = {
  bullish: 'tag tag-up',
  bearish: 'tag tag-down',
  neutral: 'tag tag-mute',
};
const DIR_TEXT: Record<Direction, string> = { bullish: 'up', bearish: 'down', neutral: 'text-mute' };
const DIR_KO: Record<Direction, string> = { bullish: '상승', bearish: '하락', neutral: '중립' };
const DIR_TONE: Record<Direction, string> = { bullish: 'up', bearish: 'down', neutral: 'neutral' };
// 단계도 시세 방향과 같은 색축에 얹는다. 돌파=상승 확정(적, 채움),
// 눌림목=상승 계열이나 미확정(적, 테두리만), 넥라인 부근=주목(앰버),
// 형성중=무채색, 실패=하락(청). 앰버는 "아직 아님"에만 쓴다.
const STAGE_TAG: Record<string, string> = {
  near_pivot: 'tag tag-warn',
  breakout: 'tag tag-up',
  pullback: 'tag tag-ok',
  forming: 'tag tag-mute',
  failed: 'tag tag-down',
};

/* ══════════════════════════ 아이콘 (SVG, 이모지 금지) ══════════════════════════ */

// 아이콘은 Phosphor 한 벌만 쓴다. weight·크기를 한 곳에서 맞춘다.
const ICON = { size: 15, weight: 'bold' } as const;
const Icon = {
  sun: <Sun size={16} weight="bold" />,
  moon: <Moon size={16} weight="bold" />,
  plus: <Plus {...ICON} />,
  x: <X {...ICON} />,
  search: <MagnifyingGlass {...ICON} />,
};

/* ══════════════════════════ 페이지 ══════════════════════════ */

type Tab = 'flow' | 'pattern' | 'line';
const TABS: Array<{ id: Tab; ko: string; desc: string }> = [
  { id: 'flow', ko: '수급분석', desc: '주체별 수급을 패턴·위치와 조합해 조건 검색' },
  { id: 'pattern', ko: '패턴분석', desc: '상승·하락 패턴 16종과 현재 단계' },
  { id: 'line', ko: '라인분석', desc: '거래량 돌파 눌림목 · 이평선 지지' },
];

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>('flow');
  const [status, setStatus] = useState<Status | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [date, setDate] = useState('');
  // 기간 모드. 비어 있으면 단일 기준일, 채우면 [fromDate, date] 범위로 검색한다.
  const [fromDate, setFromDate] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'pattern' || t === 'line' || t === 'flow') setTab(t);
    setTheme((document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark');
  }, []);

  const goTab = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u.toString());
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('sd-theme', next); } catch { /* 사파리 프라이빗 모드 */ }
  };

  useEffect(() => {
    // 서버가 500 을 줘도 본문이 JSON 이면 파싱은 성공한다.
    // 상태코드와 error 필드를 함께 봐야 잘못된 값이 state 로 들어가지 않는다.
    const load = async <T,>(path: string): Promise<T> => {
      const res = await fetch(path);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || typeof body.error === 'string') {
        throw new Error(body?.error ?? `${path} 응답 ${res.status}`);
      }
      return body as T;
    };

    void Promise.all([load<Status>('/api/status'), load<Catalog>('/api/catalog')])
      .then(([st, cat]) => {
        setStatus(st);
        setCatalog(cat);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        setStatus(null);
        setCatalog(null);
        setLoadError(e instanceof Error ? e.message : '데이터를 불러오지 못했어요');
      });
  }, []);

  const lastDay = String(status?.counts?.last_trading_day ?? '');
  useEffect(() => { if (lastDay && !date) setDate(lastDay); }, [lastDay, date]);

  return (
    <main className="min-h-screen">
      {/* 제목·탭·기준일을 한 줄에 둔다. 헤더가 세 줄이면 시세면이 그만큼 밀린다.
          블러 유리 대신 불투명 지면 + 1px 괘선으로 고정 영역을 표시한다. */}
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center gap-x-5 gap-y-1 px-5 pt-2.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.012em]">수급·패턴 분석</h1>

          <nav className="-mb-px flex" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => goTab(t.id)}
                title={t.desc}
                className={`cursor-pointer border-b-2 px-3.5 pb-2 pt-1 text-[13px] font-semibold transition-colors ${
                  tab === t.id
                    ? 'border-accent text-fg'
                    : 'border-transparent text-faint hover:text-mute'
                }`}
              >
                {t.ko}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 pb-1.5">
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              기준일
              {fromDate !== '' && (
                <>
                  <input
                    type="date"
                    value={fromDate}
                    max={date || undefined}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="input"
                    aria-label="시작일"
                  />
                  <span className="text-faint">~</span>
                </>
              )}
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" aria-label="종료일" />
            </label>
            <button
              onClick={() => {
                if (fromDate) { setFromDate(''); return; }
                // 기간 모드 진입: 기본 4주 전을 시작점으로 잡는다
                const d = new Date(date || Date.now());
                d.setDate(d.getDate() - 28);
                setFromDate(d.toISOString().slice(0, 10));
              }}
              className="chip"
              data-on={fromDate ? 'true' : 'false'}
              title="기준일을 기간으로 바꿔요"
            >
              기간
            </button>
            <button
              onClick={toggleTheme}
              className="btn btn-ghost !px-2"
              aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
            >
              {theme === 'dark' ? Icon.sun : Icon.moon}
            </button>
          </div>
        </div>

      </header>

      <div className="mx-auto max-w-[1720px] space-y-4 px-5 py-5">
        {loadError ? <LoadError message={loadError} /> : <KpiRow status={status} catalog={catalog} />}
        {loadError ? null : !date || !catalog ? (
          <Skeleton />
        ) : tab === 'flow' ? (
          <FlowTab date={date} fromDate={fromDate} catalog={catalog} status={status} />
        ) : tab === 'pattern' ? (
          <PatternTab date={date} fromDate={fromDate} catalog={catalog} />
        ) : (
          <LineTab date={date} fromDate={fromDate} catalog={catalog} />
        )}
      </div>

      <footer className="mx-auto max-w-[1720px] px-5 pb-8 pt-2 text-[11px] leading-relaxed text-faint">
        수집한 데이터의 사실과 순위만 보여줘요. 종목 추천이 아니며, 투자 판단과 책임은 이용자 본인에게 있어요.
      </footer>
    </main>
  );
}

/* ══════════════════════ 상단 상태 스트립 ══════════════════════ */

interface SeriesRow {
  date: string;
  individual?: number;
  foreign?: number;
  institution_total?: number;
}

/** 종목 상세와 같은 색 규약: 개인 적, 외국인 청, 기관 녹. */
const PULSE_SERIES = [
  { key: 'individual', ko: '개인', color: 'var(--up)' },
  { key: 'foreign', ko: '외국인', color: 'var(--down)' },
  { key: 'institution_total', ko: '기관', color: 'var(--ok)' },
] as const;

function KpiRow({ status, catalog }: { status: Status | null; catalog: Catalog | null }) {
  const [series, setSeries] = useState<SeriesRow[] | null>(null);
  useEffect(() => {
    fetch('/api/series').then((r) => r.json()).then((d) => setSeries(d.rows ?? [])).catch(() => setSeries([]));
  }, []);

  if (!status?.runs || !status.counts) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
        <div className="panel p-4">
          <div className="skel h-3 w-24" />
          <div className="skel mt-3 h-[260px] w-full" />
        </div>
        <div className="grid grid-rows-2 gap-3">
          <div className="panel p-4"><div className="skel h-3 w-16" /><div className="skel mt-2.5 h-7 w-28" /></div>
          <div className="panel p-4"><div className="skel h-3 w-16" /><div className="skel mt-2.5 h-7 w-28" /></div>
        </div>
      </div>
    );
  }

  const latest = status.runs[0];
  const failed = status.runs.filter((r) => r.status === 'failed');
  const n = (k: string) => Number(status.counts[k] ?? 0);

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
        {/* 시장 수급 미니 차트. 오늘 시장에 누가 사고 있는지가 첫 화면의 답이어야 한다. */}
        <div className="panel flex flex-col p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="kpi-label">시장 수급 30일</span>
            <span className="flex items-center gap-3 text-[11.5px] text-mute">
              {PULSE_SERIES.map((sr) => (
                <span key={sr.key} className="flex items-center gap-1.5">
                  <span className="inline-block h-[2px] w-3.5" style={{ background: sr.color }} aria-hidden />
                  {sr.ko}
                </span>
              ))}
            </span>
          </div>
          <div className="mt-3 h-[260px]">
            {series === null ? (
              <div className="skel h-full w-full" />
            ) : series.length === 0 ? (
              <p className="flex h-full items-center text-[12.5px] text-faint">
                수급 데이터가 아직 없어요. 장 마감 후 수집하면 여기에 흐름이 그려져요.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    {PULSE_SERIES.map((sr) => (
                      <linearGradient key={sr.key} id={`pulse-${sr.key}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={sr.color} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={sr.color} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10.5, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false} minTickGap={28} />
                  <YAxis tick={{ fontSize: 10.5, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false} width={40}
                         tickFormatter={(v) => {
                           const x = Number(v);
                           if (x === 0) return '0';
                           return Math.abs(x) >= 10000 ? `${(x / 10000).toFixed(1).replace(/\.0$/, '')}조` : `${nf.format(x)}억`;
                         }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--s1)', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--fg-2)' }}
                    formatter={(v, name) => {
                      const meta = PULSE_SERIES.find((sr) => sr.key === String(name));
                      return [`${nf.format(Number(v ?? 0))}억`, meta?.ko ?? String(name)];
                    }}
                  />
                  {PULSE_SERIES.map((sr) => (
                    <Area key={sr.key} type="monotone" dataKey={sr.key} stroke={sr.color} strokeWidth={1.5}
                          fill={`url(#pulse-${sr.key})`} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="grid grid-rows-2 gap-3">
          <div className="panel p-4 transition-colors hover:border-line-strong">
            <div className="kpi-label">투자자 수급</div>
            <div className="kpi-value mt-1.5">
              <NumberTicker value={n('flow_daily')} />
              <span className="ml-1 text-[15px] text-mute">행</span>
            </div>
            <div className="mt-1.5 text-[12px] text-faint">최근 거래일 {status.counts.last_trading_day ?? '-'}</div>
          </div>
          <div className="panel p-4 transition-colors hover:border-line-strong">
            <div className="kpi-label">패턴 적중</div>
            <div className="kpi-value mt-1.5">
              <NumberTicker value={n('patterns')} />
              <span className="ml-1 text-[15px] text-mute">건</span>
            </div>
            <div className="mt-1.5 text-[12px] text-faint">돌파 확정 {num(n('patterns_confirmed'))}건</div>
          </div>
        </div>
      </div>

      {/* 운영 메타는 결정에 쓰는 숫자가 아니라 상태다. 한 줄로 낮춰 둔다. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-faint">
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block size-1.5 rounded-full ${
              status.overall === 'ok' ? 'bg-ok' : status.overall === 'partial' ? 'bg-warn' : 'bg-faint'
            }`}
            aria-hidden
          />
          마지막 수집 {latest ? `${latest.date} ${latest.ran_at.slice(11)}` : '없음'}
        </span>
        <span>일봉 {num(n('ohlcv'))}행</span>
        <span>종목 {num(n('instruments'))}개</span>
        <span>유통주식수 실계산 {num(n('float_computed'))}종목</span>
        {/* 배포본에는 수집용 키가 없다. 키 유무가 아니라 실제 적재된 출처를 보여준다. */}
        <span>수급 원천 {status.counts.flow_source || '없음'}</span>
        {failed.length > 0 && <span className="text-warn">수집 실패 {failed.map((f) => f.step).join(', ')}</span>}
      </div>
    </section>
  );
}

function LoadError({ message }: { message: string }) {
  const dbDown = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect /i.test(message);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">데이터를 불러오지 못했어요</h2>
          <p className="panel-desc">
            {dbDown
              ? '데이터베이스에 연결할 수 없어요. 서버 설정을 확인해 주세요.'
              : '잠시 후 다시 시도해 주세요.'}
          </p>
        </div>
        <button onClick={() => window.location.reload()} className="btn btn-ghost shrink-0">
          다시 시도
        </button>
      </div>
      <div className="panel-body">
        <p className="sunken px-3 py-2 text-[12px] text-faint">{message}</p>
      </div>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="panel">
        <div className="panel-head">
          <div className="skel h-4 w-32" />
        </div>
        <div className="panel-body space-y-2.5">
          <div className="skel h-8 w-full" />
          <div className="skel h-8 w-3/4" />
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <div className="skel h-4 w-24" />
        </div>
        <div className="panel-body space-y-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skel h-7 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════ 공용 조각 ══════════════════════ */

function Chip({
  on, onClick, children, tone,
}: { on?: boolean; onClick?: () => void; children: React.ReactNode; tone?: string }) {
  return (
    <button type="button" onClick={onClick} className="chip" data-on={on ? 'true' : 'false'} data-tone={tone}>
      {children}
    </button>
  );
}

function Card({ title, sub, right, children }: { title?: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-head">
          <div>
            <h2 className="panel-title">{title}</h2>
            {sub && <p className="panel-desc">{sub}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={12} className="l !text-center">
        <div className="px-4 py-16 text-[13px] text-faint">{children}</div>
      </td>
    </tr>
  );
}

function PatternTags({
  patterns,
}: { patterns: Array<{ pattern: string; ko: string; direction: Direction; stage: Stage; stageKo?: string; score: number }> }) {
  if (!patterns?.length) return <span className="text-faint">-</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {patterns.slice(0, 3).map((p) => (
        <span key={p.pattern} className={DIR_TAG[p.direction]}>
          {p.ko}
          <span className={`${STAGE_TAG[p.stage] ?? 'tag tag-mute'} !px-1 !py-0`}>{p.stageKo ?? p.stage}</span>
          <span className="num opacity-60">{Math.round(p.score)}</span>
        </span>
      ))}
      {patterns.length > 3 && <span className="tag tag-mute">+{patterns.length - 3}</span>}
    </div>
  );
}

function FloatCell({ shares, basis }: { shares: number | null; basis: string }) {
  return (
    <>
      <span className="num">{num(shares)}</span>
      {basis === 'listed_shares' && <span className="tag tag-warn ml-1.5">상장 기준</span>}
    </>
  );
}

function SymbolCell({ row }: { row: { symbol: string; name: string; market: string; rank?: number } }) {
  return (
    <>
      {row.rank !== undefined && <span className="num mr-2 inline-block w-6 text-right text-[12px] text-faint">{row.rank}</span>}
      <Link href={`/stock/${row.symbol}`} className="font-semibold text-fg hover:text-accent hover:underline">
        {row.name}
      </Link>
      <span className="num ml-1.5 text-[12px] text-faint">{row.symbol}</span>
      <span className="tag tag-mute ml-1.5">{row.market}</span>
    </>
  );
}

/* ══════════════════════ 1. 수급분석 ══════════════════════ */

function FlowTab({ date, fromDate, catalog, status }: { date: string; fromDate?: string; catalog: Catalog; status: Status | null }) {
  const [rule, setRule] = useState<RuleBody>(() => ({ ...catalog.defaultRule }));
  const [rows, setRows] = useState<RuleRow[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      // 기간 모드면 수급 관찰 창(windowDays)을 그 기간의 거래일 수로 덮어쓴다.
      const winFromRange = fromDate
        ? Math.max(1, Math.round(((new Date(date).getTime() - new Date(fromDate).getTime()) / 86_400_000) * 0.7))
        : null;
      const body = winFromRange
        ? { ...rule, date, flow: rule.flow.map((f) => ({ ...f, windowDays: winFromRange })) }
        : { ...rule, date };
      const res = await fetch('/api/rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      setRows(j.rows ?? []);
      setNotes(j.notes ?? (j.error ? [j.error] : []));
      setSources(j.sources ?? []);
    } finally {
      setLoading(false);
    }
  }, [rule, date, fromDate]);

  useEffect(() => { void run(); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFlow = (i: number, patch: Partial<FlowCondition>) =>
    setRule((r) => ({ ...r, flow: r.flow.map((f, j) => (i === j ? { ...f, ...patch } : f)) }));
  const addFlow = () =>
    setRule((r) => ({
      ...r,
      flow: [...r.flow, { investorType: 'individual', side: 'sell', metric: 'float_pct', op: '>=', value: 0.5, scope: 'recent', windowDays: 5, agg: 'sum' }],
    }));
  const delFlow = (i: number) => setRule((r) => ({ ...r, flow: r.flow.filter((_, j) => j !== i) }));
  const toggleIn = (list: string[] | undefined, id: string) =>
    (list ?? []).includes(id) ? (list ?? []).filter((x) => x !== id) : [...(list ?? []), id];

  const investorGroups = useMemo(() => {
    const g = new Map<string, Catalog['investors']>();
    for (const iv of catalog.investors) {
      const list = g.get(iv.group) ?? [];
      list.push(iv);
      g.set(iv.group, list);
    }
    return [...g.entries()];
  }, [catalog.investors]);

  const metricUnit = (m: string) => (m === 'float_pct' ? '%' : m === 'turnover_x' ? '배' : m === 'amount' ? '원' : '주');
  const fmtFlow = (metric: string, v: number) =>
    metric === 'float_pct' ? `${v.toFixed(3)}%` : metric === 'turnover_x' ? `${v.toFixed(2)}배` : metric === 'amount' ? won(v) : num(v);

  return (
    <div className="space-y-4">
      <Card
        title="조건 검색"
        sub="수급, 패턴 위치, 라인 시그널을 겹쳐서 걸러요"
        right={
          <button onClick={() => void run()} className="btn btn-beam" disabled={loading}>
            {Icon.search}
            {loading ? '찾는 중' : '검색'}
          </button>
        }
      >
        <div className="panel-body space-y-2.5">
          {/* 수급 조건 */}
          <div className="space-y-1.5">
            {rule.flow.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 glass-inset px-2.5 py-2">
                <span className={`tag ${i === 0 ? 'tag-violet' : 'tag-mute'} font-semibold`}>
                  {i === 0 ? '수급' : 'AND'}
                </span>
                <select value={f.investorType} onChange={(e) => setFlow(i, { investorType: e.target.value })} className="input">
                  {investorGroups.map(([g, list]) => (
                    <optgroup key={g} label={g}>
                      {list.map((iv) => <option key={iv.id} value={iv.id}>{iv.ko}</option>)}
                    </optgroup>
                  ))}
                </select>
                <select value={f.side} onChange={(e) => setFlow(i, { side: e.target.value as 'buy' | 'sell' })} className="input">
                  <option value="buy">순매수</option>
                  <option value="sell">순매도</option>
                </select>
                <select value={f.metric} onChange={(e) => setFlow(i, { metric: e.target.value })} className="input">
                  {catalog.metrics.map((m) => <option key={m.id} value={m.id}>{m.ko}</option>)}
                </select>
                <select value={f.op} onChange={(e) => setFlow(i, { op: e.target.value as '>=' | '<=' })} className="input">
                  <option value=">=">이상</option>
                  <option value="<=">이하</option>
                </select>
                <div className="flex items-center gap-1">
                  <input type="number" step="0.1" value={f.value} onChange={(e) => setFlow(i, { value: Number(e.target.value) })} className="input num w-20" />
                  <span className="text-[12px] text-faint">{metricUnit(f.metric)}</span>
                </div>
                <select value={f.scope} onChange={(e) => setFlow(i, { scope: e.target.value as FlowCondition['scope'] })} className="input">
                  <option value="pattern_window">패턴 기간 중</option>
                  <option value="recent">최근 N거래일</option>
                </select>
                {f.scope === 'recent' && (
                  <input type="number" min={1} max={60} value={f.windowDays} onChange={(e) => setFlow(i, { windowDays: Number(e.target.value) })} className="input num w-14" />
                )}
                <select value={f.agg} onChange={(e) => setFlow(i, { agg: e.target.value as FlowCondition['agg'] })} className="input">
                  <option value="daily_max">하루 최대</option>
                  <option value="sum">기간 합계</option>
                </select>
                {rule.flow.length > 1 && (
                  <button onClick={() => delFlow(i)} className="btn btn-ghost ml-auto !px-1.5" aria-label={`${i + 1}번 조건 삭제`}>
                    {Icon.x}
                  </button>
                )}
              </div>
            ))}
            <button onClick={addFlow} className="btn btn-ghost !px-2.5 !py-1.5 !text-[12.5px] !font-medium">
              {Icon.plus} 조건 추가
            </button>
          </div>

          {/* 패턴 조건 */}
          <div className="glass-inset px-2.5 py-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="tag tag-violet font-semibold">패턴</span>
              <span className="text-[12px] text-faint">비워 두면 수급 조건만으로 찾아요</span>
            </div>
            <div className="mb-1.5 flex flex-wrap gap-1">
              {catalog.patterns.map((p) => (
                <Chip
                  key={p.id}
                  on={rule.pattern?.patterns?.includes(p.id)}
                  tone={DIR_TONE[p.direction]}
                  onClick={() => setRule((r) => ({ ...r, pattern: { ...r.pattern, patterns: toggleIn(r.pattern?.patterns, p.id) } }))}
                >
                  {p.ko}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[12px] text-faint">현재 단계</span>
              {catalog.stages.map((s) => (
                <Chip
                  key={s.id}
                  on={rule.pattern?.stages?.includes(s.id as Stage)}
                  onClick={() => setRule((r) => ({ ...r, pattern: { ...r.pattern, stages: toggleIn(r.pattern?.stages, s.id) as Stage[] } }))}
                >
                  {s.ko}
                </Chip>
              ))}
              <label className="ml-3 flex items-center gap-2 text-[12px] text-faint">
                최소 점수 <span className="num w-6 text-fg">{rule.pattern?.minScore ?? 0}</span>
                <input
                  type="range" min={0} max={100} value={rule.pattern?.minScore ?? 0}
                  onChange={(e) => setRule((r) => ({ ...r, pattern: { ...r.pattern, minScore: Number(e.target.value) } }))}
                  className="w-28 cursor-pointer accent-[var(--accent)]"
                />
              </label>
            </div>
          </div>

          {/* 라인 + 공통 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 glass-inset px-2.5 py-2">
            <span className="tag tag-violet font-semibold">라인</span>
            {catalog.lineSignals.map((s) => (
              <Chip
                key={s.id}
                on={rule.line?.signals?.includes(s.id)}
                onClick={() => setRule((r) => ({ ...r, line: { ...r.line, signals: toggleIn(r.line?.signals, s.id) } }))}
              >
                {s.ko}
              </Chip>
            ))}
            <span className="ml-3 text-[12px] text-faint">시장</span>
            <select value={rule.market} onChange={(e) => setRule((r) => ({ ...r, market: e.target.value }))} className="input">
              <option value="ALL">전체</option>
              <option value="KOSPI">KOSPI</option>
              <option value="KOSDAQ">KOSDAQ</option>
            </select>
            <span className="text-[12px] text-faint">최소 거래대금</span>
            <select value={rule.minTradedValue} onChange={(e) => setRule((r) => ({ ...r, minTradedValue: Number(e.target.value) }))} className="input">
              <option value={0}>제한 없음</option>
              <option value={100_000_000}>1억</option>
              <option value={1_000_000_000}>10억</option>
              <option value={5_000_000_000}>50억</option>
              <option value={10_000_000_000}>100억</option>
            </select>
            <span className="text-[12px] text-faint">정렬</span>
            <select value={rule.sortBy} onChange={(e) => setRule((r) => ({ ...r, sortBy: e.target.value as RuleBody['sortBy'] }))} className="input">
              <option value="flow">수급 강도</option>
              <option value="score">패턴 점수</option>
              <option value="traded_value">거래대금</option>
            </select>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line bg-surface-2 px-4 py-2.5 text-[12px] text-mute">
        <span><span className="text-faint">찾은 종목</span> <b className="num text-fg">{rows?.length ?? 0}</b>종목</span>
        <span><span className="text-faint">수급 출처</span> <span className="text-fg">{sources.join(', ') || '없음'}</span></span>
        <span><span className="text-faint">수집 경로</span> <span className="text-fg">{status?.providers.map((p) => p.id).join(' → ') || '없음'}</span></span>
        {notes.map((n) => <span key={n} className="text-warn">{n}</span>)}
      </div>

      <Card>
        <div className="scroll-x">
          <table className="tbl min-w-[1300px]">
            <thead>
              <tr>
                <th className="l">종목</th>
                <th className="l">충족한 수급 조건</th>
                <th>유통주식수</th>
                <th>종가</th>
                <th>등락률</th>
                <th>거래대금</th>
                <th className="l">패턴 · 단계</th>
                <th className="l">라인</th>
                <th>내부자</th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && (
                <Empty>조건에 맞는 종목이 없어요. 임계값을 낮추거나 단계를 넓혀 보세요.</Empty>
              )}
              {rows?.map((r, i) => (
                <tr key={r.symbol} className="rise" style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
                  <td className="l"><SymbolCell row={r} /></td>
                  <td className="l">
                    <div className="flex flex-col gap-0.5">
                      {r.flows.map((f, j) => (
                        <span key={j} className="text-[12.5px]">
                          <b className="text-fg">{f.label}</b>{' '}
                          <span className="num font-semibold up">{fmtFlow(f.metric, f.value)}</span>
                          {f.onDate && <span className="num ml-1 text-faint">{f.onDate}</span>}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td><FloatCell shares={r.floatShares} basis={r.floatBasis} /></td>
                  <td className="num">{num(r.close)}</td>
                  <td className={`num ${(r.changePct ?? 0) >= 0 ? 'up' : 'down'}`}>
                    {r.changePct === null ? '-' : signed(r.changePct)}
                  </td>
                  <td className="num">{won(r.tradedValue)}</td>
                  <td className="l"><PatternTags patterns={r.patterns} /></td>
                  <td className="l">
                    {r.lines.length === 0 ? <span className="text-faint">-</span> : (
                      <div className="flex flex-wrap gap-1">
                        {r.lines.map((l) => (
                          <span key={l.signal} className="tag tag-violet">
                            {l.signal === 'volume_breakout_pullback' ? '돌파 눌림목' : '이평 지지'}
                            <span className="num opacity-60">{Math.round(l.score)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.insiderBuys > 0
                      ? <span className="tag tag-ok">매수 {r.insiderBuys}</span>
                      : <span className="text-faint">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ══════════════════════ 2. 패턴분석 ══════════════════════ */

interface PatternRow {
  symbol: string; name: string; market: string;
  pattern: string; direction: Direction; kind: string; stage: Stage;
  score: string; pivot_price: string | null; distance_pct: string | null;
  breakout_date: string | null; start_date: string | null;
  close: string | null; traded_value: string | null;
  evidence: Record<string, unknown>;
  flow_tags: Array<{ investor_type: string; float_pct: string; on_date: string }>;
  line_tags: Array<{ signal: string; score: number }>;
}

function PatternTab({ date, fromDate, catalog }: { date: string; fromDate?: string; catalog: Catalog }) {
  const [directions, setDirections] = useState<Direction[]>(['bullish']);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [stages, setStages] = useState<Stage[]>(['near_pivot', 'breakout', 'pullback']);
  const [minScore, setMinScore] = useState(60);
  const [rows, setRows] = useState<PatternRow[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ date, minScore: String(minScore), limit: '200' });
    if (fromDate) q.set('from', fromDate);
    if (directions.length) q.set('directions', directions.join(','));
    if (patterns.length) q.set('patterns', patterns.join(','));
    if (stages.length) q.set('stages', stages.join(','));
    fetch(`/api/patterns?${q}`).then((r) => r.json()).then((d) => {
      setRows(d.rows ?? []);
      setLabels({ ...(d.stageLabels ?? {}), ...(d.investorLabels ?? {}) });
    });
  }, [date, fromDate, directions, patterns, stages, minScore]);

  const toggle = <T,>(arr: T[], v: T, set: (x: T[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const visible = catalog.patterns.filter((p) => !directions.length || directions.includes(p.direction));

  return (
    <div className="space-y-4">
      <Card title="패턴" sub="지금 어느 단계에 있는지로 걸러요" right={<span className="tag tag-mute num">{num(rows.length)}건</span>}>
        <div className="panel-body space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-faint">방향</span>
            {(['bullish', 'bearish', 'neutral'] as Direction[]).map((d) => (
              <Chip key={d} on={directions.includes(d)} tone={DIR_TONE[d]} onClick={() => toggle(directions, d, setDirections)}>
                {DIR_KO[d]}패턴
              </Chip>
            ))}
            <span className="ml-3 mr-1 text-[12px] text-faint">현재 단계</span>
            {catalog.stages.map((s) => (
              <Chip key={s.id} on={stages.includes(s.id as Stage)} onClick={() => toggle(stages, s.id as Stage, setStages)}>
                {s.ko}
              </Chip>
            ))}
            <label className="ml-3 flex items-center gap-2 text-[12px] text-faint">
              최소 점수 <span className="num w-6 text-fg">{minScore}</span>
              <input type="range" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-32 cursor-pointer accent-[var(--accent)]" />
            </label>
          </div>
          <details className="group" open={patterns.length > 0}>
            <summary className="chip inline-flex cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              패턴 종류 {patterns.length ? `${patterns.length}개 선택` : '전체'}
              <span className="text-faint transition-transform group-open:rotate-180" aria-hidden>⌄</span>
            </summary>
            <div className="mt-2 flex flex-wrap gap-1">
              {visible.map((p) => (
                <Chip key={p.id} on={patterns.includes(p.id)} tone={DIR_TONE[p.direction]} onClick={() => toggle(patterns, p.id, setPatterns)}>
                  {p.ko}
                </Chip>
              ))}
            </div>
          </details>
          <p className="text-[11px] leading-relaxed text-faint">
            자동 판정이라 오탐이 섞여요. 근거 버튼에서 어깨 대칭도, 돌파 거래량 배수 같은 실제 수치를 확인해 주세요.
          </p>
        </div>
      </Card>

      <Card>
        <div className="scroll-x">
          <table className="tbl min-w-[1280px]">
            <thead>
              <tr>
                <th className="l">종목</th>
                <th className="l">패턴</th>
                <th className="l">단계</th>
                <th>점수</th>
                <th>돌파선</th>
                <th>이격</th>
                <th>종가</th>
                <th className="l">동반 수급</th>
                <th className="l">라인</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <Empty>이 조건에 잡힌 패턴이 없어요.</Empty>}
              {rows.map((r, i) => {
                const key = `${r.symbol}-${r.pattern}`;
                const dist = r.distance_pct === null ? null : Number(r.distance_pct);
                return (
                  <Fragment key={key}>
                    <tr className="rise" style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
                      <td className="l"><SymbolCell row={r} /></td>
                      <td className="l">
                        <span className={`font-medium ${DIR_TEXT[r.direction]}`}>
                          {catalog.patterns.find((p) => p.id === r.pattern)?.ko ?? r.pattern}
                        </span>
                      </td>
                      <td className="l">
                        <span className={STAGE_TAG[r.stage] ?? 'tag tag-mute'}>{labels[r.stage] ?? r.stage}</span>
                      </td>
                      <td className="num font-semibold">{Number(r.score).toFixed(0)}</td>
                      <td className="num">{num(r.pivot_price === null ? null : Number(r.pivot_price))}</td>
                      <td className={`num ${(dist ?? 0) >= 0 ? 'up' : 'down'}`}>{dist === null ? '-' : signed(dist)}</td>
                      <td className="num">{num(r.close === null ? null : Number(r.close))}</td>
                      <td className="l">
                        {!r.flow_tags?.length ? <span className="text-faint">-</span> : (
                          <div className="flex flex-wrap items-center gap-1">
                            {r.flow_tags.slice(0, 3).map((f) => (
                              <span key={f.investor_type} className="tag tag-mute">
                                {labels[f.investor_type] ?? f.investor_type}
                                <span className="num text-fg">{Number(f.float_pct).toFixed(2)}%</span>
                              </span>
                            ))}
                            {r.flow_tags.length > 3 && (
                              <span className="num text-[12px] text-faint">+{r.flow_tags.length - 3}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="l">
                        {!r.line_tags?.length ? <span className="text-faint">-</span> : (
                          <div className="flex flex-wrap gap-1">
                            {r.line_tags.map((l) => (
                              <span key={l.signal} className="tag tag-violet">
                                {l.signal === 'volume_breakout_pullback' ? '돌파 눌림목' : '이평 지지'}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="w-px whitespace-nowrap">
                        <button onClick={() => setOpen(open === key ? null : key)} className="chip !px-2.5 !py-1 !text-[12px]">
                          근거
                        </button>
                      </td>
                    </tr>
                    {open === key && (
                      <tr>
                        <td colSpan={10} className="l !p-0">
                          <pre className="max-h-80 overflow-auto bg-[rgb(0_0_0/0.22)] p-3 font-mono text-[11px] leading-relaxed text-mute">
                            {JSON.stringify(r.evidence, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ══════════════════════ 3. 라인분석 ══════════════════════ */

interface LineRow {
  symbol: string; name: string; market: string; signal: string; score: string;
  detail: Record<string, unknown>;
  close: string | null; traded_value: string | null; change_pct: string | null;
  patterns: Array<{ pattern: string; direction: Direction; stage: Stage; score: number }>;
}

function LineTab({ date, fromDate, catalog }: { date: string; fromDate?: string; catalog: Catalog }) {
  const [signal, setSignal] = useState('volume_breakout_pullback');
  const [minScore, setMinScore] = useState(40);
  const [rows, setRows] = useState<LineRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ date, signal, minScore: String(minScore), limit: '200' });
    if (fromDate) q.set('from', fromDate);
    fetch(`/api/lines?${q}`).then((r) => r.json()).then((d) => setRows(d.rows ?? []));
  }, [date, fromDate, signal, minScore]);

  return (
    <div className="space-y-4">
      <Card title="라인" sub="거래량 돌파 후 눌림목과 이평선 지지를 함께 봐요" right={<span className="tag tag-mute num">{num(rows.length)}건</span>}>
        <div className="panel-body flex flex-wrap items-center gap-2">
          {catalog.lineSignals.map((s) => (
            <Chip key={s.id} on={signal === s.id} onClick={() => setSignal(s.id)}>{s.ko}</Chip>
          ))}
          <label className="ml-3 flex items-center gap-2 text-[12px] text-faint">
            최소 점수 <span className="num w-6 text-fg">{minScore}</span>
            <input type="range" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-32 cursor-pointer accent-[var(--accent)]" />
          </label>
        </div>
        <p className="px-3.5 pb-3 pt-0 text-[11px] leading-relaxed text-faint">
          {signal === 'volume_breakout_pullback'
            ? '변곡점 저항선을 평소 거래량의 1.8배 이상으로 돌파한 뒤, 그 선까지 되돌아와 아직 지키고 있는 종목이에요.'
            : '3일선과 5일선이 상승 중이고, 저가가 이평선에 닿았다가 종가는 그 위에서 마감한 종목이에요.'}
        </p>
      </Card>

      <Card>
        <div className="scroll-x">
          <table className="tbl min-w-[1200px]">
            <thead>
              <tr>
                <th className="l">종목</th>
                <th>점수</th>
                <th>종가</th>
                <th>등락률</th>
                <th className="l">{signal === 'volume_breakout_pullback' ? '돌파 정보' : '지지 이평선'}</th>
                <th className="l">동반 패턴</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <Empty>잡힌 시그널이 없어요.</Empty>}
              {rows.map((r, i) => {
                const d = r.detail as Record<string, unknown>;
                const key = `${r.symbol}-${r.signal}`;
                const supports = (d.supports as Array<{ period: number; ma: number; date: string }> | undefined) ?? [];
                const line = d.line as { price: number } | undefined;
                const chg = r.change_pct === null ? null : Number(r.change_pct);
                return (
                  <Fragment key={key}>
                    <tr className="rise" style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
                      <td className="l"><SymbolCell row={r} /></td>
                      <td className="num font-semibold">{Number(r.score).toFixed(0)}</td>
                      <td className="num">{num(r.close === null ? null : Number(r.close))}</td>
                      <td className={`num ${(chg ?? 0) >= 0 ? 'up' : 'down'}`}>{chg === null ? '-' : signed(chg)}</td>
                      <td className="l text-[12.5px] text-mute">
                        {r.signal === 'volume_breakout_pullback' ? (
                          <>
                            <b className="num text-fg">{num(line?.price ?? null)}</b>원 선 ·{' '}
                            <span className="num">{String(d.breakoutDate ?? '')}</span> 돌파 · 거래량{' '}
                            <b className="num up">{String(d.volumeRatio ?? '')}배</b> · 이격{' '}
                            <span className="num">{String(d.distanceToLinePct ?? '')}%</span>
                          </>
                        ) : (
                          <>
                            {supports.map((s) => `${s.period}일선 ${nf.format(Math.round(s.ma))} (${s.date})`).join(' · ')}
                            {d.aboveMa20 ? ' · 20일선 위' : ''}
                          </>
                        )}
                      </td>
                      <td className="l">
                        <PatternTags
                          patterns={(r.patterns ?? []).map((p) => ({
                            ...p,
                            ko: catalog.patterns.find((c) => c.id === p.pattern)?.ko ?? p.pattern,
                            stageKo: catalog.stages.find((s) => s.id === p.stage)?.ko,
                          }))}
                        />
                      </td>
                      <td className="w-px whitespace-nowrap">
                        <button onClick={() => setOpen(open === key ? null : key)} className="chip !px-2.5 !py-1 !text-[12px]">
                          근거
                        </button>
                      </td>
                    </tr>
                    {open === key && (
                      <tr>
                        <td colSpan={7} className="l !p-0">
                          <pre className="max-h-72 overflow-auto bg-[rgb(0_0_0/0.22)] p-3 font-mono text-[11px] leading-relaxed text-mute">
                            {JSON.stringify(r.detail, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
