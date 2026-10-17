/**
 * 별(⭐) 기준 갱신 — 보관 중인 일별 수급 분포에서 상위 2% · 0.5% · 0.2% 경계를 뽑아 star_thresholds 에 쓴다.
 * 임원 장내매수는 시총 대비 상위 10% · 5% · 1%. 주 1회(토요일 백테스트 워크플로우) 돈다.
 *   npx tsx scripts/stars.ts [--dry]
 */
import { exec, pool, query } from '../src/lib/core';

const Q = [0.98, 0.995, 0.9978];
const KEYS: Array<[string, string, 'pos' | 'neg']> = [
  ['private_fund', 'private_fund', 'pos'],
  ['institution_total', 'institution_total', 'pos'],
  ['foreign', 'foreign', 'pos'],
  ['handbuy_total', 'handbuy_total', 'pos'],
  ['individual_sell', 'individual', 'neg'],
];

async function main() {
  const dry = process.argv.includes('--dry');
  for (const [key, type, side] of KEYS) {
    const sign = side === 'neg' ? -1 : 1;
    const r = await query<{ n: string; pf: number[] | null; pc: number[] | null }>(
      `select count(*)::text n,
              percentile_cont($2::float8[]) within group (order by ${sign} * e.float_ratio_pct::float8) filter (where e.float_basis = 'computed') pf,
              percentile_cont($2::float8[]) within group (order by ${sign} * (e.net_buy_amount::float8 / nullif(i.listed_shares::float8 * o.o, 0)) * 100) pc
         from flow_events e
         join instruments i on i.symbol = e.symbol
         join ohlcv_daily o on o.symbol = e.symbol and o.date = e.date
        where e.investor_type = $1 and o.o > 0 and ${side === 'neg' ? 'e.net_buy_amount < 0' : 'e.net_buy_amount > 0'}`,
      [type, Q],
    );
    const row = r[0];
    if (!row?.pf || !row.pc) continue;
    console.log(key, 'n', row.n, '유통', row.pf.map((v) => +Number(v).toFixed(2)), '시총', row.pc.map((v) => +Number(v).toFixed(2)));
    if (dry) continue;
    for (let t = 0; t < 3; t++) {
      await exec(
        `insert into star_thresholds (key, tier, float_pct, cap_pct, n, updated_at) values ($1, $2, $3, $4, $5, now())
         on conflict (key, tier) do update set float_pct = excluded.float_pct, cap_pct = excluded.cap_pct, n = excluded.n, updated_at = now()`,
        [key, t + 1, Number(row.pf[t]), Number(row.pc[t]), Number(row.n)],
      );
    }
  }
  // 임원: 매수 금액이 시총의 몇 %
  const ins = await query<{ n: string; pc: number[] | null }>(
    `select count(*)::text n,
            percentile_cont(array[0.9, 0.95, 0.99]) within group
              (order by (t.change_qty * t.unit_price) / nullif(t.unit_price * i.listed_shares::float8, 0) * 100) pc
       from insider_trades t join instruments i on i.symbol = t.symbol
      where t.is_open_market_buy and t.unit_price > 0`,
  );
  if (ins[0]?.pc) {
    console.log('insider n', ins[0].n, '시총', ins[0].pc.map((v) => +Number(v).toFixed(3)));
    if (!dry && Number(ins[0].n) >= 100) {
      for (let t = 0; t < 3; t++) {
        await exec(
          `insert into star_thresholds (key, tier, float_pct, cap_pct, n, updated_at) values ('insider', $1, null, $2, $3, now())
           on conflict (key, tier) do update set cap_pct = excluded.cap_pct, n = excluded.n, updated_at = now()`,
          [t + 1, Number(ins[0].pc[t]), Number(ins[0].n)],
        );
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
