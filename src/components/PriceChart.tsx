'use client';

/**
 * 일봉 차트 + 지지선 그리기 + 도형 영구 저장.
 *
 * TradingView Charting Library(Advanced Charts)는 신청·승인이 필요해 저장소 접근 권한을
 * 받기 전에는 번들을 넣을 수 없다. 그래서 개발이 막히지 않도록
 *   ① UDF 서버(/api/udf/*)를 먼저 만들고
 *   ② 도형 저장 API(/api/drawings)를 save_load_adapter 와 같은 계약으로 맞춘 뒤
 *   ③ 지금 당장 쓸 수 있는 렌더러(lightweight-charts)로 그린다.
 * 승인 후에는 이 컴포넌트만 Charting Library 위젯으로 갈아끼우면 되고,
 * 도형 저장 경로와 시세 공급 경로는 그대로 재사용한다.
 */

import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ChartBar {
  date: string;
  o: string | number;
  h: string | number;
  l: string | number;
  c: string | number;
  volume: string | number;
  traded_value?: string | number;
}

export interface PatternInfo {
  pattern: string;
  score: string | number;
  confirmed: boolean;
  evidence: Record<string, unknown>;
  /** 스캔 날짜. 같은 패턴이 여러 날짜로 올 수 있어 key 를 만드는 데 쓴다. */
  date?: string;
  stage?: string;
}

type Drawing =
  | { id: string; type: 'hline'; price: number; label?: string }
  | { id: string; type: 'trend'; t1: string; p1: number; t2: string; p2: number };

type Mode = 'none' | 'hline' | 'trend';

const uid = () => Math.random().toString(36).slice(2, 10);
const n = (v: string | number) => (typeof v === 'number' ? v : Number(v));

/** 봉 주기. 서버는 일봉만 주고 주·월봉은 여기서 묶는다. */
type TF = 'D' | 'W' | 'M';
const TF_KO: Record<TF, string> = { D: '일봉', W: '주봉', M: '월봉' };

/**
 * 일봉을 주봉·월봉으로 묶는다.
 * 시가는 첫 봉, 고가·저가는 구간 극값, 종가는 마지막 봉, 거래량은 합이다.
 *
 * 묶은 봉의 시각은 그 구간의 **첫 거래일**로 둔다. 패턴 좌표와 수급 마커는
 * 원래 일자를 갖고 있어서 그대로 얹으면 시리즈에 없는 시각이라 통째로 사라진다.
 * 그래서 "일자 → 그 일자가 속한 봉의 시각" 대응표를 같이 돌려준다.
 */
function aggregate(bars: ChartBar[], tf: TF): { bars: ChartBar[]; at: Map<string, string> } {
  const at = new Map<string, string>();
  if (tf === 'D') {
    for (const b of bars) at.set(b.date, b.date);
    return { bars, at };
  }
  const keyOf = (d: string) => {
    if (tf === 'M') return d.slice(0, 7);
    // 그 주의 월요일로 묶는다. UTC 로 계산해야 서머타임·표준시 경계가 없다.
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return dt.toISOString().slice(0, 10);
  };

  const out: ChartBar[] = [];
  let curKey = '';
  for (const b of bars) {
    const k = keyOf(b.date);
    if (k !== curKey) {
      curKey = k;
      out.push({
        date: b.date,
        o: n(b.o), h: n(b.h), l: n(b.l), c: n(b.c),
        volume: n(b.volume),
        traded_value: n(b.traded_value ?? 0),
      });
    } else {
      const cur = out[out.length - 1];
      cur.h = Math.max(n(cur.h), n(b.h));
      cur.l = Math.min(n(cur.l), n(b.l));
      cur.c = n(b.c);
      cur.volume = n(cur.volume) + n(b.volume);
      cur.traded_value = n(cur.traded_value ?? 0) + n(b.traded_value ?? 0);
    }
    at.set(b.date, out[out.length - 1].date);
  }
  return { bars: out, at };
}

