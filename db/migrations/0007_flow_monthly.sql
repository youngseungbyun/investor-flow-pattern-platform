-- 수급 월별 누적(2026-10-12). 일별 수급은 용량 한도 때문에 25거래일만 보관하므로,
-- 지워지기 전에 (종목, 월, 주체) 단위로 합산해 길게 남긴다.
create table if not exists flow_monthly (
  symbol         text    not null,
  month          date    not null,            -- 해당 월 1일
  investor_type  text    not null,            -- 12개 주체 + handbuy_*
  net_buy_amount bigint  not null default 0,
  net_buy_qty    bigint  not null default 0,
  days           int     not null default 0,  -- 합산에 들어간 거래일 수
  buy_days       int     not null default 0,  -- 그중 순매수였던 날
  primary key (symbol, month, investor_type)
);
-- 어디까지 합산했는지(같은 날을 두 번 더하지 않게).
create table if not exists flow_monthly_state (
  id        int primary key default 1,
  last_date date
);
