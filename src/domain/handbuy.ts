/**
 * 손매수(직접 주문한 매수) 계산.
 *
 *   손매수 = (외국인 + 기관 순매수) − 프로그램 순매수
 *
 * 프로그램매매(차익·비차익)는 대부분 외국인과 기관이 낸다고 보고, 그만큼을 빼서
 * 사람이 직접 주문한 순매수만 남긴다. KIS 는 프로그램매매를 외국인/기관으로 나눠 주지
 * 않으므로 근사치다. 개인·기타법인의 프로그램 비중만큼 오차가 있다.
 *
 * 세 가지를 flow_events 에 가상 주체로 넣는다. 그러면 조건 검색·마커·랭킹이
 * 다른 주체와 똑같은 경로로 손매수를 다룬다.
 *
 *   handbuy_total        외국인+기관 합계에서 프로그램 전부를 뺀 값
 *   handbuy_foreign      외국인 몫. 프로그램을 외국인·기관의 순매수 절대값 비율로 나눠 뺀다
 *   handbuy_institution  기관 몫
 *
 * 둘 다 같은 방향으로 샀거나 한쪽이 0 이면 비율이 안정적이다. 두 값이 서로 반대
 * 부호(외국인 매수·기관 매도)이면 절대값 비율이라 나뉜 몫이 직관과 다를 수 있다.
 * 그런 날은 합계(handbuy_total)를 기준으로 보는 편이 안전하다.
 */
import { query } from '../lib/core';
import { INVESTOR_LABEL } from '../providers/investor-flow';

export const HANDBUY_TYPES = ['handbuy_total', 'handbuy_foreign', 'handbuy_institution'] as const;
export type HandBuyType = (typeof HANDBUY_TYPES)[number];

export const HANDBUY_LABEL: Record<HandBuyType, string> = {
  handbuy_total: '손매수 합계',
  handbuy_foreign: '외국인 손매수',
  handbuy_institution: '기관 손매수',
};

/** 조건 검색·마커·툴팁이 쓰는 주체 이름표. 손매수 가상 주체까지 포함한다. */
export const FLOW_LABEL: Record<string, string> = { ...INVESTOR_LABEL, ...HANDBUY_LABEL };

export async function computeHandBuy(fromDate: string, toDate: string): Promise<number> {
  // 외국인·기관·프로그램이 모두 있는 (종목, 날짜)만. 프로그램이 없는 날은 손매수를 알 수 없다.
  const base = `
    with src as (
      select f.symbol, f.date,
             f.net_buy_qty as fq, i.net_buy_qty as iq, p.net_qty as pq,
             coalesce(f.net_buy_amount, 0) as fa,
             coalesce(i.net_buy_amount, 0) as ia,
             p.net_amt as pa
        from investor_flow_daily f
        join investor_flow_daily i
          on i.symbol = f.symbol and i.date = f.date and i.investor_type = 'institution_total'
        join program_trade_daily p on p.symbol = f.symbol and p.date = f.date
       where f.investor_type = 'foreign' and f.date between $1::date and $2::date
    ), calc as (
      select symbol, date, fq, iq, pq, fa, ia, pa,
             case when abs(fq) + abs(iq) = 0 then 0.5
                  else abs(fq)::numeric / (abs(fq) + abs(iq)) end as wf
        from src
    ), ev as (
      select symbol, date, 'handbuy_total'::text as investor_type,
             (fq + iq - pq) as qty, (fa + ia - pa) as amt from calc
      union all
      select symbol, date, 'handbuy_foreign',
             round(fq - pq * wf)::bigint, round(fa - pa * wf)::bigint from calc
      union all
      select symbol, date, 'handbuy_institution',
             round(iq - pq * (1 - wf))::bigint, round(ia - pa * (1 - wf))::bigint from calc
    )`;

  await query(
    `${base}
     insert into flow_events
       (symbol, date, investor_type, net_buy_qty, net_buy_amount, float_ratio_pct, turnover_x, float_basis)
     select e.symbol, e.date, e.investor_type, e.qty, e.amt,
            case when i.free_float_shares > 0
                 then round(e.qty::numeric / i.free_float_shares * 100, 6) end,
            case when av.avg_tv > 0 then round(abs(e.amt)::numeric / av.avg_tv, 4) end,
            i.free_float_basis
       from ev e
       join instruments i on i.symbol = e.symbol
       left join lateral (
         select avg(t.traded_value)::numeric as avg_tv
           from (select traded_value from ohlcv_daily o2
                  where o2.symbol = e.symbol and o2.date < e.date
                  order by o2.date desc limit 20) t
       ) av on true
     on conflict (symbol, date, investor_type) do update set
       net_buy_qty = excluded.net_buy_qty,
       net_buy_amount = excluded.net_buy_amount,
       float_ratio_pct = excluded.float_ratio_pct,
       turnover_x = excluded.turnover_x,
       float_basis = excluded.float_basis`,
    [fromDate, toDate],
  );

  // 손매수를 넣은 뒤 z-점수·연속일수를 같이 갱신한다(computeFlowEvents 가 그 주체 행을 아직 모르므로).
  await computeFlowStats(fromDate, toDate);

  const r = await query<{ n: string }>(
    `select count(*)::text n from flow_events
      where date between $1 and $2 and investor_type like 'handbuy\\_%'`,
    [fromDate, toDate],
  );
  return Number(r[0]?.n ?? 0);
}

/**
 * z-점수와 연속일수를 flow_events 에 채운다.
 *  - z20: 직전 20개 거래일(오늘 제외) 순매수 금액의 평균·표준편차 대비 오늘 값. 표본 5개 미만이면 비움.
 *  - streak: 같은 부호가 이어진 일수. 순매수면 +n, 순매도면 -n.
 * 보관 기간이 25거래일이라 윈도 앞부분은 짧을 수 있다. 표본이 모자라면 z 를 만들지 않는다.
 */
export async function computeFlowStats(fromDate: string, toDate: string): Promise<void> {
  await query(
    `
    with base as (
      select symbol, date, investor_type, net_buy_amount,
             case when net_buy_qty > 0 then 1 when net_buy_qty < 0 then -1 else 0 end as s
        from flow_events
       where date between ($1::date - 45) and $2::date
    ), w as (
      select b.*,
             case when count(net_buy_amount) over p >= 5
                  then (net_buy_amount - avg(net_buy_amount) over p)
                       / nullif(stddev_samp(net_buy_amount) over p, 0) end as z,
             row_number() over (partition by symbol, investor_type order by date)
               - row_number() over (partition by symbol, investor_type, s order by date) as grp
        from base b
      window p as (partition by symbol, investor_type order by date
                   rows between 20 preceding and 1 preceding)
    ), st as (
      select symbol, date, investor_type, z,
             s * row_number() over (partition by symbol, investor_type, s, grp order by date) as streak
        from w
    )
    update flow_events e
       set z20 = case when st.z is null then null else round(st.z::numeric, 3) end,
           streak = st.streak
      from st
     where e.symbol = st.symbol and e.date = st.date and e.investor_type = st.investor_type
       and e.date between $1::date and $2::date`,
    [fromDate, toDate],
  );
}