/** CSS 토큰을 읽어 차트 색을 만든다. 테마를 바꾸면 그대로 따라온다. */
function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => (s.getPropertyValue(name).trim() || fallback);
  return {
    bg: v('--s1', '#141417'),
    grid: v('--line', 'rgb(242 242 245 / 0.10)'),
    text: v('--fg-2', '#a2a2ad'),
    border: v('--line-2', 'rgb(242 242 245 / 0.17)'),
    up: v('--up', '#ff5165'),
    down: v('--down', '#4a8dff'),
    upSoft: v('--up-soft', 'rgb(255 81 101 / 0.13)'),
    downSoft: v('--down-soft', 'rgb(74 141 255 / 0.13)'),
    accent: v('--accent', '#f2f2f5'),
    ok: v('--ok', '#3ecf9a'),
    mark: v('--gold', '#f2c14e'),
    fg: v('--fg', '#f2f2f5'),
  };
}

/** evidence 안의 좌표 한 점. 구버전은 low/high, 신버전은 price 를 쓴다. */
interface EvPoint {
  date?: string;
  price?: number;
  low?: number;
  high?: number;
}
const pxOf = (v?: EvPoint): number | undefined => v?.price ?? v?.low ?? v?.high;

export interface PatternGeometry {
  points: Array<{ t: string; price: number; label: string }>;
  lines: Array<{ t1: string; p1: number; t2: string; p2: number; dashed?: boolean }>;
  /** 돌파선. 좌표를 못 뽑는 패턴(깃발·삼각형·쐐기·박스권)도 이건 항상 있다. */
  pivotPrice?: number;
  stage?: string;
}

/**
 * evidence 에서 패턴 골격을 뽑아 차트에 겹쳐 그린다.
 *
 * 패턴 16종은 evidence 모양이 서로 다르다.
 *   어깨형   : leftShoulder / head / rightShoulder + neckline{p1,p2}
 *   접점형   : touches[] + pivot            (쌍바닥·쌍고점·삼중바닥·삼중천장)
 *   컵형     : cupLeftRim / cupBottom / cupRightRim + handle
 *   추세선형 : 좌표 없음 — pivotPrice 만 있다 (깃발·삼각형·쐐기·박스권)
 * 그래서 키를 하나씩 특별취급하지 않고 있는 것만 모아 담는다.
 * 좌표가 전혀 없는 패턴이라도 pivotPrice 는 늘 그려 준다.
 */
function patternGeometry(p: PatternInfo | null): PatternGeometry {
  if (!p) return { points: [], lines: [] };
  const e = p.evidence as Record<string, unknown>;
  const points: PatternGeometry['points'] = [];
  const lines: PatternGeometry['lines'] = [];

  const push = (key: string, label: string) => {
    const v = e[key] as EvPoint | undefined;
    const price = pxOf(v);
    if (v?.date && price !== undefined) points.push({ t: v.date, price, label });
  };

  // 어깨형
  push('leftShoulder', '왼쪽 어깨');
  push('head', '머리');
  push('rightShoulder', '오른쪽 어깨');

  // 컵형
  push('cupLeftRim', '좌측 테두리');
  push('cupBottom', '바닥');
  push('cupRightRim', '우측 테두리');
  const handle = e.handle as { lowDate?: string; low?: number } | undefined;
  if (handle?.lowDate && handle.low !== undefined) {
    points.push({ t: handle.lowDate, price: handle.low, label: '핸들 저점' });
  }

  // 접점형 (쌍바닥·삼중바닥·쌍고점·삼중천장)
  const touches = e.touches as EvPoint[] | undefined;
  if (Array.isArray(touches)) {
    touches.forEach((tp, i) => {
      const price = pxOf(tp);
      if (tp.date && price !== undefined) points.push({ t: tp.date, price, label: `접점 ${i + 1}` });
    });
  }
  push('pivot', '돌파 기준');

  // 넥라인
  const neck = e.neckline as { p1?: EvPoint; p2?: EvPoint } | undefined;
  const n1 = pxOf(neck?.p1);
  const n2 = pxOf(neck?.p2);
  if (neck?.p1?.date && neck?.p2?.date && n1 !== undefined && n2 !== undefined) {
    lines.push({ t1: neck.p1.date, p1: n1, t2: neck.p2.date, p2: n2, dashed: true });
  }

  // 컵 테두리 연결선
  const rimL = e.cupLeftRim as EvPoint | undefined;
  const rimR = e.cupRightRim as EvPoint | undefined;
  const l1 = pxOf(rimL);
  const l2 = pxOf(rimR);
  if (rimL?.date && rimR?.date && l1 !== undefined && l2 !== undefined) {
    lines.push({ t1: rimL.date, p1: l1, t2: rimR.date, p2: l2, dashed: true });
  }

  const pivotPrice = typeof e.pivotPrice === 'number' ? e.pivotPrice : undefined;
  const stage = typeof e.stage === 'string' ? e.stage : undefined;

  return { points, lines, pivotPrice, stage };
}

