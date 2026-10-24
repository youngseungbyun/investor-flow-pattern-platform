/**
 * 웹 화면용 별(⭐) 배지. 텔레그램 알림(alert.ts)과 같은 기준·같은 계산(cell)을 쓰므로
 * 같은 종목이 알림에서는 별이 붙고 웹에서는 안 붙는 일이 없다.
 */
import { query } from '../lib/core';
import { cell, FLOW_TYPES, type FlowRow } from './alert';
import { loadTiers, type StarKey } from './stars';

export interface Badge {
  /** 0~3 */
  stars: number;
  /** 개인 순매수가 큰 추격 경고 */
  warn: boolean;
  amount: number;
  pct: number | null;
  basis: string;
}

export type BadgeKey = 'institution' | 'private_fund' | 'foreign' | 'individual' | 'handbuy';
export type SymbolBadges = Partial<Record<BadgeKey, Badge>>;

const MAP: Array<[BadgeKey, (typeof FLOW_TYPES)[number], StarKey | null]> = [
  ['institution', 'institution_total', 'institution_total'],
  ['private_fund', 'private_fund', 'private_fund'],
  ['foreign', 'foreign', 'foreign'],
  ['individual', 'individual', null],
  ['handbuy', 'handbuy_total', 'handbuy_total'],
];

export async function starBadges(date: string, symbols: string[]): Promise<Record<string, SymbolBadges>> {
  const syms = [...new Set(symbols)].slice(0, 300);
  if (syms.length === 0) return {};
  const tiers = await loadTiers();
  const [inst, flows] = await Promise.all([
    query<{ symbol: string; listed: string; o: string }>(
      `select i.symbol, i.listed_shares::text listed, o.o::text o
         from instruments i join ohlcv_daily o on o.symbol = i.symbol and o.date = $2::date
        where i.symbol = any($1::text[])`,
      [syms, date],
    ),
    query<FlowRow>(
      `select symbol, investor_type t, net_buy_amount::text amt, float_ratio_pct::text pct, float_basis fb
         from flow_events where symbol = any($1::text[]) and date = $2::date and investor_type = any($3::text[])`,
      [syms, date, [...FLOW_TYPES]],
    ),
  ]);
  const out: Record<string, SymbolBadges> = {};
  for (const x of inst) {
    const listed = Number(x.listed);
    const open = Number(x.o);
    const b: SymbolBadges = {};
    for (const [bk, ft, sk] of MAP) {
      const r = flows.find((f) => f.symbol === x.symbol && f.t === ft);
      const c = cell(sk, tiers, r, listed, open, bk === 'individual' ? { individual: true } : {});
      if (c) b[bk] = { stars: c.stars, warn: !!c.warn, amount: c.amount, pct: c.pct, basis: c.basisLabel };
    }
    out[x.symbol] = b;
  }
  return out;
}
