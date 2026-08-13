/**
 * 일봉이 실제로 들어온 최신 거래일을 한 줄로 찍는다. 다른 출력은 내지 않는다.
 *
 * 수집과 분석은 봐야 할 날짜가 다르다.
 * 수집은 "오늘"을 대상으로 돈다. 어차피 없으면 pending 으로 끝난다.
 * 분석(패턴·라인)은 일봉이 있어야 성립하는데, 금융위 일봉은 T+1 이고
 * KIS 갭보강도 장이 끝나야 받는다. 그래서 오늘을 기준일로 주면
 * 봉 없는 날을 판정하게 되어 매번 0건으로 끝난다.
 * 뒤늦게 도착한 어제 일봉은 그때 이미 분석이 지나가 버려 영영 판정되지 않는다.
 *
 * 그 간극을 메우려고 분석 단계는 이 값을 기준일로 쓴다.
 */
import { pool, query } from '../src/lib/core';

async function main() {
  // 그냥 max(date) 를 쓰면 안 된다. 장 마감 직후 회차에서 KIS 가 스캔 대상
  // 838종목만 채워 놓은 "반쯤 찬 날"이 최신으로 잡힌다. 그 날로 패턴을 돌리면
  // 전체의 30%만 보고 판정하게 된다.
  // 최근 20거래일 중 가장 많이 채워진 날의 70% 이상인 날만 완전한 날로 본다.
  const r = await query<{ d: string | null }>(
    `with recent as (
       select date, count(*)::numeric c
         from ohlcv_daily
        where date > (select max(date) - 40 from ohlcv_daily)
        group by date
     )
     select to_char(max(date), 'YYYY-MM-DD') d
       from recent
      where c >= (select max(c) from recent) * 0.7`,
  );
  const d = r[0]?.d;
  if (!d) {
    process.stderr.write('일봉이 하나도 없습니다.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${d}\n`);
}

main()
  .catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