const PATTERN_KO: Record<string, string> = {
  inverse_head_shoulders: '역헤드앤숄더',
  double_bottom: '쌍바닥',
  triple_bottom: '삼중바닥',
  rounding_bottom: '원형바닥',
  falling_wedge: '하락쐐기',
  cup_with_handle: '컵앤핸들',
  ascending_triangle: '상승삼각형',
  bull_flag: '상승깃발',
  head_and_shoulders: '헤드앤숄더',
  double_top: '쌍고점',
  triple_top: '삼중천장',
  rising_wedge: '상승쐐기',
  descending_triangle: '하락삼각형',
  bear_flag: '하락깃발',
  symmetrical_triangle: '대칭삼각형',
  rectangle: '박스권',
};

const STAGE_LABEL: Record<string, string> = {
  forming: '형성중',
  near_pivot: '돌파선 부근',
  breakout: '돌파',
  pullback: '눌림목',
  failed: '돌파 실패',
};

export interface FlowMarker {
  date: string;
  investor_type: string;
  net_buy_qty: string | number;
  float_ratio_pct: string | number | null;
}

export interface ChartSupportLine {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  strength: number;
}

export default function PriceChart({
  symbol,
  bars,
  patterns = [],
  flowMarkers = [],
  supportLines = [],
  investorLabels = {},
}: {
  symbol: string;
  bars: ChartBar[];
  patterns?: PatternInfo[];
  flowMarkers?: FlowMarker[];
  supportLines?: ChartSupportLine[];
  investorLabels?: Record<string, string>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [mode, setMode] = useState<Mode>('none');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [pending, setPending] = useState<{ t: string; p: number } | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'ok'>('idle');
  const [overlayTick, setOverlayTick] = useState(0);
  const [showPattern, setShowPattern] = useState(0);
  const [showFlow, setShowFlow] = useState(true);
  const [showLines, setShowLines] = useState(true);
  /** 차트 인스턴스가 만들어졌는지. 이 값이 true 가 된 뒤에만 시리즈를 건드릴 수 있다. */
  const [ready, setReady] = useState(false);

  const [tf, setTf] = useState<TF>('D');
  /** 마커로 그릴 최소 순매수 비율(유통주식수 대비 %). 0 이면 전부 그린다. */
  const [flowMin, setFlowMin] = useState(0.1);
  /** 볼 주체. null 이면 전체. */
  const [flowPick, setFlowPick] = useState<string[] | null>(null);

  const activePattern = patterns[showPattern] ?? null;
  const geometry = useMemo(() => patternGeometry(activePattern), [activePattern]);
  const view = useMemo(() => aggregate(bars, tf), [bars, tf]);

  /** 마커 데이터에 실제로 등장하는 주체만, 유입이 큰 순서로. 없는 주체를 내밀 이유가 없다. */
  const flowTypes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const f of flowMarkers) {
      const w = Math.abs(Number(f.float_ratio_pct ?? 0));
      seen.set(f.investor_type, (seen.get(f.investor_type) ?? 0) + w);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [flowMarkers]);
  const picked = useMemo(() => flowPick ?? flowTypes, [flowPick, flowTypes]);

  // 패턴 골격은 차트 캔버스에 직접 그린다(마커 + 넥라인/테두리 가격선).
  // SVG 오버레이보다 확실하게 함께 그려지고, 스크롤·줌에도 자동으로 따라간다.
  useEffect(() => {
    const candles = candleRef.current;
    if (!ready || !candles) return;
    const t = readTheme();

    // 패턴 골격 + 수급 유입 마커를 한 번에 얹는다.
    // 수급 마커는 "언제 얼마나 들어왔는지"를 봉 위에 바로 보여주기 위한 것이다.
    // 패턴 골격은 위, 수급은 아래. 층을 나눠야 둘이 겹쳐 봉을 가리지 않는다.
    const patternMarkers: SeriesMarker<Time>[] = geometry.points
      .map((p) => {
        const time = view.at.get(p.t);
        return time
          ? ({ time: time as Time, position: 'aboveBar', color: t.mark, shape: 'circle', text: p.label } as SeriesMarker<Time>)
          : null;
      })
      .filter((m): m is SeriesMarker<Time> => m !== null);

    // 하루에 여러 주체가 겹치면 화살표가 봉을 덮어 캔들이 안 보였다.
    // 고른 주체의 순매수 비율을 봉 단위로 합쳐 화살표 하나로 만들고 크기로 세기를 표현한다.
    // 임계값에 못 미치는 날은 아예 그리지 않는다. 주봉·월봉에서는 그 구간 합계가 된다.
    const pickSet = new Set(picked);
    const perBar = new Map<string, { sum: number; topId: string; topPct: number }>();
    if (showFlow) {
      for (const f of flowMarkers) {
        if (!pickSet.has(f.investor_type)) continue;
        const time = view.at.get(f.date);
        const pct = Number(f.float_ratio_pct ?? 0);
        if (!time || !Number.isFinite(pct) || pct === 0) continue;
        const cur = perBar.get(time) ?? { sum: 0, topId: f.investor_type, topPct: 0 };
        cur.sum += pct;
        if (Math.abs(pct) > Math.abs(cur.topPct)) { cur.topId = f.investor_type; cur.topPct = pct; }
        perBar.set(time, cur);
      }
    }
    const strong = [...perBar.entries()]
      .filter(([, v]) => Math.abs(v.sum) >= flowMin)
      .sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum));

    // 라벨을 전부 달면 매수세가 몰린 구간에서 글자가 겹쳐 아무것도 못 읽는다.
    // 화살표는 모두 두되 글자는 큰 것부터 붙이고, 이미 붙인 라벨과 MIN_GAP 봉
    // 안쪽이면 건너뛴다. 개수 제한만으로는 한 구간에 몰려 여전히 겹친다.
    const MAX_LABELS = 6;
    const MIN_GAP = Math.max(4, Math.round(view.bars.length / 14));
    const barIndex = new Map(view.bars.map((b, i) => [b.date, i]));
    const taken: number[] = [];
    const labelled = new Set<string>();
    for (const [time] of strong) {
      if (labelled.size >= MAX_LABELS) break;
      const i = barIndex.get(time);
      if (i === undefined || taken.some((j) => Math.abs(j - i) < MIN_GAP)) continue;
      taken.push(i);
      labelled.add(time);
    }

    const biggest = strong.length > 0 ? Math.abs(strong[0][1].sum) : 1;
    const flowMarks: SeriesMarker<Time>[] = strong.map(([time, v]) => {
      const buy = v.sum >= 0;
      const share = Math.abs(v.sum) / biggest;
      // 주체를 하나만 골랐으면 이름이 매번 같아 군더더기다. 숫자만 남긴다.
      const name = picked.length === 1 ? '' : `${investorLabels[v.topId] ?? v.topId} `;
      return {
        time: time as Time,
        position: 'belowBar',
        color: buy ? t.up : t.down,
        shape: buy ? 'arrowUp' : 'arrowDown',
        size: share > 0.6 ? 1.6 : share > 0.25 ? 1.15 : 0.85,
        text: labelled.has(time) ? `${name}${buy ? '+' : ''}${v.sum.toFixed(2)}%` : '',
      };
    });

    const markers = [...patternMarkers, ...flowMarks].sort((a, b) =>
      String(a.time).localeCompare(String(b.time)),
    );
    const api: ISeriesMarkersPluginApi<Time> =
      markersRef.current ?? (markersRef.current = createSeriesMarkers(candles, []));
    api.setMarkers(markers);

    const lines = geometry.lines.map((l, i) =>
      candles.createPriceLine({
        price: (l.p1 + l.p2) / 2,
        color: t.mark,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: i === 0 ? (activePattern?.pattern === 'cup_with_handle' ? '컵 테두리' : '넥라인') : '',
      }),
    );

    // 깃발·삼각형·쐐기·박스권은 evidence 에 좌표가 없다.
    // 그래도 돌파선은 늘 있으므로 이것만은 무조건 그려 패턴이 "안 보이는" 일이 없게 한다.
    const pivotLine =
      geometry.pivotPrice !== undefined
        ? [
            candles.createPriceLine({
              price: geometry.pivotPrice,
              color: t.mark,
              lineWidth: 2,
              lineStyle: 0,
              axisLabelVisible: true,
              title: `돌파선${geometry.stage ? ` · ${STAGE_LABEL[geometry.stage] ?? geometry.stage}` : ''}`,
            }),
          ]
        : [];

    // 라인분석이 뽑은 변곡점 지지/저항선. 강한 선만 얹어 차트를 어지럽히지 않는다.
    const supports = showLines
      ? supportLines
          .slice(0, 6)
          .map((l) =>
            candles.createPriceLine({
              price: l.price,
              color: l.kind === 'support' ? t.ok : t.mark,
              lineWidth: 1,
              lineStyle: 1,
              axisLabelVisible: true,
              title: `${l.kind === 'support' ? '지지' : '저항'} ${l.touches}회`,
            }),
          )
      : [];
    const timers = [0, 80, 300].map((ms) => window.setTimeout(() => setOverlayTick((x) => x + 1), ms));

    return () => {
      timers.forEach(window.clearTimeout);
      lines.forEach((l) => candles.removePriceLine(l));
      pivotLine.forEach((l) => candles.removePriceLine(l));
      supports.forEach((l) => candles.removePriceLine(l));
    };
  }, [geometry, activePattern, view, ready, flowMarkers, supportLines, investorLabels, showFlow, showLines, picked, flowMin]);

  /* ─── 차트 생성 ─── */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const t = readTheme();
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        // 유리 카드가 비쳐야 하므로 캔버스를 칠하지 않는다.
        background: { color: 'rgba(0,0,0,0)' },
        textColor: t.text,
        fontSize: 11,
        fontFamily: "'Pretendard', system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { borderColor: t.border, rightOffset: 6 },
      crosshair: {
        vertLine: { color: t.accent, labelBackgroundColor: t.accent },
        horzLine: { color: t.accent, labelBackgroundColor: t.accent },
      },
      localization: { locale: 'ko-KR' },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      borderUpColor: t.up,
      borderDownColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
    });
    // 거래량은 별도 페인에 둔다. 같은 가격축 아래쪽에 얹으면 눈금이 데이터 구간
    // 바깥까지 이어져 "-25,000원" 같은 없는 가격이 축에 찍힌다.
    // 값 폭이 좁을 땐 안 보이다가 18개월치를 넣자마자 드러났다.
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' }, 1);
    const panes = chart.panes();
    if (panes[1]) panes[1].setHeight(96);

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;

    const redraw = () => setOverlayTick((x) => x + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const ro = new ResizeObserver(redraw);
    ro.observe(host);

    // 테마 토글 시 차트 색을 다시 입힌다.
    const themeObserver = new MutationObserver(() => {
      const nt = readTheme();
      chart.applyOptions({
        layout: { background: { color: 'rgba(0,0,0,0)' }, textColor: nt.text },
        grid: { vertLines: { color: nt.grid }, horzLines: { color: nt.grid } },
        rightPriceScale: { borderColor: nt.border },
        timeScale: { borderColor: nt.border },
        crosshair: {
          vertLine: { color: nt.accent, labelBackgroundColor: nt.accent },
          horzLine: { color: nt.accent, labelBackgroundColor: nt.accent },
        },
      });
      candles.applyOptions({
        upColor: nt.up, downColor: nt.down,
        borderUpColor: nt.up, borderDownColor: nt.down,
        wickUpColor: nt.up, wickDownColor: nt.down,
      });
      setOverlayTick((x) => x + 1);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    setReady(true);

    return () => {
      setReady(false);
      markersRef.current = null;
      themeObserver.disconnect();
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      priceLinesRef.current.clear();
    };
  }, []);

  /* ─── 데이터 주입 ─── */
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles || !volume || view.bars.length === 0) return;
    const t = readTheme();

    candles.setData(
      view.bars.map((b) => ({ time: b.date as Time, open: n(b.o), high: n(b.h), low: n(b.l), close: n(b.c) })),
    );
    volume.setData(
      view.bars.map((b) => ({
        time: b.date as Time,
        value: n(b.volume),
        color: n(b.c) >= n(b.o) ? t.upSoft : t.downSoft,
      })),
    );
    chart.timeScale().fitContent();

    // fitContent 는 다음 프레임에 반영된다. 그 전에는 timeToCoordinate 가 null 을 돌려주므로
    // 좌표가 잡힐 때까지 몇 번 더 오버레이를 다시 계산한다.
    const timers = [0, 60, 200, 600].map((ms) => window.setTimeout(() => setOverlayTick((x) => x + 1), ms));
    return () => timers.forEach(window.clearTimeout);
  }, [view]);

  /* ─── 저장된 도형 불러오기 ─── */
  useEffect(() => {
    fetch(`/api/drawings?symbol=${symbol}`)
      .then((r) => r.json())
      .then((d) => setDrawings(Array.isArray(d.drawings) ? (d.drawings as Drawing[]) : []))
      .catch(() => setDrawings([]));
  }, [symbol]);

  /* ─── 수평선 반영 ─── */
  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const t = readTheme();
    const live = priceLinesRef.current;
    const want = new Set(drawings.filter((d) => d.type === 'hline').map((d) => d.id));

    for (const [id, line] of live) {
      if (!want.has(id)) {
        candles.removePriceLine(line);
        live.delete(id);
      }
    }
    for (const d of drawings) {
      if (d.type !== 'hline' || live.has(d.id)) continue;
      live.set(
        d.id,
        candles.createPriceLine({
          price: d.price,
          color: t.fg,
          lineWidth: 2,
          axisLabelVisible: true,
          title: d.label ?? '지지선',
        }),
      );
    }
    setOverlayTick((x) => x + 1);
  }, [drawings]);

  /* ─── 저장 ─── */
  const persist = useCallback(
    async (next: Drawing[]) => {
      setSaved('saving');
      await fetch(`/api/drawings?symbol=${symbol}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      setSaved('ok');
      setTimeout(() => setSaved('idle'), 1500);
    },
    [symbol],
  );

  const commit = useCallback(
    (next: Drawing[]) => {
      setDrawings(next);
      void persist(next);
    },
    [persist],
  );

  /* ─── 클릭으로 그리기 ─── */
  const onHostClick = useCallback(
    (ev: React.MouseEvent<HTMLDivElement>) => {
      if (mode === 'none') return;
      const chart = chartRef.current;
      const candles = candleRef.current;
      const host = hostRef.current;
      if (!chart || !candles || !host) return;

      const rect = host.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const price = candles.coordinateToPrice(y);
      if (price === null) return;

      if (mode === 'hline') {
        commit([...drawings, { id: uid(), type: 'hline', price: Number(Number(price).toFixed(2)) }]);
        setMode('none');
        return;
      }

      const time = chart.timeScale().coordinateToTime(x);
      if (time === null) return;
      const t = String(time);
      if (!pending) {
        setPending({ t, p: Number(price) });
      } else {
        commit([
          ...drawings,
          { id: uid(), type: 'trend', t1: pending.t, p1: pending.p, t2: t, p2: Number(price) },
        ]);
        setPending(null);
        setMode('none');
      }
    },
    [mode, drawings, pending, commit],
  );

  /* ─── SVG 오버레이 좌표 계산 ─── */
  const overlay = useMemo(() => {
    void overlayTick;
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles) return { trends: [], points: [], lines: [] };

    const ts = chart.timeScale();
    // 주·월봉에서는 일자를 묶인 봉의 시각으로 바꿔야 좌표가 잡힌다.
    const xy = (t: string, p: number) => {
      const time = view.at.get(t);
      if (!time) return null;
      const x = ts.timeToCoordinate(time as Time);
      const y = candles.priceToCoordinate(p);
      return x === null || y === null ? null : { x, y };
    };

    const trends = drawings
      .filter((d): d is Extract<Drawing, { type: 'trend' }> => d.type === 'trend')
      .map((d) => {
        const a = xy(d.t1, d.p1);
        const b = xy(d.t2, d.p2);
        return a && b ? { id: d.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null;
      })
      .filter((v) => v !== null);

    const points = geometry.points
      .map((p) => {
        const c = xy(p.t, p.price);
        return c ? { ...p, ...c } : null;
      })
      .filter((v) => v !== null);

    const lines = geometry.lines
      .map((l, i) => {
        const a = xy(l.t1, l.p1);
        const b = xy(l.t2, l.p2);
        return a && b ? { id: `g${i}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y, dashed: l.dashed } : null;
      })
      .filter((v) => v !== null);

    return { trends, points, lines };
  }, [drawings, geometry, overlayTick, view]);

  return (
    <div className="card">
      <div className="panel-head !flex-col !items-stretch gap-2.5">
        {/* 첫 줄: 무엇을 보는가 (봉 주기·겹쳐 볼 패턴) + 그리기 도구 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg" role="group" aria-label="봉 주기">
            {(['D', 'W', 'M'] as TF[]).map((k) => (
              <button
                key={k}
                type="button"
                data-on={tf === k ? 'true' : 'false'}
                aria-pressed={tf === k}
                onClick={() => setTf(k)}
              >
                {TF_KO[k]}
              </button>
            ))}
          </div>
          <span className="text-[11.5px] text-faint">{view.bars.length}봉</span>

          {patterns.length > 0 && (
            <select
              value={showPattern}
              onChange={(e) => setShowPattern(Number(e.target.value))}
              className="input !py-1 !text-[12px]"
              aria-label="겹쳐 볼 패턴"
            >
              {patterns.map((p, i) => (
                <option key={`${p.pattern}-${p.date ?? ''}-${i}`} value={i}>
                  {PATTERN_KO[p.pattern] ?? p.pattern}
                  {p.stage ? ` · ${STAGE_LABEL[p.stage] ?? p.stage}` : ''} (점수 {Number(p.score).toFixed(0)})
                </option>
              ))}
            </select>
          )}

          <span className="ml-1 text-[12px] text-faint">그리기</span>
          <button
            onClick={() => { setMode(mode === 'hline' ? 'none' : 'hline'); setPending(null); }}
            className="chip"
            data-on={mode === 'hline' ? 'true' : 'false'}
          >
            수평선
          </button>
          <button
            onClick={() => { setMode(mode === 'trend' ? 'none' : 'trend'); setPending(null); }}
            className="chip"
            data-on={mode === 'trend' ? 'true' : 'false'}
          >
            추세선
          </button>
          <button onClick={() => commit([])} className="chip">지우기</button>
          <span className="text-[11.5px] text-faint">
            {mode === 'hline' && '차트를 누르면 그 가격에 선을 그려요'}
            {mode === 'trend' && (pending ? '끝점을 눌러 주세요' : '시작점을 눌러 주세요')}
            {mode === 'none' && `도형 ${drawings.length}개`}
          </span>
          <span className="ml-auto text-[11.5px] text-faint">
            {saved === 'saving' ? '저장 중' : saved === 'ok' ? '저장됨' : ''}
          </span>
        </div>

        {/* 둘째 줄: 봉 위에 무엇을 얹는가 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line pt-2.5">
          <button
            className="chip"
            data-on={showFlow ? 'true' : 'false'}
            aria-pressed={showFlow}
            onClick={() => setShowFlow((v) => !v)}
          >
            수급 마커
          </button>
          <button
            className="chip"
            data-on={showLines ? 'true' : 'false'}
            aria-pressed={showLines}
            onClick={() => setShowLines((v) => !v)}
          >
            지지·저항선
          </button>

          {showFlow && flowTypes.length > 0 && (
            <>
              <span className="ml-1 text-[12px] text-faint">주체</span>
              <button
                className="chip"
                data-on={flowPick === null ? 'true' : 'false'}
                aria-pressed={flowPick === null}
                onClick={() => setFlowPick(null)}
              >
                전체
              </button>
              {flowTypes.map((id) => {
                const on = flowPick !== null && flowPick.includes(id);
                return (
                  <button
                    key={id}
                    className="chip"
                    data-on={on ? 'true' : 'false'}
                    aria-pressed={on}
                    onClick={() =>
                      // 전체 상태에서 하나를 누르면 그것만 보는 게 자연스럽다.
                      // 그래서 null 은 빈 목록에서 시작한다.
                      setFlowPick((cur) => {
                        const base = cur ?? [];
                        return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
                      })
                    }
                  >
                    {investorLabels[id] ?? id}
                  </button>
                );
              })}

              <span className="ml-1 text-[12px] text-faint">최소</span>
              <div className="seg" role="group" aria-label="마커 최소 강도">
                {[0, 0.1, 0.3, 0.5].map((v) => (
                  <button
                    key={v}
                    type="button"
                    data-on={flowMin === v ? 'true' : 'false'}
                    aria-pressed={flowMin === v}
                    onClick={() => setFlowMin(v)}
                  >
                    {v === 0 ? '전체' : `${v}%`}
                  </button>
                ))}
              </div>
              {picked.length === 0 && <span className="text-[11.5px] text-warn">주체를 하나 이상 골라 주세요</span>}
            </>
          )}
        </div>
      </div>

      <div className="relative">
        <div
          ref={hostRef}
          onClick={onHostClick}
          className="chart-host h-[min(68vh,620px)] w-full"
          style={{ cursor: mode === 'none' ? 'crosshair' : 'copy' }}
        />
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          {overlay.trends.map((t) => (
            <line key={t.id} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke="var(--fg)" strokeWidth={2} />
          ))}
          {overlay.lines.map((l) => (
            <line
              key={l.id}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke="var(--gold)"
              strokeWidth={1.5}
              strokeDasharray={l.dashed ? '5 4' : undefined}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
