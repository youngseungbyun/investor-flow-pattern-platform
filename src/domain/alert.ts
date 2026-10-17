/**
 * 장 마감 알림 데이터 + 문구. 맥미니 알림 작업이 /api/alert 로 받아 그대로 보낸다.
 * 종목 선별(조건·상승 마감·20일선)은 알림 작업이 하고, 여기서는 고른 종목의 카드·손매수 상위·임원만 만든다.
 */
import { query } from '../lib/core';
import { PATTERN_CATALOG, STAGE_KO, type Stage } from './patterns';
import { loadTiers, starsFor, type StarKey, type TierTable } from './stars';
import {
  assemble,
  fmtCard,
  fmtFlowLine,
  fmtInsider,
  type CardInput,
  type FlowCell,
  type InsiderLine,
} from './alertText';

const FLOW_TYPES = ['institution_total', 'private_fund', 'foreign', 'individual', 'handbuy_total'] as const;

type FlowRow = { symbol: string; t: string; amt: string; pct: string | null; fb: string };

function cell(
  key: StarKey | null,
  tiers: TierTable,
  r: FlowRow | undefined,
  listed: number,
  open: number,
  opts: { individual?: boolean } = {},
): FlowCell | null {
  if (!r) return null;
  const amount = Number(r.amt);
  const capPct = listed > 0 && open > 0 ? (amount / (listed * open)) * 100 : null;
  const computed = r.fb === 'computed' && r.pct !== null;
  const pct = computed ? Number(r.pct) : capPct;
  const basisLabel = computed ? '유통' : capPct !== null ? '시총' : '유통';
  let stars = 0;
  let warn = false;
  if (opts.individual) {
    // 개인: 순매도가 크면 별(스마트머니 쪽 매수의 거울), 순매수가 크면 추격 경고
    if (amount < 0) {
      stars = starsFor('individual_sell', tiers, computed ? -Number(r.pct) : null, capPct === null ? null : -capPct);
    } else {
      warn = computed ? Number(r.pct) >= 1.0 : capPct !== null && capPct >= 0.6;
    }
  } else if (key && amount > 0) {
    stars = starsFor(key, tiers, computed ? Number(r.pct) : null, capPct);
  }
  return { amount, pct, basisLabel, stars, warn };
}

export interface AlertResult {
  date: string;
  text: string;
  total: number;
  cards: Array<{ symbol: string; name: string; stars: number; text: string }>;
  folded: string[];
}

