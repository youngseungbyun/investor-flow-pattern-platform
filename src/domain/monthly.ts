/**
 * 수급 월별 누적.
 *
 * 일별 수급(investor_flow_daily·flow_events)은 25거래일만 보관한다. 지워지기 전에 완성된 날을
 * (종목, 월, 주체) 합계로 flow_monthly 에 더해 길게 남긴다.
 * - 합산한 마지막 날은 flow_monthly_state 에 기록해 같은 날을 두 번 더하지 않는다.
 * - 수집이 진행 중일 수 있는 가장 최근 날짜는 건드리지 않는다(다음 번에 합산).
 */
import { query } from '../lib/core';

export async function rollupFlowMonthly(): Promise<{ from: string | null; to: string | null; rows: number }> {
  const latest = (
    await query<{ d: string | null }>(`select to_char(max(date),'YYYY-MM-DD') d from investor_flow_daily`)
  )[0]?.d;
  if (!latest) return { from: null, to: null, rows: 0 };

  const last = (
    await query<{ d: string | null }>(`select to_char(last_date,'YYYY-MM-DD') d from flow_monthly_state where id = 1`)
  )[0]?.d;

  // 합산 대상: last 다음 날부터 latest 직전 날까지(latest 는 아직 덜 찼을 수 있다).
  const rows = await query<{ n: string; to_date: string | null }>(
    `with src as (
       select symbol, date, investor_type, net_buy_amount::numeric amt, net_buy_qty::numeric qty
         from investor_flow_daily
        where date < $2::date and ($1::date is null or date > $1::date)
       union all
       select symbol, date, investor_type, net_buy_amount::numeric, net_buy_qty::numeric
         from flow_events
        where investor_type like 'handbuy\_%'
          and date < $2::date and ($1::date is null or date > $1::date)
     ), agg as (
       select symbol, date_trunc('month', date)::date as month, investor_type,
              coalesce(sum(amt), 0) amt, coalesce(sum(qty), 0) qty,
              count(*) days, sum((coalesce(amt, 0) > 0)::int) buy_days, max(date) last_day
         from src group by 1, 2, 3
     ), ins as (
       insert into flow_monthly (symbol, month, investor_type, net_buy_amount, net_buy_qty, days, buy_days)
       select symbol, month, investor_type, round(amt), round(qty), days, buy_days from agg
       on conflict (symbol, month, investor_type) do update set
         net_buy_amount = flow_monthly.net_buy_amount + excluded.net_buy_amount,
         net_buy_qty    = flow_monthly.net_buy_qty    + excluded.net_buy_qty,
         days           = flow_monthly.days           + excluded.days,
         buy_days       = flow_monthly.buy_days       + excluded.buy_days
       returning 1
     )
     select (select count(*) from ins)::text n,
            (select to_char(max(last_day),'YYYY-MM-DD') from agg) to_date`,
    [last ?? null, latest],
  );
  const to = rows[0]?.to_date ?? null;
  if (to) {
    await query(
      `insert into flow_monthly_state (id, last_date) values (1, $1::date)
       on conflict (id) do update set last_date = excluded.last_date`,
      [to],
    );
  }
  return { from: last ?? null, to, rows: Number(rows[0]?.n ?? 0) };
}
