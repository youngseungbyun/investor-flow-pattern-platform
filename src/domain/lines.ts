/**
 * 라인분석 — 변곡점 지지/저항선 + 거래량 돌파 눌림목 + 이평선 지지.
 *
 * 1) 스윙 변곡점을 가격대로 묶어 수평선을 만든다. 여러 번 닿을수록 강한 선이다.
 * 2) 평소보다 큰 거래량으로 저항선을 뚫은 뒤, 그 선까지 되돌려 지지받고 있으면
 *    "돌파 후 눌림목"으로 잡는다.
 * 3) 3일선·5일선에서 지지가 나왔는지 본다. 패턴 조건과는 조건 빌더에서 AND 로 엮는다.
 */
import { bulkInsert, exec, query } from '../lib/core';
import { atr, swingHighs, swingLows, type Bar } from './patterns';

const round = (x: number, d = 2) => Number(x.toFixed(d));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface SupportLine {
  lineId: string;
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  firstAt: string;
  lastAt: string;
  strength: number;
}

export interface LineSignal {
  symbol: string;
  signal: 'volume_breakout_pullback' | 'ma_support' | 'line_retest';
  score: number;
  detail: Record<string, unknown>;
}

export const SIGNAL_KO: Record<string, string> = {
  volume_breakout_pullback: '거래량 돌파 후 눌림목',
  ma_support: '이평선 지지',
  line_retest: '지지선 재테스트',
};

/* ─────────────────── 1. 변곡점 수평선 추출 ─────────────────── */

/** 호가단위. 선 가격을 실제로 체결될 수 있는 가격으로 맞춘다. */
export function tickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/**
 * 변곡점 수평선.
 *
 * 예전에는 가격을 1.5% 고정 폭으로 묶고 터치 횟수와 최근성만 봤다. 그래서
 *  - 변동성 큰 종목은 같은 가격대인데도 선이 여러 개로 흩어지고
 *  - 조용한 종목은 서로 다른 가격대가 한 선으로 뭉쳤으며
 *  - 거래량이 실리지 않은 우연한 터치도 강한 선이 됐다.
 * 지금은
 *  1) 묶는 폭을 ATR(평균 진폭)에 비례시킨다(종가의 0.8~3%).
 *  2) 변곡점마다 그날 거래량이 평소의 몇 배였는지로 가중한다(매물이 쌓인 가격대).
 *  3) 닿은 뒤 5봉 안에 3% 이상 반대로 움직였는지(반등·되돌림 성공률)를 강도에 넣는다.
 *  4) 가격은 호가단위로 맞춘다.
 * strength = 터치(가중) 45 + 최근성 20 + 반등 성공률 25 + 방향 일치 10.
 */
export function detectLines(bars: Bar[], pivotK = 5, tolPct?: number): SupportLine[] {
  const last = bars.length - 1;
  if (last < 20) return [];

  const close = bars[last].c;
  const atrPct = close > 0 ? (atr(bars) / close) * 100 : 1.5;
  const tol = tolPct ?? Math.max(0.8, Math.min(3, atrPct * 0.55));

  type Pt = { i: number; price: number; kind: 'support' | 'resistance'; w: number; bounced: boolean };
  const volAt = (i: number) => {
    const from = Math.max(0, i - 20);
    const seg = bars.slice(from, i).map((b) => b.volume);
    const mean = avg(seg);
    return mean > 0 ? Math.max(0.5, Math.min(3, bars[i].volume / mean)) : 1;
  };
  const bounced = (i: number, support: boolean) => {
    const end = Math.min(last, i + 5);
    if (end <= i) return false;
    const ref = support ? bars[i].l : bars[i].h;
    for (let j = i + 1; j <= end; j++) {
      if (support ? bars[j].h >= ref * 1.03 : bars[j].l <= ref * 0.97) return true;
    }
    return false;
  };

  const pts: Pt[] = [
    ...swingLows(bars, pivotK).map((i) => ({ i, price: bars[i].l, kind: 'support' as const, w: volAt(i), bounced: bounced(i, true) })),
    ...swingHighs(bars, pivotK).map((i) => ({ i, price: bars[i].h, kind: 'resistance' as const, w: volAt(i), bounced: bounced(i, false) })),
  ].sort((a, b) => a.price - b.price);

  const clusters: Pt[][] = [];
  for (const p of pts) {
    const cur = clusters[clusters.length - 1];
    if (cur && (Math.abs(p.price - cur[0].price) / cur[0].price) * 100 <= tol) cur.push(p);
    else clusters.push([p]);
  }

  return clusters
    .filter((c) => c.length >= 2)
    .map((c) => {
      const raw = avg(c.map((p) => p.price));
      const tick = tickSize(raw);
      const price = Math.round(raw / tick) * tick;
      const idxs = c.map((p) => p.i).sort((a, b) => a - b);
      const supports = c.filter((p) => p.kind === 'support').length;
      const recency = clamp01((idxs[idxs.length - 1] - (last - 120)) / 120);
      // 거래량 가중 터치 수. 평소 거래량이면 1, 3배면 3 으로 센다.
      const weighted = c.reduce((a, p) => a + p.w, 0);
      const bounce = c.filter((p) => p.bounced).length / c.length;
      const sameSide = Math.max(supports, c.length - supports) / c.length;
      const strength = round(clamp01(weighted / 7) * 45 + recency * 20 + bounce * 25 + sameSide * 10, 2);
      return {
        lineId: `L${Math.round(price)}`,
        price: round(price),
        kind: (price <= close ? 'support' : 'resistance') as 'support' | 'resistance',
        touches: c.length,
        firstAt: bars[idxs[0]].date,
        lastAt: bars[idxs[idxs.length - 1]].date,
        strength,
      };
    })
    .sort((a, b) => b.strength - a.strength)
    // 호가단위로 맞추면 다른 묶음이 같은 가격이 될 수 있다. 같은 id 는 강한 쪽 하나만(PK 충돌 방지).
    .filter((l, i, arr) => arr.findIndex((x) => x.lineId === l.lineId) === i)
    .slice(0, 12);
}

