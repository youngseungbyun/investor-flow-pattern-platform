-- 일별 수급 장기 보관(2026-10-13). 일별 표는 용량 한도 때문에 25거래일만 남기므로,
-- 완성된 날마다 압축(gzip CSV) 한 덩어리로 따로 쌓아 몇 달 뒤 일별 백테스트에 쓸 수 있게 한다.
-- 하루 약 100KB, 1년 약 25MB.
create table if not exists flow_archive (
  date    date  not null,
  kind    text  not null check (kind in ('flow', 'program')),
  n_rows  int   not null,
  payload bytea not null,
  primary key (date, kind)
);
