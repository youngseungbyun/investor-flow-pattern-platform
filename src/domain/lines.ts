/**
 * 라인분석 — 변곡점 지지/저항선 + 거래량 돌파 눌림목 + 이평선 지지.
 *
 * 1) 스윙 변곡점을 가격대로 묶어 수평선을 만든다. 여러 번 닿을수록 강한 선이다.
 * 2) 평소보다 큰 거래량으로 저항선을 뚫은 뒤, 그 선까지 되돌려 지지받고 있으면
 *    "돌파 후 눌림목"으로 잡는다.
 * 3) 3일선·5일선에서 지지가 나왔는지 본다. 패턴 조건과는 조건 빌더에서 AND 로 엮는다.
 */
import { bulkInsert, exec, query } from '../lib/core';
import { swingHighs, swingLows, type Bar } from './patterns';

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

/** 가격이 tolPct 이내면 같은 선으로 묶는다. */
export function detectLines(bars: Bar[], pivotK = 5, tolPct = 1.5): SupportLine[] {
  const last = bars.length - 1;
  if (last < 20) return [];

  const pts: Array<{ i: number; price: number; kind: 'support' | 'resistance' }> = [
    ...swingLows(bars, pivotK).map((i) => ({ i, price: bars[i].l, kind: 'support' as const })),
    ...swingHighs(bars, pivotK).map((i) => ({ i, price: bars[i].h, kind: 'resistance' as const })),
  ].sort((a, b) => a.price - b.price);

  const clusters: Array<Array<{ i: number; price: number; kind: 'support' | 'resistance' }>> = [];
  for (const p of pts) {
    const cur = clusters[clusters.length - 1];
    if (cur && (Math.abs(p.price - cur[0].price) / cur[0].price) * 100 <= tolPct) cur.push(p);
    else clusters.push([p]);
  }

  const close = bars[last].c;
  return clusters
    .filter((c) => c.length >= 2)
    .map((c) => {
      const price = avg(c.map((p) => p.price));
      const idxs = c.map((p) => p.i).sort((a, b) => a - b);
      const supports = c.filter((p) => p.kind === 'support').length;
      const recency = clamp01((idxs[idxs.length - 1] - (last - 120)) / 120);
      const strength = round(clamp01(c.length / 5) * 70 + recency * 30, 2);
      return {
        lineId: `L${Math.round(price)}`,
        price: round(price),
        kind: (price <= close ? 'support' : 'resistance') as 'support' | 'resistance',
        touches: c.length,
        firstAt: bars[idxs[0]].date,
        lastAt: bars[idxs[idxs.length - 1]].date,
        strength: supports >= c.length / 2 ? strength : round(strength * 0.9, 2),
      };
    })
    .sort((a, b) => b.strength - a.strength)
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
       from support_lines where symbol = $1 and date = $2
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
