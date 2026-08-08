/**
 * 분봉 provider — KIS(당일) + Yahoo Finance(과거 소급) 폴백.
 *
 * ── 왜 폴백이 필요한가 ──────────────────────────────────────────────────────
 * KIS 의 inquire-time-itemchartprice(FHKST03010200)는 요청 날짜와 무관하게
 * "최근 세션" 분봉만 돌려준다. 과거 특정일 분봉을 못 가져온다.
 *
 * 2026-08-07 실측으로 확인한 Yahoo Finance 소급 한계(삼성전자 005930.KS):
 *   1m  : 약 14일   (40일 전 요청은 Unprocessable Entity)
 *   5m  : 약 57일   (80일 전 요청은 빈 응답)
 *   1h  : 약 1.5년  (2025-02-10 정상)
 * OHLC 와 거래량이 모두 들어 있다(1분봉 361봉 중 359봉에 실거래량).
 * 코스닥도 동작한다(247540.KQ → KOSDAQ, KRW).
 *
 * 주의: Yahoo 응답에는 요청일 봉 뒤에 "당일 현재가" 1봉이 덧붙는다.
 *       요청한 날짜 범위로 잘라내야 엉뚱한 날 봉이 섞이지 않는다.
 *
 * 라이선스: Yahoo Finance 는 개인적·비상업적 사용 전제다.
 *          상용 배포 시에는 유료 소스로 교체해야 한다(README 참조).
 */
import { bulkInsert, fetchText, query, sleep } from '../lib/core';
import { fetchMinuteBars as kisFetchMinuteBars, kisConfigured } from './kis';

export type MinuteInterval = '1m' | '5m' | '15m' | '30m' | '1h';

export interface MinuteBar {
  symbol: string;
  ts: string; // ISO with +09:00
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  tradedValue: number;
  source: string;
}

export interface MinuteProvider {
  readonly id: string;
  readonly label: string;
  available(): boolean;
  /** 이 provider 가 해당 간격으로 소급 가능한 최대 일수 */
  maxLookbackDays(interval: MinuteInterval): number;
  fetchDay(symbol: string, dateIso: string, interval: MinuteInterval): Promise<MinuteBar[]>;
}

const dayDiff = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/* ─────────────────────────── KIS ─────────────────────────── */

/** 최근 세션만 가능. 과거일은 못 준다. */
export const kisMinuteProvider: MinuteProvider = {
  id: 'kis',
  label: '한국투자증권 (최근 세션 1분봉)',
  available: () => kisConfigured(),
  maxLookbackDays: () => 1,
  async fetchDay(symbol, dateIso, interval) {
    if (interval !== '1m') return [];
    const bars = await kisFetchMinuteBars(symbol, dateIso);
    // KIS 는 요청일과 무관하게 최근 세션을 준다. 실제 세션 날짜 그대로 반환한다.
    return bars.map((b) => ({ ...b, source: 'kis' }));
  },
};

/* ────────────────────────── Yahoo ────────────────────────── */

const YAHOO_LOOKBACK: Record<MinuteInterval, number> = {
  '1m': 14,
  '5m': 57,
  '15m': 57,
  '30m': 57,
  '1h': 700,
};

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: { currency?: string; fullExchangeName?: string };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { code?: string; description?: string };
  };
}

/** KOSPI → .KS, KOSDAQ → .KQ. 못 찾으면 둘 다 시도한다. */
const suffixCache = new Map<string, string>();
async function yahooTicker(symbol: string): Promise<string[]> {
  const cached = suffixCache.get(symbol);
  if (cached) return [cached];
  const rows = await query<{ market: string }>(`select market from instruments where symbol = $1`, [symbol]);
  const m = rows[0]?.market;
  if (m === 'KOSPI') return [`${symbol}.KS`];
  if (m === 'KOSDAQ') return [`${symbol}.KQ`];
  return [`${symbol}.KS`, `${symbol}.KQ`];
}

/** KST 자정 경계 epoch (초) */
const kstDayRange = (dateIso: string) => ({
  from: Math.floor(Date.parse(`${dateIso}T00:00:00+09:00`) / 1000),
  to: Math.floor(Date.parse(`${dateIso}T00:00:00+09:00`) / 1000) + 86_400,
});

const toKstIso = (epochSec: number) => {
  const d = new Date((epochSec + 9 * 3600) * 1000);
  return `${d.toISOString().slice(0, 19)}+09:00`;
};

