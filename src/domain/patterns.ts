/**
 * 차트 패턴 엔진 — 16종 카탈로그 + 단계(stage) 판정.
 *
 * 패턴 분류는 StockCharts ChartSchool 의 Chart Patterns 목차를 기준으로 삼았다.
 * 상승 8 / 하락 6 / 중립 2. 기하학적으로 일봉에서 판정 가능한 것만 넣었다.
 *
 * ── 왜 stage 가 핵심인가 ────────────────────────────────────────────────────
 * "패턴이 있다"만으로는 쓸모가 없다. 지금 그 패턴의 어디에 있는지가 중요하다.
 *   forming     : 구조는 성립하나 돌파선에서 멀다
 *   near_pivot  : 넥라인/돌파선 부근(기본 ±3%)
 *   breakout    : 돌파 직후(기본 3봉 이내)
 *   pullback    : 돌파 후 되돌려 돌파선 부근까지 온 눌림목. 돌파선은 지켰다
 *   failed      : 돌파 후 돌파선을 다시 잃었다
 * 수급 조건 빌더가 "사모가 크게 들어왔는데 지금 눌림목인 종목"을 뽑는 근거다.
 *
 * 오탐이 많은 게 정상이다. 모든 판정은 evidence 에 실제 수치를 남긴다.
 */
import { bulkInsert, query } from '../lib/core';

/* ─────────────────────────── 타입 ─────────────────────────── */

export interface Bar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
}

export type Direction = 'bullish' | 'bearish' | 'neutral';
export type PatternKind = 'reversal' | 'continuation' | 'bilateral';
export type Stage = 'forming' | 'near_pivot' | 'breakout' | 'pullback' | 'failed';

export interface Evidence extends Record<string, unknown> {
  score: number;
}

export interface PatternHit {
  symbol: string;
  pattern: string;
  direction: Direction;
  kind: PatternKind;
  stage: Stage;
  score: number;
  confirmed: boolean;
  pivotPrice: number | null;
  distancePct: number | null;
  breakoutDate: string | null;
  startDate: string | null;
  endDate: string | null;
  /** 돌파 후 지난 거래일 수. 돌파 전이면 null. */
  barsSinceBreakout: number | null;
  /** 구조가 완성된 뒤 지난 거래일 수. */
  barsSinceFormed: number;
  evidence: Evidence;
}

export interface PatternMeta {
  id: string;
  ko: string;
  direction: Direction;
  kind: PatternKind;
}

/** UI 필터·태깅이 참조하는 단일 카탈로그. */
export const PATTERN_CATALOG: PatternMeta[] = [
  { id: 'inverse_head_shoulders', ko: '역헤드앤숄더', direction: 'bullish', kind: 'reversal' },
  { id: 'double_bottom', ko: '쌍바닥', direction: 'bullish', kind: 'reversal' },
  { id: 'triple_bottom', ko: '삼중바닥', direction: 'bullish', kind: 'reversal' },
  { id: 'rounding_bottom', ko: '원형바닥', direction: 'bullish', kind: 'reversal' },
  { id: 'falling_wedge', ko: '하락쐐기', direction: 'bullish', kind: 'reversal' },
  { id: 'cup_with_handle', ko: '컵앤핸들', direction: 'bullish', kind: 'continuation' },
  { id: 'ascending_triangle', ko: '상승삼각형', direction: 'bullish', kind: 'continuation' },
  { id: 'bull_flag', ko: '상승깃발', direction: 'bullish', kind: 'continuation' },

  { id: 'head_and_shoulders', ko: '헤드앤숄더', direction: 'bearish', kind: 'reversal' },
  { id: 'double_top', ko: '쌍고점', direction: 'bearish', kind: 'reversal' },
  { id: 'triple_top', ko: '삼중천장', direction: 'bearish', kind: 'reversal' },
  { id: 'rising_wedge', ko: '상승쐐기', direction: 'bearish', kind: 'reversal' },
  { id: 'descending_triangle', ko: '하락삼각형', direction: 'bearish', kind: 'continuation' },
  { id: 'bear_flag', ko: '하락깃발', direction: 'bearish', kind: 'continuation' },

  { id: 'symmetrical_triangle', ko: '대칭삼각형', direction: 'neutral', kind: 'bilateral' },
  { id: 'rectangle', ko: '박스권', direction: 'neutral', kind: 'bilateral' },
];

export const PATTERN_BY_ID = new Map(PATTERN_CATALOG.map((p) => [p.id, p]));
export const patternKo = (id: string) => PATTERN_BY_ID.get(id)?.ko ?? id;

export const STAGE_KO: Record<Stage, string> = {
  forming: '형성중',
  near_pivot: '돌파선 부근',
  breakout: '돌파',
  pullback: '눌림목',
  failed: '돌파 실패',
};

