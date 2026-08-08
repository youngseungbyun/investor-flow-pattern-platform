-- 0003_minute_source.sql — 분봉 출처(kis / yahoo) 구분
-- 추가형(비파괴). Supabase market 스키마와 컬럼을 맞춘다.

alter table ohlcv_minute add column if not exists source text not null default 'kis';
create index if not exists ohlcv_minute_source_idx on ohlcv_minute (source);