/* ─────────── 2. 거래량 돌파 후 눌림목 ─────────── */

export interface BreakoutPullbackOptions {
  volumeMultiple: number;
  volumeWindow: number;
  pullbackPct: number;
  maxBarsSince: number;
  minBarsSince: number;
}
export const BP_DEFAULTS: BreakoutPullbackOptions = {
  volumeMultiple: 1.8,
  volumeWindow: 20,
  pullbackPct: 3,
  maxBarsSince: 25,
  minBarsSince: 2,
};

export function volumeBreakoutPullback(
  bars: Bar[],
  lines: SupportLine[],
  opt: BreakoutPullbackOptions = BP_DEFAULTS,
): Record<string, unknown> | null {
  const last = bars.length - 1;
  const close = bars[last].c;
  let best: (Record<string, unknown> & { _score: number }) | null = null;

  for (const line of lines) {
    if (close < line.price) continue; // 지금 그 선 위에 있어야 한다(저항 → 지지 전환)

    for (let i = last - opt.minBarsSince; i >= Math.max(1, last - opt.maxBarsSince); i--) {
      const crossedUp = bars[i].c > line.price && bars[i - 1].c <= line.price;
      if (!crossedUp) continue;

      const volAvg = avg(bars.slice(Math.max(0, i - opt.volumeWindow), i).map((b) => b.volume));
      if (volAvg <= 0) continue;
      const volRatio = bars[i].volume / volAvg;
      if (volRatio < opt.volumeMultiple) continue;

      const after = bars.slice(i + 1);
      if (after.some((b) => b.c < line.price * 0.985)) continue; // 선을 잃었으면 실패

      const distancePct = ((close - line.price) / line.price) * 100;
      if (distancePct > opt.pullbackPct) continue; // 아직 눌림목까지 안 왔다

      const barsSince = last - i;
      const pullbackLow = Math.min(...after.map((b) => b.l));
      const score = round(
        clamp01(volRatio / 3) * 40 +
          clamp01(1 - distancePct / opt.pullbackPct) * 30 +
          clamp01(line.touches / 5) * 20 +
          clamp01(1 - barsSince / opt.maxBarsSince) * 10,
        2,
      );
      if (!best || score > best._score) {
        best = {
          _score: score,
          line: { price: line.price, touches: line.touches, firstAt: line.firstAt, lastAt: line.lastAt },
          breakoutDate: bars[i].date,
          breakoutClose: bars[i].c,
          breakoutVolume: bars[i].volume,
          avgVolume: Math.round(volAvg),
          volumeRatio: round(volRatio),
          volumeRequired: opt.volumeMultiple,
          barsSinceBreakout: barsSince,
          currentClose: close,
          distanceToLinePct: round(distancePct),
          pullbackLow,
          heldLine: true,
        };
      }
    }
  }
  if (!best) return null;
  const { _score, ...detail } = best;
  return { ...detail, score: _score };
}

/* ─────────── 3. 이평선 지지 (3일 / 5일) ─────────── */

function sma(bars: Bar[], idx: number, n: number): number | null {
  if (idx + 1 < n || idx < 0) return null;
  return avg(bars.slice(idx + 1 - n, idx + 1).map((b) => b.c));
}

export interface MaSupportOptions {
  periods: number[];
  touchPct: number;
  lookback: number;
}
export const MA_DEFAULTS: MaSupportOptions = { periods: [3, 5], touchPct: 1.2, lookback: 3 };

