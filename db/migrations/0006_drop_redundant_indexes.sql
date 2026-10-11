-- 무료 512MB 한도 여유 확보(2026-10-11, DB 475MB).
-- 두 인덱스는 기본키(symbol, date, investor_type) 앞부분으로 대부분 대체되고 합쳐서 46MB 를 쓴다.
drop index if exists investor_flow_daily_symbol_idx;
drop index if exists flow_events_symbol_idx;
