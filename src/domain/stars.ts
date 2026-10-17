/**
 * 장 마감 알림의 별(⭐) 기준.
 *
 * 별 1·2·3개 = 그 주체의 하루 순매수가 최근 분포에서 상위 2% · 0.5% · 0.2% 안(사모 유통 대비 1.0% 가 별 3개 — 2026-10-17 대표 기준).
 * 임원 장내매수는 매수 금액이 시총의 몇 %인지로 상위 10% · 5% · 1%.
 * 기준값은 star_thresholds 표(주 1회 scripts/stars.ts 가 갱신)에서 읽고, 없으면 아래 기본값을 쓴다.
 */
import { query } from '../lib/core';

export type StarKey =
  | 'private_fund'
  | 'institution_total'
  | 'foreign'
  | 'handbuy_total'
  | 'individual_sell'
  | 'insider';

export type Tier3 = [number, number, number];
export interface Tiers {
  float: Tier3;
  cap: Tier3;
}

/** 2026-10-17 실측(25거래일, 유통 계산 종목). 별 1·2·3 = 상위 2% · 0.5% · 0.2%. */
export const DEFAULT_TIERS: Record<StarKey, Tiers> = {
  private_fund: { float: [0.45, 0.7, 1.0], cap: [0.27, 0.53, 0.7] },
  institution_total: { float: [1.2, 2.4, 3.5], cap: [0.73, 1.5, 2.45] },
  foreign: { float: [1.75, 3.4, 4.3], cap: [1.07, 2.25, 3.0] },
  handbuy_total: { float: [1.0, 1.8, 2.1], cap: [0.63, 0.99, 1.5] },
  individual_sell: { float: [1.75, 3.7, 4.4], cap: [1.12, 2.16, 3.14] },
  insider: { float: [0, 0, 0], cap: [0.09, 0.18, 0.33] },
};

export type TierTable = Record<StarKey, Tiers>;

export async function loadTiers(): Promise<TierTable> {
  const out: TierTable = JSON.parse(JSON.stringify(DEFAULT_TIERS));
  try {
    const rows = await query<{ key: StarKey; tier: number; float_pct: string | null; cap_pct: string }>(
      `select key, tier, float_pct, cap_pct from star_thresholds`,
    );
    for (const r of rows) {
      const t = out[r.key];
      if (!t) continue;
      if (r.float_pct !== null) t.float[r.tier - 1] = Number(r.float_pct);
      t.cap[r.tier - 1] = Number(r.cap_pct);
    }
  } catch {
    // 표가 아직 없으면 기본값
  }
  return out;
}

/** 값이 기준을 넘은 개수(0~3). 기준은 오름차순. */
export function starCount(value: number, th: Tier3): number {
  if (!(value > 0)) return 0;
  return value >= th[2] ? 3 : value >= th[1] ? 2 : value >= th[0] ? 1 : 0;
}

export const starText = (n: number): string => '⭐'.repeat(n);

/** 유통주식수 대비가 있으면 그것으로, 없으면 시총 대비로 별 개수를 정한다. */
export function starsFor(key: StarKey, tiers: TierTable, floatPct: number | null, capPct: number | null): number {
  const t = tiers[key];
  if (floatPct !== null && floatPct !== undefined && t.float[2] > 0) return starCount(floatPct, t.float);
  if (capPct !== null && capPct !== undefined) return starCount(capPct, t.cap);
  return 0;
}