export const yahooMinuteProvider: MinuteProvider = {
  id: 'yahoo',
  label: 'Yahoo Finance (과거 소급 분봉)',
  available: () => true,
  maxLookbackDays: (interval) => YAHOO_LOOKBACK[interval] ?? 14,
  async fetchDay(symbol, dateIso, interval) {
    const { from, to } = kstDayRange(dateIso);

    for (const ticker of await yahooTicker(symbol)) {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
        `?interval=${interval}&period1=${from}&period2=${to}`;
      let j: YahooChart;
      try {
        j = JSON.parse(
          await fetchText(url, {
            intervalMs: 400,
            retries: 2,
            headers: {
              // 브라우저 UA 가 없으면 Yahoo 가 종종 거절한다.
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
          }),
        ) as YahooChart;
      } catch {
        continue;
      }

      const res = j.chart?.result?.[0];
      const ts = res?.timestamp ?? [];
      const q = res?.indicators?.quote?.[0];
      if (ts.length === 0 || !q) continue;

      const out: MinuteBar[] = [];
      for (let i = 0; i < ts.length; i++) {
        // Yahoo 는 요청 범위 뒤에 "당일 현재가" 1봉을 덧붙인다. 범위 밖은 버린다.
        if (ts[i] < from || ts[i] >= to) continue;
        const c = q.close?.[i];
        if (c === null || c === undefined) continue;
        const o = q.open?.[i] ?? c;
        const h = q.high?.[i] ?? c;
        const l = q.low?.[i] ?? c;
        const v = q.volume?.[i] ?? 0;
        out.push({
          symbol,
          ts: toKstIso(ts[i]),
          o, h, l, c,
          volume: v,
          // Yahoo 는 거래대금을 주지 않는다. 종가×거래량으로 근사한다.
          tradedValue: Math.round(c * v),
          source: 'yahoo',
        });
      }
      if (out.length > 0) {
        suffixCache.set(symbol, ticker);
        return out;
      }
      await sleep(150);
    }
    return [];
  },
};

/* ───────────────────────── registry ───────────────────────── */

const ALL: Record<string, MinuteProvider> = {
  kis: kisMinuteProvider,
  yahoo: yahooMinuteProvider,
};

/** MINUTE_PROVIDER=kis,yahoo — 앞에서부터 시도한다. */
export function configuredMinuteProviders(): MinuteProvider[] {
  return (process.env.MINUTE_PROVIDER ?? 'kis,yahoo')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ALL[id])
    .filter((p): p is MinuteProvider => Boolean(p) && p.available());
}

export interface MinuteFetchResult {
  bars: MinuteBar[];
  provider: string | null;
  /** 요청일과 실제로 받은 세션 날짜가 다르면 여기에 담는다(KIS 특성) */
  sessionDates: string[];
  notes: string[];
}

/**
 * 요청일 분봉을 가져온다.
 * 소급 일수가 provider 한계를 넘으면 그 provider 는 건너뛴다.
 */
export async function fetchMinuteDay(
  symbol: string,
  dateIso: string,
  interval: MinuteInterval,
  todayIso: string,
): Promise<MinuteFetchResult> {
  const notes: string[] = [];
  const back = dayDiff(dateIso, todayIso);

  for (const p of configuredMinuteProviders()) {
    const max = p.maxLookbackDays(interval);
    if (back > max) {
      notes.push(`${p.id}: ${back}일 전은 소급 한계(${max}일) 초과 → 건너뜀`);
      continue;
    }
    try {
      const bars = await p.fetchDay(symbol, dateIso, interval);
      if (bars.length === 0) {
        notes.push(`${p.id}: 응답 없음`);
        continue;
      }
      const sessionDates = [...new Set(bars.map((b) => b.ts.slice(0, 10)))].sort();
      if (!sessionDates.includes(dateIso)) {
        notes.push(`${p.id}: 요청일(${dateIso})이 아닌 ${sessionDates.join(',')} 세션을 반환`);
      }
      return { bars, provider: p.id, sessionDates, notes };
    } catch (e) {
      notes.push(`${p.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { bars: [], provider: null, sessionDates: [], notes };
}

export async function saveMinute(bars: MinuteBar[]): Promise<number> {
  if (!bars.length) return 0;
  return bulkInsert(
    'ohlcv_minute',
    ['symbol', 'ts', 'o', 'h', 'l', 'c', 'volume', 'traded_value', 'source'],
    bars.map((b) => [b.symbol, b.ts, b.o, b.h, b.l, b.c, b.volume, b.tradedValue, b.source]),
    `on conflict (symbol, ts) do update set
       o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
       volume = excluded.volume, traded_value = excluded.traded_value, source = excluded.source`,
  );
}

/** UI·문서에서 쓰는 소급 한계 표 */
export const MINUTE_LOOKBACK_TABLE = Object.entries(YAHOO_LOOKBACK).map(([interval, days]) => ({
  interval,
  yahooDays: days,
  kisDays: 1,
}));
