'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { MagnifyingGlass, Moon, Plus, Sun, X } from '@phosphor-icons/react/dist/ssr';
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import NumberTicker from '@/components/NumberTicker';
import SymbolSearch from '@/components/SymbolSearch';

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
  flowLogic?: 'AND' | 'OR';
  pattern?: { patterns?: string[]; directions?: Direction[]; stages?: Stage[]; minScore?: number; maxBarsSinceBreakout?: number };
  line?: { signals?: string[]; minScore?: number };
  limit: number;
  sortBy: 'flow' | 'score' | 'traded_value';
}

interface RuleRow {
  symbol: string; name: string; market: string;
  close: number | null; changePct: number | null; tradedValue: number | null;
  floatShares: number | null; floatBasis: 'computed' | 'listed_shares';
  flows: Array<{ label: string; metric: string; value: number; onDate: string | null }>;
  patterns: Array<{ pattern: string; ko: string; direction: Direction; stage: Stage; stageKo: string; score: number; pivotPrice: number | null; distancePct: number | null; barsSinceBreakout?: number | null; barsSinceFormed?: number | null; breakoutVolumeRatio?: number | null }>;
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

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [date, setDate] = useState('');
  // 기간 모드. 비어 있으면 단일 기준일, 채우면 [fromDate, date] 범위로 검색한다.
  const [fromDate, setFromDate] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark');
  }, []);

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

  // 기본 기준일은 "수집이 끝난" 최신 거래일이다. 거래일 달력의 최신일(last_trading_day)은
  // 수급만 들어와도 개장으로 잡혀서, 일봉·패턴이 아직 없는 반쯤 찬 날을 가리킬 때가 있다.
  // 그 날을 기본으로 두면 어떤 조건을 걸어도 0건이라 "검색이 안 된다"로 보인다.
  const lastDay = String(status?.counts?.last_complete_day || status?.counts?.last_trading_day || '');
  useEffect(() => { if (lastDay && !date) setDate(lastDay); }, [lastDay, date]);

  return (
    <main className="min-h-screen">
      {/* 제목·탭·기준일을 한 줄에 둔다. 헤더가 세 줄이면 시세면이 그만큼 밀린다.
          블러 유리 대신 불투명 지면 + 1px 괘선으로 고정 영역을 표시한다. */}
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center gap-x-5 gap-y-1 px-5 pt-2.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.012em]">수급·패턴 분석</h1>

          <span className="hidden pb-2 text-[12.5px] text-faint lg:inline">
            수급, 패턴, 라인을 한 화면에서 조합해 찾습니다
          </span>

          <div className="ml-auto flex items-center gap-2 pb-1.5">
            {/* 조건으로 찾는 화면이지만 이미 아는 종목으로 바로 갈 길도 있어야 한다. */}
            <SymbolSearch />
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
              className="btn btn-quiet !px-2"
              aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
            >
              {theme === 'dark' ? Icon.sun : Icon.moon}
            </button>
          </div>
        </div>

      </header>

      <div className="mx-auto max-w-[1720px] space-y-4 px-5 py-5">
        {loadError ? <LoadError message={loadError} /> : <MarketChart status={status} catalog={catalog} />}
        {loadError ? null : !date || !catalog ? (
          <Skeleton />
        ) : (
          <FlowTab date={date} fromDate={fromDate || undefined} catalog={catalog} status={status} />
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
  kospi?: number;
  [k: string]: string | number | undefined;
}

/** 주체별 선 색. 개인 적 · 외국인 청은 시세 관행과 같은 축에 둔다. */
const FLOW_COLOR: Record<string, string> = {
  individual: 'var(--up)',
  foreign: 'var(--down)',
  other_foreign: '#7aa8ff',
  institution_total: 'var(--ok)',
  financial_investment: '#c084fc',
  insurance: '#f472b6',
  investment_trust: '#38bdf8',
  private_fund: 'var(--gold)',
  bank: '#a3a3a3',
  other_finance: '#94a3b8',
  pension: '#34d399',
  other_corp: '#fb923c',
};

function MarketChart({ status, catalog }: { status: Status | null; catalog: Catalog | null }) {
  const [picked, setPicked] = useState<string[]>(['private_fund', 'foreign', 'individual']);
  const [cum, setCum] = useState(true);
  const [days, setDays] = useState(60);
  const [rows, setRows] = useState<SeriesRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    const q = new URLSearchParams({
      investors: picked.join(','),
      days: String(days),
      mode: cum ? 'cumulative' : 'daily',
    });
    fetch(`/api/series?${q}`)
      .then((r) => r.json())
      .then((d) => setRows(d.rows ?? []))
      .catch(() => setRows([]));
  }, [picked, cum, days]);

  const koLabel = (id: string) => catalog?.investors.find((x) => x.id === id)?.ko ?? id;
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 6 ? p : [...p, id]));

  const n = (k: string) => Number(status?.counts?.[k] ?? 0);

  return (
    <section className="panel">
      <div className="panel-head flex-wrap gap-y-2">
        <div>
          <h2 className="panel-title">주체별 순매수 추이와 지수</h2>
          <p className="panel-desc">
            고른 주체의 순매수 금액을 시장 지수와 겹쳐 봅니다. 지수는 KOSPI 종목의 일별 수익률 중앙값을 연쇄한 값으로, 시작일이 100입니다.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Segmented
            label="합산 방식"
            value={cum ? 'cum' : 'day'}
            onChange={(v) => setCum(v === 'cum')}
            options={[{ v: 'cum', ko: '누적' }, { v: 'day', ko: '일별' }]}
          />
          <Segmented
            label="기간"
            value={days}
            onChange={setDays}
            options={[{ v: 30, ko: '30일' }, { v: 60, ko: '60일' }, { v: 120, ko: '120일' }]}
          />
        </div>
      </div>

      <div className="panel-body space-y-3">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[12px] text-faint">비교군</span>
          {(catalog?.investors ?? []).map((iv) => (
            <Chip
              key={iv.id}
              on={picked.includes(iv.id)}
              onClick={() => toggle(iv.id)}
              dot={picked.includes(iv.id) ? (FLOW_COLOR[iv.id] ?? 'var(--fg-2)') : undefined}
            >
              {iv.ko}
            </Chip>
          ))}
          <span className="ml-1 text-[11.5px] text-faint">최대 6개</span>
        </div>

        <div className="h-[320px]">
          {rows === null ? (
            <div className="skel h-full w-full" />
          ) : rows.length === 0 || picked.length === 0 ? (
            <p className="flex h-full items-center justify-center text-[12.5px] text-faint">
              {picked.length === 0 ? '비교군을 하나 이상 골라 주세요.' : '아직 수급 데이터가 없어요.'}
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10.5, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false} minTickGap={30} />
                <YAxis
                  yAxisId="flow" tick={{ fontSize: 10.5, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false} width={52}
                  tickFormatter={(v) => {
                    const x = Number(v);
                    if (x === 0) return '0';
                    return Math.abs(x) >= 10000 ? `${(x / 10000).toFixed(1).replace(/\.0$/, '')}조` : `${nf.format(x)}억`;
                  }}
                />
                <YAxis
                  yAxisId="idx" orientation="right" domain={['dataMin - 2', 'dataMax + 2']}
                  tick={{ fontSize: 10.5, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false} width={40}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--s1)', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: 'var(--fg-2)' }}
                  formatter={(v, name) =>
                    String(name) === 'kospi'
                      ? [Number(v ?? 0).toFixed(2), '시장 지수(시작=100)']
                      : [`${nf.format(Number(v ?? 0))}억`, koLabel(String(name))]
                  }
                />
                <Legend
                  formatter={(value) => (String(value) === 'kospi' ? '시장 지수' : koLabel(String(value)))}
                  wrapperStyle={{ fontSize: 11.5, color: 'var(--fg-2)' }}
                />
                {picked.map((t) => (
                  <Area
                    key={t} yAxisId="flow" type="monotone" dataKey={t}
                    stroke={FLOW_COLOR[t] ?? 'var(--fg-2)'} strokeWidth={1.6}
                    fill={FLOW_COLOR[t] ?? 'var(--fg-2)'} fillOpacity={0.08}
                    dot={false} activeDot={{ r: 3 }} isAnimationActive={false}
                  />
                ))}
                <Line
                  yAxisId="idx" type="monotone" dataKey="kospi"
                  stroke="var(--fg)" strokeWidth={1.4} strokeDasharray="4 3"
                  dot={false} isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 운영 메타는 결정에 쓰는 숫자가 아니라 상태다. 한 줄로 낮춰 둔다. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-faint">
          {status && (
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block size-1.5 rounded-full ${
                  status.overall === 'ok' ? 'bg-ok' : status.overall === 'partial' ? 'bg-warn' : 'bg-faint'
                }`}
                aria-hidden
              />
              분석 기준 {status.counts.last_complete_day ?? status.counts.last_trading_day ?? '-'}
            </span>
          )}
          {/* 장은 열렸는데 아직 수집이 안 끝난 날이 있으면 밝혀 둔다.
              이 사실을 숨기면 "왜 오늘 게 없지"가 된다. */}
          {status?.counts?.last_trading_day &&
            status.counts.last_complete_day &&
            status.counts.last_trading_day !== status.counts.last_complete_day && (
              <span className="text-warn">{status.counts.last_trading_day} 수집 중</span>
            )}
          <span>수급 {num(n('flow_daily'))}행</span>
          <span>일봉 {num(n('ohlcv'))}행</span>
          <span>패턴 {num(n('patterns'))}건 (돌파 확정 {num(n('patterns_confirmed'))})</span>
          <span>수급 원천 {status?.counts?.flow_source || '없음'}</span>
        </div>
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
  on, onClick, children, tone, dot,
}: { on?: boolean; onClick?: () => void; children: React.ReactNode; tone?: string; dot?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chip"
      data-on={on ? 'true' : 'false'}
      data-tone={tone}
      aria-pressed={on ?? false}
      style={dot ? ({ '--dot': dot } as React.CSSProperties) : undefined}
    >
      {dot && <span className="chip-dot" aria-hidden />}
      {children}
    </button>
  );
}

/** 배타 선택. 칩을 흩어 놓으면 무엇과 무엇 중 하나인지 안 보인다. 한 트랙에 묶는다. */
function Segmented<T extends string | number>({
  value, options, onChange, label,
}: { value: T; options: Array<{ v: T; ko: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          data-on={o.v === value ? 'true' : 'false'}
          aria-pressed={o.v === value}
          onClick={() => onChange(o.v)}
        >
          {o.ko}
        </button>
      ))}
    </div>
  );
}

/** 조건 축 켜기·끄기. 글자 대신 실제로 미끄러지는 손잡이를 둔다. */
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      className="switch shrink-0"
      data-on={on ? 'true' : 'false'}
      onClick={() => onChange(!on)}
    />
  );
}

/** 높이 접기. 접힌 영역은 눈에서 사라져도 탭 이동에는 남으므로 inert 로 빼 준다. */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const off = { inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>;
  return (
    <div className="fold" data-open={open ? 'true' : 'false'} {...(open ? {} : off)}>
      <div>{children}</div>
    </div>
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
        <div className="px-4 py-10 text-[13px] text-faint">{children}</div>
      </td>
    </tr>
  );
}

function PatternTags({
  patterns,
}: { patterns: Array<{ pattern: string; ko: string; direction: Direction; stage: Stage; stageKo?: string; score: number; breakoutVolumeRatio?: number | null }> }) {
  if (!patterns?.length) return <span className="text-faint">-</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {patterns.slice(0, 3).map((p) => (
        <span key={p.pattern} className={DIR_TAG[p.direction]}>
          {p.ko}
          <span className={`${STAGE_TAG[p.stage] ?? 'tag tag-mute'} !px-1 !py-0`}>{p.stageKo ?? p.stage}</span>
          {/* 돌파봉 거래량이 평소의 몇 배였는가. 1.5배부터 점수가 크게 붙는다. */}
          {p.breakoutVolumeRatio ? (
            <span
              className={`num !px-1 !py-0 ${p.breakoutVolumeRatio >= 1.5 ? 'tag tag-accent' : 'opacity-55'}`}
              title={`돌파봉 거래량이 직전 20봉 평균의 ${p.breakoutVolumeRatio.toFixed(2)}배`}
            >
              ×{p.breakoutVolumeRatio.toFixed(1)}
            </span>
          ) : null}
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
  const [searchErr, setSearchErr] = useState<string | null>(null);
  // 세 축을 각각 껐다 켠다. 끄면 그 축은 조건에서 아예 빠진다.
  const [useFlow, setUseFlow] = useState(true);
  const [usePattern, setUsePattern] = useState(true);
  const [useLine, setUseLine] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setSearchErr(null);
    try {
      // 기간 모드면 수급 관찰 창(windowDays)을 그 기간의 거래일 수로 덮어쓴다.
      const winFromRange = fromDate
        ? Math.max(1, Math.round(((new Date(date).getTime() - new Date(fromDate).getTime()) / 86_400_000) * 0.7))
        : null;
      const flow = useFlow
        ? rule.flow.map((f) => (winFromRange ? { ...f, windowDays: winFromRange } : f))
        : [];
      const body: RuleBody & { date: string } = {
        ...rule,
        date,
        flow,
        pattern: usePattern ? rule.pattern : undefined,
        line: useLine ? rule.line : undefined,
      };
      const res = await fetch('/api/rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || typeof j.error === 'string') {
        throw new Error(j?.error ?? `서버가 ${res.status} 로 응답했어요`);
      }
      setRows(j.rows ?? []);
      setNotes(j.notes ?? []);
      setSources(j.sources ?? []);
      setRanAt(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (e: unknown) {
      // 실패했는데 이전 결과가 남아 있으면 성공한 것으로 오해한다. 결과를 비운다.
      setRows(null);
      setNotes([]);
      setSources([]);
      setSearchErr(e instanceof Error ? e.message : '검색에 실패했어요');
    } finally {
      setLoading(false);
    }
  }, [rule, date, fromDate, useFlow, usePattern, useLine]);

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
        sub="쓸 조건만 켜서 겹쳐 거릅니다. 셋 다 끄면 거래대금 상위로 보여줘요"
        right={
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <button
              onClick={() => void run()}
              className="btn btn-shine !px-6"
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? <span className="spinner" aria-hidden /> : Icon.search}
              {loading ? '찾는 중' : '검색'}
            </button>
            {searchErr ? (
              <span className="flex max-w-[320px] items-start gap-1.5 text-right text-[12px] text-up">
                <span aria-hidden>!</span>
                <span>{searchErr}</span>
              </span>
            ) : ranAt && !loading ? (
              <span className="num text-[11.5px] text-faint">{ranAt} 기준</span>
            ) : null}
          </div>
        }
      >
        <div className="panel-body">
          <div className="rail">
          <section className="tile" data-on={useFlow ? 'true' : 'false'}>
            <div className="panel-head">
              <div>
                <h3 className="panel-title">수급</h3>
                <p className="panel-desc">
                  {useFlow ? '주체별 순매수 강도로 거릅니다' : '검색에서 빼 둔 조건이에요'}
                </p>
              </div>
              <Switch on={useFlow} onChange={setUseFlow} label="수급 조건 사용" />
            </div>
            <Collapse open={useFlow}>
            <div className="panel-body">
{/* 수급 조건 */}
          <div>
            <div className="divide-y divide-line">
            {rule.flow.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 py-2 first:pt-0 last:pb-0">
                {i > 0 && (
                  <span className="tag tag-accent">{(rule.flowLogic ?? 'AND') === 'OR' ? '또는' : '그리고'}</span>
                )}
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
                  <button onClick={() => delFlow(i)} className="btn btn-quiet ml-auto !px-1.5" aria-label={`${i + 1}번 조건 삭제`}>
                    {Icon.x}
                  </button>
                )}
              </div>
            ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button onClick={addFlow} className="btn btn-ghost !px-3 !py-1.5 !text-[12.5px]">
                {Icon.plus} 조건 추가
              </button>
              {rule.flow.length > 1 && (
                <Segmented
                  label="조건 묶는 방식"
                  value={rule.flowLogic ?? 'AND'}
                  onChange={(lg) => setRule((r) => ({ ...r, flowLogic: lg }))}
                  options={[{ v: 'AND', ko: '모두 만족' }, { v: 'OR', ko: '하나라도' }]}
                />
              )}
            </div>
          </div>
            </div>
            </Collapse>
          </section>
          <section className="tile" data-on={usePattern ? 'true' : 'false'}>
            <div className="panel-head">
              <div>
                <h3 className="panel-title">패턴</h3>
                <p className="panel-desc">
                  {usePattern ? '지금 어느 단계에 있는지로 거릅니다' : '검색에서 빼 둔 조건이에요'}
                </p>
              </div>
              <Switch on={usePattern} onChange={setUsePattern} label="패턴 조건 사용" />
            </div>
            <Collapse open={usePattern}>
            <div className="panel-body">
{/* 패턴 조건 */}
          <div>
            <p className="mb-2 text-[12px] text-faint">고르지 않으면 모든 패턴을 봅니다</p>
            <div className="mb-2 flex flex-wrap gap-1">
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
              <label className="ml-3 flex items-center gap-1.5 text-[12px] text-faint">
                돌파 후
                <select
                  className="input !py-1 !text-[12px]"
                  value={rule.pattern?.maxBarsSinceBreakout ?? ''}
                  onChange={(e) =>
                    setRule((r) => ({
                      ...r,
                      pattern: {
                        ...r.pattern,
                        maxBarsSinceBreakout: e.target.value === '' ? undefined : Number(e.target.value),
                      },
                    }))
                  }
                >
                  <option value="">제한 없음</option>
                  <option value={3}>3거래일 이내</option>
                  <option value={5}>5거래일 이내</option>
                  <option value={10}>10거래일 이내</option>
                  <option value={20}>20거래일 이내</option>
                </select>
              </label>
            </div>
          </div>
            </div>
            </Collapse>
          </section>
          <section className="tile" data-on={useLine ? 'true' : 'false'}>
            <div className="panel-head">
              <div>
                <h3 className="panel-title">라인</h3>
                <p className="panel-desc">
                  {useLine ? '지지선·눌림목 시그널로 거릅니다' : '검색에서 빼 둔 조건이에요'}
                </p>
              </div>
              <Switch on={useLine} onChange={setUseLine} label="라인 조건 사용" />
            </div>
            <Collapse open={useLine}>
            <div className="panel-body">
{/* 라인 조건 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {catalog.lineSignals.map((s) => (
              <Chip
                key={s.id}
                on={rule.line?.signals?.includes(s.id)}
                onClick={() => setRule((r) => ({ ...r, line: { ...r.line, signals: toggleIn(r.line?.signals, s.id) } }))}
              >
                {s.ko}
              </Chip>
            ))}
          </div>
            </div>
            </Collapse>
          </section>
          </div>

          {/* 시장·거래대금·정렬은 어느 축을 켜든 항상 걸리는 공통 설정이다.
              라인 카드 안에 두면 라인을 끌 때 같이 접혀 손댈 수 없게 된다. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
            <span className="text-[12px] font-medium text-mute">공통</span>
            <label className="flex items-center gap-1.5 text-[12px] text-faint">
              시장
              <select value={rule.market} onChange={(e) => setRule((r) => ({ ...r, market: e.target.value }))} className="input !py-1 !text-[12px]">
                <option value="ALL">전체</option>
                <option value="KOSPI">KOSPI</option>
                <option value="KOSDAQ">KOSDAQ</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-faint">
              최소 거래대금
              <select value={rule.minTradedValue} onChange={(e) => setRule((r) => ({ ...r, minTradedValue: Number(e.target.value) }))} className="input !py-1 !text-[12px]">
                <option value={0}>제한 없음</option>
                <option value={100_000_000}>1억</option>
                <option value={1_000_000_000}>10억</option>
                <option value={5_000_000_000}>50억</option>
                <option value={10_000_000_000}>100억</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-faint">
              정렬
              <select value={rule.sortBy} onChange={(e) => setRule((r) => ({ ...r, sortBy: e.target.value as RuleBody['sortBy'] }))} className="input !py-1 !text-[12px]">
                <option value="flow">수급 강도</option>
                <option value="score">패턴 점수</option>
                <option value="traded_value">거래대금</option>
              </select>
            </label>
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
