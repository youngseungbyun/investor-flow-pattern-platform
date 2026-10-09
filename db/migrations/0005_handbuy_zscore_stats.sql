-- 수급 신호 고도화(z-점수·연속일수), 손매수 가상 주체 지원, 패턴 과거 성과 통계.
--
-- 전부 추가형이다. 기존 행과 질의는 그대로 동작한다.

-- 종목·주체별 최근 20일 평균 대비 오늘 순매수 금액이 몇 표준편차 떨어져 있는지.
-- "그 종목에서 유난히 큰 날"을 잡는다. 대형주는 유통주식수 대비 %가 작아도 z 는 크게 나온다.
alter table flow_events add column if not exists z20 numeric(10, 3);

-- 연속 순매수(+) · 순매도(-) 일수. 오늘이 3일째 순매수면 3, 이틀째 순매도면 -2.
alter table flow_events add column if not exists streak integer;

-- 패턴·단계별 과거 성과. 370일 일봉으로 돌려 본 결과를 점수 옆에 보여 준다.
-- horizon 은 발생 뒤 거래일 수(5·10·20). win_rate 는 그 뒤 수익률이 0 보다 컸던 비율(%).
create table if not exists pattern_stats (
  pattern    text not null,
  stage      text not null,
  horizon    integer not null,
  n          integer not null,
  win_rate   numeric(6, 2),
  avg_ret    numeric(8, 3),
  med_ret    numeric(8, 3),
  updated_at timestamptz not null default now(),
  primary key (pattern, stage, horizon)
);

-- 판정 시점에 붙여 두는 과거 성과(같은 패턴·단계의 10거래일 뒤 승률과 표본 수).
alter table pattern_hits add column if not exists hist_win numeric(6, 2);
alter table pattern_hits add column if not exists hist_n integer;
