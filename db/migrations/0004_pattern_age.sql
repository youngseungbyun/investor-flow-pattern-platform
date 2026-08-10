-- 패턴이 완성·돌파된 뒤 며칠 지났는지를 저장한다.
--
-- 기준일을 바꾸면 같은 패턴이라도 "방금 돌파한 것"과 "돌파한 지 3주 지난 것"이
-- 섞여 나온다. 둘은 판단이 전혀 다른데 화면에서는 구분되지 않았다.
-- 거래일 수로 저장하므로 연휴가 껴도 값이 흔들리지 않는다.

alter table pattern_hits add column if not exists bars_since_breakout integer;
alter table pattern_hits add column if not exists bars_since_formed integer;

-- 최근에 완성·돌파된 것만 뽑는 질의가 기본이라 인덱스를 건다.
create index if not exists pattern_hits_recent_idx
  on pattern_hits (date, bars_since_breakout);
