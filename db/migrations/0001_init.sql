-- 0001_init.sql — 수급·패턴 대시보드 기본 스키마
-- 멱등: 같은 날짜로 배치를 두 번 돌려도 중복 행이 생기지 않도록 모든 사실 테이블에 자연키 PK를 둔다.

create table if not exists trading_days (
  date        date primary key,
  is_open     boolean not null,
  source      text    not null default 'ohlcv',
  created_at  timestamptz not null default now()
);

create table if not exists instruments (
  symbol                text primary key,
  isin                  text,
  name                  text not null,
  market                text not null check (market in ('KOSPI', 'KOSDAQ', 'KONEX', 'OTHER')),
  listed_shares         bigint,
  major_holder_shares   bigint,
  treasury_shares       bigint,
  free_float_shares     bigint,
  -- 'computed'      = 상장주식수 − 최대주주등 − 자기주식 을 실제로 계산함
  -- 'listed_shares' = 세 값을 다 못 구해 상장주식수로 대체함 (UI에 배지 필수)
  free_float_basis      text not null default 'listed_shares'
                        check (free_float_basis in ('computed', 'listed_shares')),
  free_float_updated_at timestamptz,
  corp_code             text,
  last_seen_date        date,
  updated_at            timestamptz not null default now()
);
create index if not exists instruments_corp_code_idx on instruments (corp_code);
create index if not exists instruments_market_idx on instruments (market);

create table if not exists ohlcv_daily (
  symbol        text not null,
  date          date not null,
  o             numeric(18, 2),
  h             numeric(18, 2),
  l             numeric(18, 2),
  c             numeric(18, 2),
  volume        bigint,
  traded_value  bigint,
  market_cap    bigint,
  listed_shares bigint,
  primary key (symbol, date)
);
create index if not exists ohlcv_daily_date_idx on ohlcv_daily (date);

-- investor_type 허용값 (프롬프트 1-2 기관 세부 포함)
--   individual | foreign | other_foreign | institution_total |
--   financial_investment | insurance | investment_trust | private_fund |
--   bank | other_finance | pension | other_corp
create table if not exists investor_flow_daily (
  symbol         text   not null,
  date           date   not null,
  investor_type  text   not null check (investor_type in (
                   'individual', 'foreign', 'other_foreign', 'institution_total',
                   'financial_investment', 'insurance', 'investment_trust', 'private_fund',
                   'bank', 'other_finance', 'pension', 'other_corp')),
  net_buy_qty    bigint not null,
  net_buy_amount bigint,
  source         text   not null,
  updated_at     timestamptz not null default now(),
  primary key (symbol, date, investor_type)
);
create index if not exists investor_flow_daily_date_type_idx on investor_flow_daily (date, investor_type);
create index if not exists investor_flow_daily_symbol_idx on investor_flow_daily (symbol, investor_type, date);

-- KRX CSV 는 기간합계로 내려받는 경우가 있어 일별로 쪼갤 수 없다.
-- 조용히 일별로 위장하지 않고 별도 테이블에 원 단위(기간) 그대로 보관한다.
create table if not exists investor_flow_period (
  symbol         text   not null,
  start_date     date   not null,
  end_date       date   not null,
  investor_type  text   not null,
  net_buy_qty    bigint not null,
  net_buy_amount bigint,
  source         text   not null,
  updated_at     timestamptz not null default now(),
  primary key (symbol, start_date, end_date, investor_type)
);
create index if not exists investor_flow_period_range_idx on investor_flow_period (start_date, end_date, investor_type);

create table if not exists member_flow_daily (
  symbol      text   not null,
  date        date   not null,
  member_name text   not null,
  buy_qty     bigint not null default 0,
  sell_qty    bigint not null default 0,
  source      text   not null,
  primary key (symbol, date, member_name)
);
create index if not exists member_flow_daily_date_idx on member_flow_daily (date);

-- OpenDART 임원·주요주주 특정증권등 소유상황보고서 (elestock) 목록 캐시
create table if not exists insider_reports (
  rcept_no      text primary key,
  corp_code     text not null,
  symbol        text,
  corp_name     text,
  disclosed_at  date not null,
  reporter      text,
  registered    text,
  position      text,
  main_holder   text,
  after_qty     bigint,
  change_qty    bigint,
  detail_status text not null default 'pending'
                check (detail_status in ('pending', 'parsed', 'skipped', 'failed')),
  detail_error  text,
  fetched_at    timestamptz not null default now()
);
create index if not exists insider_reports_symbol_idx on insider_reports (symbol, disclosed_at);
create index if not exists insider_reports_status_idx on insider_reports (detail_status);

-- 보고서 원문에서 뽑아낸 세부 변동내역 (거래일 기준 매칭용)
create table if not exists insider_trades (
  id            bigserial primary key,
  rcept_no      text not null,
  symbol        text not null,
  trade_date    date,
  disclosed_at  date not null,
  officer_name  text,
  position      text,
  registered    boolean,
  change_qty    bigint not null,
  after_qty     bigint,
  method        text,
  is_open_market_buy boolean not null default false,
  unit_price    bigint,
  created_at    timestamptz not null default now(),
  unique (rcept_no, symbol, officer_name, trade_date, change_qty, method)
);
create index if not exists insider_trades_symbol_date_idx on insider_trades (symbol, trade_date);

create table if not exists pattern_hits (
  symbol        text not null,
  date          date not null,
  pattern       text not null check (pattern in ('inverse_head_shoulders', 'cup_with_handle')),
  score         numeric(5, 2) not null,
  evidence_json jsonb not null,
  confirmed     boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (symbol, date, pattern)
);
create index if not exists pattern_hits_date_idx on pattern_hits (date, pattern, score desc);

create table if not exists screener_snapshots (
  date        date not null,
  params_hash text not null,
  params_json jsonb not null,
  rows_json   jsonb not null,
  row_count   integer not null default 0,
  created_at  timestamptz not null default now(),
  primary key (date, params_hash)
);

create table if not exists chart_drawings (
  user_id      text not null,
  symbol       text not null,
  payload_json jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, symbol)
);

-- TradingView Charting Library save_load_adapter 용 (승인 후 사용)
create table if not exists chart_layouts (
  id           bigserial primary key,
  user_id      text not null,
  client_id    text not null,
  name         text not null,
  symbol       text,
  resolution   text,
  content      text not null,
  updated_at   timestamptz not null default now(),
  unique (user_id, client_id, name)
);

create table if not exists batch_runs (
  date       date not null,
  step       text not null,
  status     text not null check (status in ('running', 'ok', 'partial', 'pending', 'failed', 'skipped')),
  row_count  integer not null default 0,
  error      text,
  provider   text,
  started_at timestamptz not null default now(),
  ran_at     timestamptz not null default now(),
  primary key (date, step)
);
create index if not exists batch_runs_date_idx on batch_runs (date desc);
