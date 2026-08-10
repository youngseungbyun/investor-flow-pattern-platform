/**
 * 오래된 데이터를 잘라 DB 용량을 일정하게 유지한다.
 *
 *   npm run db:retention                  최근 60거래일만 남긴다
 *   npm run db:retention -- --keep 90     보존 일수 변경
 *   npm run db:retention -- --dry         지울 건수만 세고 실제로는 안 지운다
 *
 * 무료 Postgres 는 용량 한도가 있는데 이 도구는 거래일마다 데이터가 늘어난다.
 * 수집을 자동화하면 언젠가 반드시 한도에 부딪히므로, 수집과 같은 주기로 돌려
 * 총량을 고정시킨다.
 *
 * instruments 처럼 날짜가 없는 마스터 테이블은 건드리지 않는다.
 */
import { exec, pool, query } from '../src/lib/core';

/** 날짜 컬럼으로 자를 테이블. 값은 기준 컬럼명. */
const TRIM: Array<[table: string, col: string]> = [
  ['ohlcv_daily', 'date'],
  ['ohlcv_minute', 'ts'],
  ['investor_flow_daily', 'date'],
  ['investor_flow_period', 'end_date'],
  ['flow_events', 'date'],
  ['member_flow_daily', 'date'],
  ['program_trade_daily', 'date'],
  ['program_trade_minute', 'ts'],
  ['pattern_hits', 'date'],
  ['support_lines', 'date'],
  ['line_signals', 'date'],
  ['screener_snapshots', 'date'],
  ['batch_runs', 'date'],
  ['trading_days', 'date'],
];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return process.argv[process.argv.indexOf(hit) + 1];
}

async function main() {
  const keep = Number(arg('keep') ?? 60);
  const dry = process.argv.includes('--dry');

  // 거래일 기준으로 센다. 달력 일수로 자르면 연휴가 낀 구간에서 실제 보존량이 흔들린다.
  const cutRows = await query<{ cut: string | null }>(
    `select to_char(min(d), 'YYYY-MM-DD') cut
       from (select distinct date d from ohlcv_daily order by d desc limit $1) t`,
    [keep],
  );
  const cut = cutRows[0]?.cut;
  if (!cut) {
    console.log('일봉이 없어 정리할 대상이 없습니다.');
    return;
  }
  console.log(`보존 기준일 ${cut} (최근 ${keep}거래일)${dry ? ' · 모의 실행' : ''}`);

  let removed = 0;
  for (const [table, col] of TRIM) {
    const exists = await query<{ n: string }>(
      `select count(*)::text n from information_schema.tables
        where table_schema = current_schema() and table_name = $1`,
      [table],
    );
    if (Number(exists[0]?.n ?? 0) === 0) continue;

    if (dry) {
      const c = await query<{ n: string }>(
        `select count(*)::text n from ${table} where ${col} < $1::date`,
        [cut],
      );
      const n = Number(c[0].n);
      if (n > 0) console.log(`  ${table.padEnd(22)} ${n.toLocaleString('ko-KR')}행 삭제 예정`);
      removed += n;
      continue;
    }

    const n = await exec(`delete from ${table} where ${col} < $1::date`, [cut]);
    if (n > 0) console.log(`  ${table.padEnd(22)} ${n.toLocaleString('ko-KR')}행 삭제`);
    removed += n;
  }

  console.log(`정리 완료 — 총 ${removed.toLocaleString('ko-KR')}행${dry ? ' (모의)' : ''}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