export async function buildAlert(date: string, symbols: string[], maxCards = 5): Promise<AlertResult> {
  const tiers = await loadTiers();
  const syms = [...new Set(symbols)].slice(0, 30);
  if (syms.length === 0) throw new Error('symbols 가 필요합니다.');

  const [inst, flows, pats] = await Promise.all([
    query<{ symbol: string; name: string; listed: string; o: string; c: string; pc: string | null }>(
      `select i.symbol, i.name, i.listed_shares::text listed, o.o::text o, o.c::text c,
              (select c from ohlcv_daily where symbol = i.symbol and date < o.date order by date desc limit 1)::text pc
         from instruments i join ohlcv_daily o on o.symbol = i.symbol and o.date = $2::date
        where i.symbol = any($1::text[])`,
      [syms, date],
    ),
    query<FlowRow>(
      `select symbol, investor_type t, net_buy_amount::text amt, float_ratio_pct::text pct, float_basis fb
         from flow_events where symbol = any($1::text[]) and date = $2::date and investor_type = any($3::text[])`,
      [syms, date, [...FLOW_TYPES]],
    ),
    query<{ symbol: string; pattern: string; stage: Stage; score: string }>(
      `select distinct on (symbol) symbol, pattern, stage, score::text score
         from pattern_hits
        where symbol = any($1::text[]) and direction = 'bullish' and stage in ('near_pivot','breakout')
          and date = (select max(date) from pattern_hits where date <= $2::date)
        order by symbol, score desc`,
      [syms, date],
    ),
  ]);

  const built = syms
    .map((s) => inst.find((x) => x.symbol === s))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => {
      const listed = Number(x.listed);
      const open = Number(x.o);
      const pick = (t: string) => flows.find((f) => f.symbol === x.symbol && f.t === t);
      const pat = pats.find((p) => p.symbol === x.symbol);
      const meta = PATTERN_CATALOG.find((m) => m.id === pat?.pattern);
      const input: CardInput = {
        index: 0,
        name: x.name,
        close: Number(x.c),
        changePct: x.pc && Number(x.pc) > 0 ? (Number(x.c) / Number(x.pc) - 1) * 100 : null,
        pattern: pat
          ? { icon: pat.stage === 'breakout' ? '🚩' : '🎯', label: `${meta?.ko ?? pat.pattern} ${STAGE_KO[pat.stage]}` }
          : null,
        institution: cell('institution_total', tiers, pick('institution_total'), listed, open),
        privateFund: cell('private_fund', tiers, pick('private_fund'), listed, open),
        foreign: cell('foreign', tiers, pick('foreign'), listed, open),
        individual: cell(null, tiers, pick('individual'), listed, open, { individual: true }),
        handbuy: cell('handbuy_total', tiers, pick('handbuy_total'), listed, open),
      };
      const stars =
        (input.institution?.stars ?? 0) +
        (input.privateFund?.stars ?? 0) +
        (input.foreign?.stars ?? 0) +
        (input.individual?.stars ?? 0) +
        (input.handbuy?.stars ?? 0);
      return { symbol: x.symbol, input, stars, chg: input.changePct ?? -99 };
    });

  built.sort((a, b) => b.stars - a.stars || b.chg - a.chg);
  const shown = built.slice(0, maxCards);
  shown.forEach((b, i) => (b.input.index = i));
  const cards = shown.map((b) => ({ symbol: b.symbol, name: b.input.name, stars: b.stars, text: fmtCard(b.input) }));
  const folded = built.slice(maxCards).map((b) => b.input.name);

  let foreignSell = 0;
  let foreignBuy = 0;
  for (const b of built) {
    const a = b.input.foreign?.amount;
    if (a === undefined) continue;
    if (a < 0) foreignSell++;
    else if (a > 0) foreignBuy++;
  }

  // 손매수 상위(카드 밖): 시총 대비 큰 순, 거래대금 20억 이상
  const hb = await query<{ symbol: string; name: string; amt: string; pct: string | null; fb: string; listed: string; o: string }>(
    `select e.symbol, i.name, e.net_buy_amount::text amt, e.float_ratio_pct::text pct, e.float_basis fb,
            i.listed_shares::text listed, o.o::text o
       from flow_events e
       join instruments i on i.symbol = e.symbol
       join ohlcv_daily o on o.symbol = e.symbol and o.date = e.date
      where e.date = $1::date and e.investor_type = 'handbuy_total' and e.net_buy_amount > 0
        and o.traded_value >= 2000000000 and o.o > 0 and i.listed_shares > 0
        and e.symbol <> all($2::text[])
      order by e.net_buy_amount::float8 / (i.listed_shares::float8 * o.o) desc
      limit 2`,
    [date, syms],
  );
  const handbuyLines = hb
    .map((r) => {
      const c = cell('handbuy_total', tiers, { symbol: r.symbol, t: 'handbuy_total', amt: r.amt, pct: r.pct, fb: r.fb }, Number(r.listed), Number(r.o));
      return fmtFlowLine(r.name, c, '   ');
    })
    .filter((l): l is string => !!l);

  // 임원 장내매수(최근 5거래일)
  const ins = await query<{ name: string; officer: string | null; position: string | null; d: string; amt: string; cap: string }>(
    `with win as (select min(date) s from (select date from ohlcv_daily where symbol = '005930' and date <= $1::date order by date desc limit 5) x)
     select i.name, t.officer_name officer, t.position, to_char(t.trade_date,'MM/DD') d,
            sum(t.change_qty * t.unit_price)::text amt,
            (sum(t.change_qty * t.unit_price) / nullif(avg(t.unit_price) * i.listed_shares, 0) * 100)::text cap
       from insider_trades t join instruments i on i.symbol = t.symbol, win
      where t.is_open_market_buy and t.unit_price > 0 and t.trade_date >= win.s and t.trade_date <= $1::date
      group by i.name, i.listed_shares, t.officer_name, t.position, t.trade_date`,
    [date],
  );
  const insRows: InsiderLine[] = ins
    .map((r) => {
      const capPct = Number(r.cap);
      return {
        name: r.name,
        officer: r.officer ?? '-',
        position: (r.position ?? '').trim(),
        mmdd: r.d,
        amount: Number(r.amt),
        capPct,
        stars: starsFor('insider', tiers, null, capPct),
      };
    })
    .sort((a, b) => b.stars - a.stars || b.amount - a.amount);
  const withStars = insRows.filter((r) => r.stars > 0);
  const noStars = insRows.filter((r) => r.stars === 0).slice(0, 2);
  const insiderLines = [...withStars, ...noStars].map(fmtInsider);

  const text = assemble({
    date,
    total: built.length,
    foreignSell,
    foreignBuy,
    cards: cards.map((c) => c.text),
    folded,
    handbuyLines,
    insiderLines,
  });
  return { date, text, total: built.length, cards, folded };
}