/* ─────────────────────── 공통 프리미티브 ─────────────────────── */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number, d = 4) => Number(x.toFixed(d));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 좌우 k봉 피벗 저점 */
export function swingLows(bars: Bar[], k = 5): number[] {
  const out: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let ok = true;
    for (let j = i - k; j <= i + k; j++) if (j !== i && bars[j].l < bars[i].l) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

/** 좌우 k봉 피벗 고점 */
export function swingHighs(bars: Bar[], k = 5): number[] {
  const out: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let ok = true;
    for (let j = i - k; j <= i + k; j++) if (j !== i && bars[j].h > bars[i].h) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

function avgVolume(bars: Bar[], idx: number, n: number): number {
  return avg(bars.slice(Math.max(0, idx - n), idx).map((b) => b.volume));
}

/**
 * ATR(평균 실체범위). 이 종목에서 "의미 있는 움직임"의 단위를 준다.
 * 고정 퍼센트 임계값을 쓰면 변동성 큰 종목은 전부 통과하고 조용한 종목은 전부 탈락한다.
 */
function atr(bars: Bar[], n = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++) {
    const p = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p), Math.abs(bars[i].l - p)));
  }
  return avg(trs);
}

/**
 * ZigZag 방식 유의성 필터.
 * 기하학적 피벗(좌우 k봉 최저/최고)만으로는 잔물결도 전부 피벗이 된다.
 * 그 피벗을 기준으로 앞뒤로 minMove 이상 실제 반전이 있었을 때만 남긴다.
 * 쌍바닥의 두 저점처럼 높이가 같은 경우도 살아남는다(높이가 아니라 반전폭을 본다).
 */
function significant(bars: Bar[], idxs: number[], minMove: number, low: boolean, look = 60): number[] {
  const px = (i: number) => (low ? bars[i].l : bars[i].h);
  return idxs.filter((i) => {
    let before = px(i), after = px(i);
    for (let j = Math.max(0, i - look); j < i; j++) before = low ? Math.max(before, bars[j].h) : Math.min(before, bars[j].l);
    for (let j = i + 1; j <= Math.min(bars.length - 1, i + look); j++) {
      after = low ? Math.max(after, bars[j].h) : Math.min(after, bars[j].l);
    }
    const d1 = Math.abs(before - px(i));
    const d2 = Math.abs(after - px(i));
    return d1 >= minMove && d2 >= minMove;
  });
}

/**
 * 패턴 형성 구간에서 거래량이 마르는가.
 * 되돌림·컵·삼각형·깃발 모두 "형성 중 거래량 감소 → 돌파 시 급증"이 교과서 조건이다.
 * 반환값 < 1 이면 후반부가 더 한산했다는 뜻(좋은 신호).
 */
function volumeDryUp(bars: Bar[], startIdx: number, endIdx: number): number {
  if (endIdx - startIdx < 8) return 1;
  const mid = Math.floor((startIdx + endIdx) / 2);
  const first = avg(bars.slice(startIdx, mid).map((b) => b.volume));
  const second = avg(bars.slice(mid, endIdx + 1).map((b) => b.volume));
  return first > 0 ? second / first : 1;
}

/** 구간 평균 거래량. H&S 의 어깨-머리-어깨 거래량 순서 검증에 쓴다. */
function segVolume(bars: Bar[], a: number, b: number): number {
  return avg(bars.slice(Math.max(0, a), Math.min(bars.length, b + 1)).map((x) => x.volume));
}

/**
 * 최소제곱 직선 적합. r2 로 추세선 품질을 잰다.
 * 가격은 반드시 로그로 넣는다. 원가격에 적합하면 4,000원에서 8,000원이 된 종목의
 * 추세선이 후반부로 끌려간다(같은 %가 뒤로 갈수록 절대값이 커지기 때문).
 */
