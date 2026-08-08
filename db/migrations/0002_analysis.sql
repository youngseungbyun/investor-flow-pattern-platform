-- 0002_analysis.sql — 수급분석 / 패턴분석 / 라인분석 확장
-- 전부 추가형(비파괴). 기존 테이블은 컬럼 추가만 한다.

/* ─────────────────────────── 분봉 ─────────────────────────── */

create table if not exists ohlcv_minute (
  symbol       text not null,
  ts           timestamptz not null,
  o            numeric(18, 2),
  h            numeric(18, 2),
  l            numeric(18, 2),
  c            numeric(18, 2),
  volume       bigint,
  traded_value bigint,
  primary key (symbol, ts)
);
create index if not exists ohlcv_minute_symbol_ts_idx on ohlcv_minute (symbol, ts desc);

/* ───────────────────── 프로그램매매 (분/일) ───────────────────── */

create table if not exists program_trade_minute (
  symbol   text not null,
  ts       timestamptz not null,
  sell_qty bigint not null default 0,
  buy_qty  bigint not null default 0,
  net_qty  bigint not null default 0,
  sell_amt bigint not null default 0,
  buy_amt  bigint not null default 0,
  net_amt  bigint not null default 0,
  source   text not null default 'kis',
  primary key (symbol, ts)
);
create index if not exists program_trade_minute_symbol_idx on program_trade_minute (symbol, ts desc);

create table if not exists program_trade_daily (
  symbol   text not null,
  date     date not null,
  sell_qty bigint not null default 0,
  buy_qty  bigint not null default 0,
  net_qty  bigint not null default 0,
  sell_amt bigint not null default 0,
  buy_amt  bigint not null default 0,
  net_amt  bigint not null default 0,
  source   text not null default 'kis',
  primary key (symbol, date)
);
create index if not exists program_trade_daily_date_idx on program_trade_daily (date);

/* ───────── 수급 이벤트 (차트 봉에 얹을 마커 + 조건 빌더 입력) ───────── */

-- 하루치 수급을 "유통주식수 대비 몇 %", "평소 거래대금 대비 몇 배"로 정규화해 저장한다.
-- 조건 빌더가 이 테이블만 보면 되도록 파생값을 미리 계산해 둔다.
create table if not exists flow_events (
  symbol           text not null,
  date             date not null,
  investor_type    text not null,
  net_buy_qty      bigint not null,
  net_buy_amount   bigint,
  -- 순매수 수량 ÷ 유통주식수 × 100
  float_ratio_pct  numeric(12, 6),
  -- 순매수 금액 ÷ (20일 평균 거래대금)
  turnover_x       numeric(12, 4),
  -- 유통주식수 기준이 상장주식수 대체인지 (UI 배지용)
  float_basis      text not null default 'listed_shares',
  primary key (symbol, date, investor_type)
);
create index if not exists flow_events_scan_idx on flow_events (date, investor_type, float_ratio_pct desc);
create index if not exists flow_events_symbol_idx on flow_events (symbol, investor_type, date desc);

/* ─────────────────────── 패턴 확장 ─────────────────────── */

alter table pattern_hits add column if not exists direction     text;   -- bullish | bearish | neutral
alter table pattern_hits add column if not exists kind          text;   -- reversal | continuation | bilateral
-- forming(형성중) | near_pivot(넥라인/돌파선 부근) | breakout(돌파) | pullback(돌파 후 눌림목) | failed
alter table pattern_hits add column if not exists stage         text;
alter table pattern_hits add column if not exists pivot_price   numeric(18, 2);
alter table pattern_hits add column if not exists breakout_date date;
alter table pattern_hits add column if not exists start_date    date;
alter table pattern_hits add column if not exists end_date      date;
alter table pattern_hits add column if not exists distance_pct  numeric(10, 4); -- 현재가 ↔ pivot 이격(%)

-- 0001 의 CHECK 제약은 패턴 2종만 허용했다. 카탈로그 확장을 위해 해제한다.
alter table pattern_hits drop constraint if exists pattern_hits_pattern_check;

create index if not exists pattern_hits_stage_idx on pattern_hits (date, direction, stage, score desc);

/* ─────────────────────── 라인분석 ─────────────────────── */

-- 스윙 변곡점에서 뽑아낸 수평 지지/저항선
create table if not exists support_lines (
  symbol   text not null,
  date     date not null,   -- 스캔 기준일
  line_id  text not null,   -- 결정적 id (가격 기반)
  price    numeric(18, 2) not null,
  kind     text not null,   -- support | resistance
  touches  integer not null default 1,
  first_at date,
  last_at  date,
  strength numeric(6, 2) not null default 0,
  primary key (symbol, date, line_id)
);
create index if not exists support_lines_symbol_idx on support_lines (symbol, date desc);

-- 라인분석 시그널 (거래량 돌파 후 눌림목 / 이평 지지)
create table if not exists line_signals (
  symbol      text not null,
  date        date not null,
  signal      text not null,   -- volume_breakout_pullback | ma_support | line_retest
  score       numeric(5, 2) not null default 0,
  detail_json jsonb not null,
  primary key (symbol, date, signal)
);
create index if not exists line_signals_scan_idx on line_signals (date, signal, score desc);

/* ─────────────────── 저장된 조건(조건 빌더 프리셋) ─────────────────── */

create table if not exists saved_rules (
  id         text primary key,
  user_id    text not null default 'local',
  name       text not null,
  rule_json  jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/* ─────────────────── 거래원 확장 ─────────────────── */

alter table member_flow_daily add column if not exists member_code text;
alter table member_flow_daily add column if not exists is_foreign  boolean not null default false;
