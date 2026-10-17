-- 장 마감 알림의 별(⭐) 기준(2026-10-17). 주체별 "순매수가 유통주식수·시총의 몇 %면 상위 몇 %인가"를
-- 최근 분포에서 뽑아 두고(scripts/stars.ts, 주 1회 갱신) 알림 API 가 읽는다. 값이 없으면 코드의 기본값을 쓴다.
create table if not exists star_thresholds (
  key        text    not null,   -- private_fund · institution_total · foreign · handbuy_total · individual_sell · insider
  tier       int     not null check (tier between 1 and 3),
  float_pct  numeric,            -- 유통주식수 대비 %(insider 는 없음)
  cap_pct    numeric not null,   -- 시초가 시총 대비 %
  n          int,                -- 표본 수
  updated_at timestamptz not null default now(),
  primary key (key, tier)
);