export function maSupport(bars: Bar[], opt: MaSupportOptions = MA_DEFAULTS): Record<string, unknown> | null {
  const last = bars.length - 1;
  if (last < 25) return null;

  const hits: Array<Record<string, unknown>> = [];
  for (const p of opt.periods) {
    for (let i = last; i >= last - opt.lookback + 1; i--) {
      const ma = sma(bars, i, p);
      const maPrev = sma(bars, i - 1, p);
      if (ma === null || maPrev === null) continue;
      const gapPct = ((bars[i].l - ma) / ma) * 100;
      const touched = gapPct <= opt.touchPct; // 저가가 이평선까지 내려왔다
      const held = bars[i].c >= ma; // 종가는 이평선 위에서 마감
      const rising = ma > maPrev;
      if (touched && held && rising) {
        hits.push({
          period: p,
          date: bars[i].date,
          ma: round(ma),
          low: bars[i].l,
          close: bars[i].c,
          gapPct: round(gapPct),
          maRising: true,
        });
        break;
      }
    }
  }
  if (hits.length === 0) return null;

  const ma5 = sma(bars, last, 5);
  const ma20 = sma(bars, last, 20);
  const aboveMa20 = ma20 !== null && bars[last].c >= ma20;
  const score = round(clamp01(hits.length / 2) * 50 + (aboveMa20 ? 30 : 0) + 20, 2);
  return {
    supports: hits,
    ma5: ma5 === null ? null : round(ma5),
    ma20: ma20 === null ? null : round(ma20),
    aboveMa20,
    score,
  };
}

/* ─────────────────────────── 스캔 ─────────────────────────── */

export interface LineScanResult {
  lines: SupportLine[];
  signals: LineSignal[];
}

export function scanLines(symbol: string, bars: Bar[], pivotK = 5): LineScanResult {
  if (bars.length < 30) return { lines: [], signals: [] };
  const lines = detectLines(bars, pivotK);
  const signals: LineSignal[] = [];

  const bp = volumeBreakoutPullback(bars, lines);
  if (bp) signals.push({ symbol, signal: 'volume_breakout_pullback', score: Number(bp.score ?? 0), detail: bp });

  const ma = maSupport(bars);
  if (ma) signals.push({ symbol, signal: 'ma_support', score: Number(ma.score ?? 0), detail: ma });

  return { lines, signals };
}

/* ─────────────────────────── 저장 ─────────────────────────── */

export async function saveLines(symbol: string, date: string, lines: SupportLine[]): Promise<number> {
  if (!lines.length) return 0;
  return bulkInsert(
    'support_lines',
    ['symbol', 'date', 'line_id', 'price', 'kind', 'touches', 'first_at', 'last_at', 'strength'],
    lines.map((l) => [symbol, date, l.lineId, l.price, l.kind, l.touches, l.firstAt, l.lastAt, l.strength]),
    `on conflict (symbol, date, line_id) do update set
       price = excluded.price, kind = excluded.kind, touches = excluded.touches,
       first_at = excluded.first_at, last_at = excluded.last_at, strength = excluded.strength`,
  );
}

/** 전 종목의 선을 한 번에 넣는다. 종목마다 저장하면 왕복이 종목 수만큼 쌓인다. */
export async function saveLinesBatch(date: string, perSymbol: Array<[string, SupportLine[]]>): Promise<number> {
  const rows = perSymbol.flatMap(([symbol, lines]) =>
    lines.map((l) => [symbol, date, l.lineId, l.price, l.kind, l.touches, l.firstAt, l.lastAt, l.strength]),
  );
  if (!rows.length) return 0;
  return bulkInsert(
    'support_lines',
    ['symbol', 'date', 'line_id', 'price', 'kind', 'touches', 'first_at', 'last_at', 'strength'],
    rows,
    `on conflict (symbol, date, line_id) do update set
       price = excluded.price, kind = excluded.kind, touches = excluded.touches,
       first_at = excluded.first_at, last_at = excluded.last_at, strength = excluded.strength`,
  );
}

export async function saveSignals(signals: LineSignal[], date: string): Promise<number> {
  if (!signals.length) return 0;
  return bulkInsert(
    'line_signals',
    ['symbol', 'date', 'signal', 'score', 'detail_json'],
    signals.map((s) => [s.symbol, date, s.signal, s.score, JSON.stringify(s.detail)]),
    `on conflict (symbol, date, signal) do update set
       score = excluded.score, detail_json = excluded.detail_json`,
  );
}

/** 같은 날짜로 다시 스캔할 때 이전 결과를 지워 잔재를 막는다. */
export async function clearLineScan(date: string): Promise<void> {
  await exec(`delete from line_signals where date = $1`, [date]);
  await exec(`delete from support_lines where date = $1`, [date]);
}

/** 종목 상세 화면이 쓰는 조회 */
export async function linesForSymbol(symbol: string, date: string): Promise<SupportLine[]> {
  const rows = await query<{
    line_id: string; price: string; kind: string; touches: number;
    first_at: string; last_at: string; strength: string;
  }>(
    `select line_id, price, kind, touches,
            to_char(first_at,'YYYY-MM-DD') first_at, to_char(last_at,'YYYY-MM-DD') last_at, strength
       from support_lines
      where symbol = $1
        and date = (select max(date) from support_lines where symbol = $1 and date <= $2)
      order by strength desc`,
    [symbol, date],
  );
  return rows.map((r) => ({
    lineId: r.line_id,
    price: Number(r.price),
    kind: r.kind as 'support' | 'resistance',
    touches: r.touches,
    firstAt: r.first_at,
    lastAt: r.last_at,
    strength: Number(r.strength),
  }));
}