function linFit(pts: Array<[number, number]>): { slope: number; intercept: number; r2: number } {
  const n = pts.length;
  if (n < 2) return { slope: 0, intercept: pts[0]?.[1] ?? 0, r2: 0 };
  const mx = avg(pts.map((p) => p[0]));
  const my = avg(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 || sxx === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

/** 값들이 서로 얼마나 평평한가 (0 = 완전 동일) */
const flatness = (vals: number[]) => {
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  return mn === 0 ? 1 : (mx - mn) / mn;
};

/* ─────────────────────────── stage ─────────────────────────── */

export interface StageOptions {
  nearPct: number;
  breakoutBars: number;
  pullbackPct: number;
}
export const STAGE_DEFAULTS: StageOptions = { nearPct: 3, breakoutBars: 3, pullbackPct: 4 };

/**
 * 돌파선(pivot) 대비 현재 위치를 판정한다.
 * bullish 는 위로 뚫는 것이 돌파, bearish 는 아래로 이탈하는 것이 돌파다.
 */
export function computeStage(
  bars: Bar[],
  pivotAt: (i: number) => number,
  direction: Direction,
  fromIdx: number,
  opt: StageOptions = STAGE_DEFAULTS,
): { stage: Stage; breakoutIdx: number; distancePct: number; pivotNow: number; volumeRatio: number } {
  const last = bars.length - 1;
  const bearish = direction === 'bearish';
  const crossed = (i: number) => (bearish ? bars[i].c < pivotAt(i) : bars[i].c > pivotAt(i));

  let breakoutIdx = -1;
  for (let i = Math.max(fromIdx + 1, 1); i <= last; i++) {
    if (crossed(i) && !crossed(i - 1)) { breakoutIdx = i; break; }
  }

  const pivotNow = pivotAt(last);
  const close = bars[last].c;
  const distancePct = pivotNow === 0 ? 0 : ((close - pivotNow) / pivotNow) * 100;
  const volAvg = breakoutIdx >= 0 ? avgVolume(bars, breakoutIdx, 20) : 0;
  const volumeRatio = breakoutIdx >= 0 && volAvg > 0 ? bars[breakoutIdx].volume / volAvg : 0;

  let stage: Stage;
  if (breakoutIdx < 0) {
    stage = Math.abs(distancePct) <= opt.nearPct ? 'near_pivot' : 'forming';
  } else if (!crossed(last)) {
    stage = 'failed';
  } else if (last - breakoutIdx <= opt.breakoutBars) {
    stage = 'breakout';
  } else {
    stage = Math.abs(distancePct) <= opt.pullbackPct ? 'pullback' : 'forming';
  }

  return {
    stage,
    breakoutIdx,
    distancePct: round(distancePct, 2),
    pivotNow: round(pivotNow, 2),
    volumeRatio: round(volumeRatio, 2),
  };
}

/* ─────────────────────────── 탐지기 ─────────────────────────── */

type Draft = Omit<PatternHit, 'symbol' | 'direction' | 'kind'>;

function finish(
  patternId: string,
  bars: Bar[],
  pivotAt: (i: number) => number,
  fromIdx: number,
  startIdx: number,
  endIdx: number,
  baseScore: number,
  evidence: Record<string, unknown>,
): Draft {
  const meta = PATTERN_BY_ID.get(patternId);
  const direction = meta?.direction ?? 'neutral';
  const st = computeStage(bars, pivotAt, direction, fromIdx);

  // 돌파는 거래량이 실려야 인정한다. 기준선은 직전 20봉 평균의 1.5배(평소 대비 +50%)다.
  //   1.5배 이상  기본 14점 + 3배까지 8점 더
  //   1.0~1.5배   0 → 14점 선형
  //   1.0배 미만  감점. 평소보다 한산한 돌파는 되레 실패 확률이 높다
  // 예전 식(ratio/1.5 * 12)은 1.5배에서 상한이라 3배 돌파와 1.5배 돌파가 같은 점수였고,
  // 0.8배짜리 힘없는 돌파에도 만점의 절반을 줬다.
  const r = st.volumeRatio;
  const volBonus =
    st.breakoutIdx < 0
      ? 0
      : r >= 1.5
        ? 14 + clamp01((r - 1.5) / 1.5) * 8
        : r >= 1
          ? clamp01((r - 1) / 0.5) * 14
          : -8 * clamp01((1 - r) / 0.5);

  // 형성 중 거래량이 말랐는가. 후반부가 전반부의 70% 이하면 만점.
  const dry = volumeDryUp(bars, startIdx, endIdx);
  const dryBonus = clamp01((1.1 - dry) / 0.4) * 8;

  // 최신성 감쇠. 패턴 끝(돌파 전이면 endIdx, 돌파 후면 돌파봉)에서 오늘까지의
  // 경과 봉수가 늘수록 지수적으로 깎는다. 반감기 25봉.
  // 6개월 전에 완성된 패턴이 오늘 최상단에 오는 것이 기존 오탐의 최대 원인이었다.
  const last = bars.length - 1;
  const anchor = st.breakoutIdx >= 0 ? st.breakoutIdx : endIdx;
  const staleBars = Math.max(0, last - anchor);
  const freshness = Math.pow(0.5, staleBars / 25);
  const stagePenalty = st.stage === 'failed' ? -20 : 0;

  const raw = Math.max(0, baseScore + volBonus + dryBonus + stagePenalty);
  const score = Math.max(0, Math.min(100, round(raw * (0.45 + 0.55 * freshness), 2)));

  const lastIdx = bars.length - 1;
  // 돌파 후 경과 봉수. 돌파 전이면 null.
  const barsSinceBreakout = st.breakoutIdx >= 0 ? lastIdx - st.breakoutIdx : null;
  // 구조가 완성된(오른쪽 끝 봉) 뒤 경과 봉수. 돌파 여부와 무관하게 항상 있다.
  const barsSinceFormed = Math.max(0, lastIdx - endIdx);

  return {
    pattern: patternId,
    stage: st.stage,
    barsSinceBreakout,
    barsSinceFormed,
    score,
    confirmed: st.stage === 'breakout' || st.stage === 'pullback',
    pivotPrice: st.pivotNow,
    distancePct: st.distancePct,
    breakoutDate: st.breakoutIdx >= 0 ? bars[st.breakoutIdx].date : null,
    startDate: bars[startIdx]?.date ?? null,
    endDate: bars[endIdx]?.date ?? null,
    evidence: {
      ...evidence,
      score,
      stage: st.stage,
      pivotPrice: st.pivotNow,
      distancePct: st.distancePct,
      breakoutVolumeRatio: st.volumeRatio,
      breakoutDate: st.breakoutIdx >= 0 ? bars[st.breakoutIdx].date : null,
      barsSinceBreakout,
      barsSinceFormed,
      formationVolumeRatio: round(dry, 3),
      staleBars,
      freshness: round(freshness, 3),
    },
  };
}

/* ── 역헤드앤숄더 / 헤드앤숄더 ── */

function headShoulders(bars: Bar[], k: number, inverse: boolean): Draft | null {
  const pivots = inverse ? swingLows(bars, k) : swingHighs(bars, k);
  if (pivots.length < 3) return null;
  const px = (i: number) => (inverse ? bars[i].l : bars[i].h);
  /** 넥라인 앵커로 쓸 반대편 극점 */
  const anti = (i: number) => (inverse ? bars[i].h : bars[i].l);
  const pool = pivots.slice(-14);
  let best: Draft | null = null;

  for (let a = 0; a < pool.length - 2; a++) {
    for (let b = a + 1; b < pool.length - 1; b++) {
      for (let c = b + 1; c < pool.length; c++) {
        const [iL, iH, iR] = [pool[a], pool[b], pool[c]];
        const [L, H, R] = [px(iL), px(iH), px(iR)];

        // 머리가 양 어깨보다 확실히 더 나가야 한다.
        const headOk = inverse ? H < L && H < R : H > L && H > R;
        if (!headOk) continue;

        const segL = iH - iL, segR = iR - iH, span = iR - iL;
        if (segL < 5 || segR < 5 || span < 20 || span > 120) continue;

        // 가격 대칭. 두 어깨 높이가 비슷해야 한다.
        const sym = Math.abs(L - R) / Math.min(L, R);
        if (sym > 0.04) continue;

        // 시간 대칭. 한쪽 어깨가 다른 쪽의 3배를 넘으면 헤드앤숄더로 보기 어렵다.
        // 가격만 보면 좌우가 완전히 찌그러진 구조도 통과해 오탐이 늘어난다.
        const timeSym = Math.abs(segL - segR) / Math.max(segL, segR);
        if (timeSym > 0.6) continue;

        // 머리 깊이. 얕으면 그냥 잔파동이다.
        const depth = Math.abs(Math.min(L, R) - H) / Math.min(L, R);
        if (depth < 0.04) continue;

        // 넥라인은 어깨와 머리 "사이"의 반작용 극점 두 개를 잇는다.
        // 경계를 포함해 훑으면 앵커가 어깨나 머리 위로 올라가 선이 어긋난다.
        let iP1 = -1, iP2 = -1;
        for (let j = iL + 1; j < iH; j++) {
          if (iP1 < 0 || (inverse ? anti(j) > anti(iP1) : anti(j) < anti(iP1))) iP1 = j;
        }
        for (let j = iH + 1; j < iR; j++) {
          if (iP2 < 0 || (inverse ? anti(j) > anti(iP2) : anti(j) < anti(iP2))) iP2 = j;
        }
        if (iP1 < 0 || iP2 < 0 || iP2 <= iP1) continue;

        const P1 = anti(iP1);
        const P2 = anti(iP2);

        // 넥라인이 머리 반대편에 있어야 구조가 성립한다.
        if (inverse ? Math.min(P1, P2) <= H : Math.max(P1, P2) >= H) continue;

        // 넥라인 기울기가 과하면 삼각형·쐐기지 헤드앤숄더가 아니다.
        const priceScale = (P1 + P2) / 2 || 1;
        const slope = (P2 - P1) / (iP2 - iP1);
        const slopePctPerBar = Math.abs(slope / priceScale) * 100;
        if (slopePctPerBar > 0.35) continue;

        const neckAt = (i: number) => P1 + slope * (i - iP1);

        // 거래량. 전형적인 형태는 머리에서 크게 실리고 오른쪽 어깨에서 줄어든다.
        // 하드 필터로 쓰면 놓치는 게 많아 점수 가산으로만 쓴다.
        const volAt = (i: number, w: number) =>
          avg(bars.slice(Math.max(0, i - w), Math.min(bars.length, i + w + 1)).map((x) => x.volume));
        const volL = volAt(iL, 2);
        const volH = volAt(iH, 2);
        const volR = volAt(iR, 2);
        const volShape = volL > 0 && volR < volL ? 1 : 0;
        const volHead = volL > 0 && volH > volL ? 1 : 0;

        const base =
          clamp01(1 - sym / 0.04) * 30 +
          clamp01(1 - timeSym / 0.6) * 18 +
          clamp01(depth / 0.10) * 22 +
          clamp01(Math.min(segL, segR) / 12) * 10 +
          (volShape + volHead) * 5;

        const hit = finish(
          inverse ? 'inverse_head_shoulders' : 'head_and_shoulders',
          bars, neckAt, iR, iL, iR, base,
          {
            leftShoulder: { date: bars[iL].date, price: L },
            head: { date: bars[iH].date, price: H },
            rightShoulder: { date: bars[iR].date, price: R },
            shoulderSymmetry: round(sym),
            timeSymmetry: round(timeSym),
            headDepthPct: round(depth * 100, 2),
            segmentBars: { left: segL, right: segR },
            spanBars: span,
            necklineSlopePctPerBar: round(slopePctPerBar, 3),
            volumeShrinksIntoRightShoulder: volShape === 1,
            volumePeaksAtHead: volHead === 1,
            neckline: { p1: { date: bars[iP1].date, price: P1 }, p2: { date: bars[iP2].date, price: P2 } },
          },
        );
        if (!best || hit.score > best.score) best = hit;
      }
    }
  }
  return best;
}

/* ── 쌍바닥/쌍고점, 삼중바닥/삼중천장 ── */

function multiTouch(bars: Bar[], k: number, count: 2 | 3, bottom: boolean): Draft | null {
  const raw = bottom ? swingLows(bars, k) : swingHighs(bars, k);
  const pivots = significant(bars, raw, atr(bars) * 1.0, bottom);
  if (pivots.length < count) return null;
  const px = (i: number) => (bottom ? bars[i].l : bars[i].h);
  const pool = pivots.slice(-10);
  let best: Draft | null = null;

  const combos: number[][] = [];
  const build = (start: number, acc: number[]) => {
    if (acc.length === count) { combos.push([...acc]); return; }
    for (let i = start; i < pool.length; i++) build(i + 1, [...acc, pool[i]]);
  };
  build(0, []);

  for (const idxs of combos) {
    const vals = idxs.map(px);
    const flat = flatness(vals);
    if (flat > 0.04) continue;
    const span = idxs[idxs.length - 1] - idxs[0];
    if (span < 15 || span > 140) continue;
    let tooClose = false;
    for (let i = 1; i < idxs.length; i++) if (idxs[i] - idxs[i - 1] < 7) tooClose = true;
    if (tooClose) continue;

    let pivotIdx = idxs[0];
    for (let j = idxs[0]; j <= idxs[idxs.length - 1]; j++) {
      if (bottom ? bars[j].h > bars[pivotIdx].h : bars[j].l < bars[pivotIdx].l) pivotIdx = j;
    }
    const pivot = bottom ? bars[pivotIdx].h : bars[pivotIdx].l;
    const depth = Math.abs(pivot - avg(vals)) / pivot;
    if (depth < 0.05) continue;

    // 접점 사이마다 실제 반등이 있었는지 본다. 바닥에 눌러붙은 저점 나열은
    // 쌍바닥이 아니라 그냥 횡보다. 각 인접 접점 사이 최고점이
    // 접점 대비 패턴 깊이의 40% 이상 올라왔어야 한다.
    let bounced = true;
    for (let i = 1; i < idxs.length; i++) {
      let ext = bottom ? -Infinity : Infinity;
      for (let j = idxs[i - 1]; j <= idxs[i]; j++) ext = bottom ? Math.max(ext, bars[j].h) : Math.min(ext, bars[j].l);
      const bounce = Math.abs(ext - avg(vals)) / Math.abs(pivot - avg(vals));
      if (bounce < 0.4) { bounced = false; break; }
    }
    if (!bounced) continue;

    const id = count === 2 ? (bottom ? 'double_bottom' : 'double_top') : bottom ? 'triple_bottom' : 'triple_top';
    const base = clamp01(1 - flat / 0.04) * 45 + clamp01(depth / 0.15) * 25 + (count === 3 ? 15 : 10);

    const hit = finish(id, bars, () => pivot, idxs[idxs.length - 1], idxs[0], idxs[idxs.length - 1], base, {
      touches: idxs.map((i) => ({ date: bars[i].date, price: px(i) })),
      flatness: round(flat),
      depthPct: round(depth * 100, 2),
      pivot: { date: bars[pivotIdx].date, price: pivot },
      spanBars: span,
    });
    if (!best || hit.score > best.score) best = hit;
  }
  return best;
}

/* ── 컵앤핸들 / 원형바닥 ── */

function cupLike(bars: Bar[], k: number, withHandle: boolean): Draft | null {
  const highs = swingHighs(bars, k);
  if (highs.length < 2) return null;
  const last = bars.length - 1;
  let best: Draft | null = null;

  for (const iA of highs.slice(-12)) {
    for (const iC of highs.slice(-12)) {
      const cupBars = iC - iA;
      if (cupBars < 25 || cupBars > 150) continue;
      const A = bars[iA].h, C = bars[iC].h;
      const rim = Math.abs(A - C) / A;
      if (rim > 0.05) continue;

      let iB = iA;
      for (let j = iA; j <= iC; j++) if (bars[j].l < bars[iB].l) iB = j;
      const B = bars[iB].l;
      if (iB - iA < 3 || iC - iB < 3) continue;
      const depth = (A - B) / A;
      if (depth < 0.12 || depth > 0.5) continue;

      const zoneTop = B + (A - B) * 0.3;
      let bottomBars = 0;
      for (let j = iA; j <= iC; j++) if (bars[j].l <= zoneTop) bottomBars++;
      if (bottomBars < 7) continue;

      const evidence: Record<string, unknown> = {
        cupLeftRim: { date: bars[iA].date, price: A },
        cupBottom: { date: bars[iB].date, price: B },
        cupRightRim: { date: bars[iC].date, price: C },
        rimDiff: round(rim),
        depthPct: round(depth * 100, 2),
        cupBars,
        bottomBars,
      };
      let base =
        clamp01(1 - rim / 0.05) * 30 + clamp01(1 - Math.abs(depth - 0.28) / 0.22) * 25 + clamp01(bottomBars / 14) * 15;
      let fromIdx = iC;

      if (withHandle) {
        const handleEnd = Math.min(last, iC + 25);
        if (handleEnd - iC < 5) continue;
        let iHL = iC + 1;
        for (let j = iC + 1; j <= handleEnd; j++) if (bars[j].l < bars[iHL].l) iHL = j;
        const handleLow = bars[iHL].l;
        const retrace = (C - handleLow) / (A - B);
        if (retrace > 0.5) continue;
        if (handleLow <= (A + B) / 2) continue;
        evidence.handle = {
          lowDate: bars[iHL].date,
          low: handleLow,
          bars: handleEnd - iC,
          retraceOfCupDepth: round(retrace),
        };
        base += clamp01(1 - retrace / 0.5) * 10;
        fromIdx = iHL;
      } else if (last > iC + 5) {
        // 원형바닥은 핸들이 없어야 한다. 얕은 조정이 보이면 컵앤핸들 쪽으로 넘긴다.
        let iHL = iC + 1;
        for (let j = iC + 1; j <= Math.min(last, iC + 25); j++) if (bars[j].l < bars[iHL].l) iHL = j;
        const retrace = (C - bars[iHL].l) / (A - B);
        if (retrace <= 0.5 && retrace > 0.05) continue;
      }

      const hit = finish(withHandle ? 'cup_with_handle' : 'rounding_bottom', bars, () => C, fromIdx, iA, iC, base, evidence);
      if (!best || hit.score > best.score) best = hit;
    }
  }
  return best;
}

/* ── 삼각형 / 쐐기 / 박스권 ── */

function trendlinePatterns(bars: Bar[], k: number): Draft[] {
  const out: Draft[] = [];
  const highs = swingHighs(bars, k).slice(-6);
  const lows = swingLows(bars, k).slice(-6);
  if (highs.length < 3 || lows.length < 3) return out;

  const startIdx = Math.min(highs[0], lows[0]);
  const endIdx = Math.max(highs[highs.length - 1], lows[lows.length - 1]);
  const span = endIdx - startIdx;
  if (span < 20 || span > 160) return out;

  // 로그 적합: 추세선이 가격 수준에 끌리지 않게 한다. 기울기는 %/봉이 된다.
  const upper = linFit(highs.map((i) => [i, Math.log(bars[i].h)] as [number, number]));
  const lower = linFit(lows.map((i) => [i, Math.log(bars[i].l)] as [number, number]));
  // 양쪽 모두 어느 정도 직선이어야 "수렴 패턴"이라 부를 수 있다.
  // 기존(한쪽만 0.35)에서는 한쪽 추세선이 사실상 무작위여도 통과했다.
  if (upper.r2 < 0.45 || lower.r2 < 0.45) return out;

  const upSlopePct = upper.slope * 100;
  const loSlopePct = lower.slope * 100;
  const FLAT = 0.06;

  const upAt = (i: number) => Math.exp(upper.intercept + upper.slope * i);
  const loAt = (i: number) => Math.exp(lower.intercept + lower.slope * i);
  const fitScore = ((clamp01(upper.r2) + clamp01(lower.r2)) / 2) * 45 + clamp01(span / 60) * 15;

  const push = (id: string, pivotAt: (i: number) => number, bonus: number) => {
    out.push(
      finish(id, bars, pivotAt, endIdx, startIdx, endIdx, fitScore + bonus, {
        upperSlopePctPerBar: round(upSlopePct, 4),
        lowerSlopePctPerBar: round(loSlopePct, 4),
        upperR2: round(upper.r2, 3),
        lowerR2: round(lower.r2, 3),
        spanBars: span,
        upperAtLastBar: round(upAt(bars.length - 1), 2),
        lowerAtLastBar: round(loAt(bars.length - 1), 2),
      }),
    );
  };

  const upFlat = Math.abs(upSlopePct) < FLAT;
  const loFlat = Math.abs(loSlopePct) < FLAT;

  if (upFlat && loSlopePct > FLAT) push('ascending_triangle', upAt, 15);
  else if (loFlat && upSlopePct < -FLAT) push('descending_triangle', loAt, 15);
  else if (upFlat && loFlat) push('rectangle', upAt, 5);
  else if (upSlopePct < -FLAT && loSlopePct > FLAT) push('symmetrical_triangle', upAt, 10);
  else if (upSlopePct > FLAT && loSlopePct > FLAT && upSlopePct < loSlopePct) push('rising_wedge', loAt, 10);
  else if (upSlopePct < -FLAT && loSlopePct < -FLAT && upSlopePct > loSlopePct) push('falling_wedge', upAt, 10);

  return out;
}

/* ── 깃발 (급등/급락 후 좁은 채널) ── */

function flag(bars: Bar[], bull: boolean): Draft | null {
  const last = bars.length - 1;
  if (bars.length < 40) return null;
  let best: Draft | null = null;

  for (let poleLen = 5; poleLen <= 15; poleLen++) {
    for (let flagLen = 5; flagLen <= 20; flagLen++) {
      const flagStart = last - flagLen;
      const poleStart = flagStart - poleLen;
      if (poleStart < 5) continue;

      const p0 = bars[poleStart].c, p1 = bars[flagStart].c;
      const move = (p1 - p0) / p0;
      if (bull ? move < 0.12 : move > -0.12) continue;

      const seg = bars.slice(flagStart, last + 1);
      const hi = Math.max(...seg.map((b) => b.h));
      const lo = Math.min(...seg.map((b) => b.l));
      const range = (hi - lo) / p1;
      if (range > Math.abs(move) * 0.6) continue;

      const upper = linFit(seg.map((b, i) => [flagStart + i, Math.log(b.h)] as [number, number]));
      const lower = linFit(seg.map((b, i) => [flagStart + i, Math.log(b.l)] as [number, number]));
      if (bull ? upper.slope > 0 : upper.slope < 0) continue;
      // 깃발은 좁은 평행 채널이다. 채널이 직선이 아니면(잡음 밀집) 깃발이 아니다.
      if (upper.r2 < 0.4 && lower.r2 < 0.4) continue;

      const pivotAt = bull
        ? (i: number) => Math.exp(upper.intercept + upper.slope * i)
        : (i: number) => Math.exp(lower.intercept + lower.slope * i);

      const base = clamp01(Math.abs(move) / 0.3) * 35 + clamp01(1 - range / (Math.abs(move) * 0.6)) * 25 + 10;
      const hit = finish(bull ? 'bull_flag' : 'bear_flag', bars, pivotAt, last - 1, poleStart, last, base, {
        polePct: round(move * 100, 2),
        poleBars: poleLen,
        flagBars: flagLen,
        flagRangePct: round(range * 100, 2),
        flagUpperSlope: round(upper.slope, 4),
      });
      if (!best || hit.score > best.score) best = hit;
    }
  }
  return best;
}

/* ─────────────────────────── 스캔 ─────────────────────────── */

export function detectAll(symbol: string, bars: Bar[], pivotK = 5): PatternHit[] {
  if (bars.length < 40) return [];
  const hits: PatternHit[] = [];

  const add = (h: Draft | null) => {
    if (!h) return;
    const meta = PATTERN_BY_ID.get(h.pattern);
    if (!meta) return;
    hits.push({ ...h, symbol, direction: meta.direction, kind: meta.kind });
  };

  const runners: Array<() => Draft | null> = [
    () => headShoulders(bars, pivotK, true),
    () => headShoulders(bars, pivotK, false),
    () => multiTouch(bars, pivotK, 2, true),
    () => multiTouch(bars, pivotK, 2, false),
    () => multiTouch(bars, pivotK, 3, true),
    () => multiTouch(bars, pivotK, 3, false),
    () => cupLike(bars, pivotK, true),
    () => cupLike(bars, pivotK, false),
    () => flag(bars, true),
    () => flag(bars, false),
  ];

  for (const run of runners) {
    try { add(run()); } catch { /* 개별 탐지 실패는 무시 */ }
  }
  try { for (const h of trendlinePatterns(bars, pivotK)) add(h); } catch { /* 무시 */ }

  return dedupeOverlaps(hits);
}

/**
 * 구조 특이도. 조건이 까다로운 패턴일수록 높다.
 * 같은 바닥 구조가 역헤드앤숄더로도 쌍바닥으로도 잡히면(구간이 겹치면)
 * 더 특이한 쪽 하나만 남긴다. 중복 패턴이 화면 상단을 도배하는 것을 막는다.
 */
const SPECIFICITY: Record<string, number> = {
  inverse_head_shoulders: 9, head_and_shoulders: 9,
  cup_with_handle: 8,
  triple_bottom: 7, triple_top: 7,
  double_bottom: 6, double_top: 6,
  rounding_bottom: 5,
  ascending_triangle: 4, descending_triangle: 4,
  falling_wedge: 4, rising_wedge: 4,
  bull_flag: 3, bear_flag: 3,
  symmetrical_triangle: 2, rectangle: 1,
};

function dedupeOverlaps(hits: PatternHit[]): PatternHit[] {
  const idx = (d: string | null) => (d ? d : '');
  const sorted = [...hits].sort(
    (a, b) => (SPECIFICITY[b.pattern] ?? 0) - (SPECIFICITY[a.pattern] ?? 0) || b.score - a.score,
  );
  const kept: PatternHit[] = [];
  for (const h of sorted) {
    const clash = kept.some((k) => {
      if (k.direction !== h.direction) return false;
      const a1 = idx(h.startDate), a2 = idx(h.endDate);
      const b1 = idx(k.startDate), b2 = idx(k.endDate);
      if (!a1 || !a2 || !b1 || !b2) return false;
      const lo = a1 > b1 ? a1 : b1;
      const hi = a2 < b2 ? a2 : b2;
      if (lo >= hi) return false;
      // 겹친 길이 / 짧은 쪽 길이 > 60% 면 같은 구조로 본다.
      const span = (x: string, y: string) => new Date(y).getTime() - new Date(x).getTime();
      const overlap = span(lo, hi);
      const shorter = Math.min(span(a1, a2), span(b1, b2));
      return shorter > 0 && overlap / shorter > 0.6;
    });
    if (!clash) kept.push(h);
  }
  return kept;
}

export async function loadBars(symbol: string, asOf: string, limit = 220): Promise<Bar[]> {
  const rows = await query<{ date: string; o: string; h: string; l: string; c: string; volume: string }>(
    `select to_char(date,'YYYY-MM-DD') date, o, h, l, c, volume
       from ohlcv_daily
      where symbol = $1 and date <= $2 and c is not null
      order by date desc
      limit $3`,
    [symbol, asOf, limit],
  );
  return rows.reverse().map((r) => ({
    date: r.date,
    o: Number(r.o),
    h: Number(r.h),
    l: Number(r.l),
    c: Number(r.c),
    volume: Number(r.volume),
  }));
}

export async function scanSymbol(symbol: string, asOf: string): Promise<PatternHit[]> {
  return detectAll(symbol, await loadBars(symbol, asOf));
}

export async function saveHits(hits: PatternHit[], date: string): Promise<number> {
  if (!hits.length) return 0;
  return bulkInsert(
    'pattern_hits',
    ['symbol', 'date', 'pattern', 'score', 'evidence_json', 'confirmed',
      'direction', 'kind', 'stage', 'pivot_price', 'breakout_date', 'start_date', 'end_date', 'distance_pct',
      'bars_since_breakout', 'bars_since_formed'],
    hits.map((h) => [
      h.symbol, date, h.pattern, h.score, JSON.stringify(h.evidence), h.confirmed,
      h.direction, h.kind, h.stage, h.pivotPrice, h.breakoutDate, h.startDate, h.endDate, h.distancePct,
      h.barsSinceBreakout, h.barsSinceFormed,
    ]),
    `on conflict (symbol, date, pattern) do update set
       score = excluded.score,
       evidence_json = excluded.evidence_json,
       confirmed = excluded.confirmed,
       direction = excluded.direction,
       kind = excluded.kind,
       stage = excluded.stage,
       pivot_price = excluded.pivot_price,
       breakout_date = excluded.breakout_date,
       start_date = excluded.start_date,
       end_date = excluded.end_date,
       distance_pct = excluded.distance_pct,
       bars_since_breakout = excluded.bars_since_breakout,
       bars_since_formed = excluded.bars_since_formed`,
  );
}
