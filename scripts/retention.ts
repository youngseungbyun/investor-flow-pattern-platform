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

/**
 * 날짜 컬럼으로 자를 테이블. 세 번째 값은 그 테이블만의 보존 거래일 수다.
 *
 * 일봉과 거래일 달력은 예외적으로 훨씬 길게 남긴다. 주봉·월봉 차트가 이 둘로만
 * 그려지는데 60거래일만 두면 월봉이 3개밖에 안 나온다. 일봉은 하루 약 2,900행이라
 * 3년치를 담아도 무료 한도 안에 들어온다. 용량을 실제로 먹는 건 분봉·수급이다.
 */
const DEFAULT_KEEP = 60;
const BAR_KEEP = 500;

const TRIM: Array<[table: string, col: string, keep?: number]> = [
  ['ohlcv_daily', 'date', BAR_KEEP],
  ['trading_days', 'date', BAR_KEEP],
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
];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return process.argv[process.argv.indexOf(hit) + 1];
}

async function main() {
  const keep = Number(arg('keep') ?? DEFAULT_KEEP);
  const dry = process.argv.includes('--dry');

  // 거래일 기준으로 센다. 달력 일수로 자르면 연휴가 낀 구간에서 실제 보존량이 흔들린다.
  const cutCache = new Map<number, string | null>();
  const cutFor = async (k: number): Promise<string | null> => {
    if (cutCache.has(k)) return cutCache.get(k)!;
    const rows = await query<{ cut: string | null }>(
      `select to_char(min(d), 'YYYY-MM-DD') cut
         from (select distinct date d from ohlcv_daily order by d desc limit $1) t`,
      [k],
    );
    const v = rows[0]?.cut ?? null;
    cutCache.set(k, v);
    return v;
  };

  const base = await cutFor(keep);
  if (!base) {
    console.log('일봉이 없어 정리할 대상이 없습니다.');
    return;
  }
  console.log(`보존 기준일 ${base} (최근 ${keep}거래일)${dry ? ' · 모의 실행' : ''}`);

  let removed = 0;
  for (const [table, col, tableKeep] of TRIM) {
    // 테이블별 보존이 지정되면 그 길이로 다시 자른다.
    // 보유 거래일이 그보다 적으면 cut 이 가장 오래된 날이라 아무것도 안 지운다.
    const cut = tableKeep && tableKeep !== keep ? ((await cutFor(tableKeep)) ?? base) : base;
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

  // 지운 자리를 회수하지 않으면 파일은 계속 커진다. 실제로 flow_events 가
  // 285,864행에 159MB(행당 583B)까지 부풀어 무료 한도의 3분의 1을 혼자 먹고 있었다.
  // 매 수집마다 지우고 다시 넣는 구조라 자동 청소가 못 따라온다.
  // 여기서 도는 일반 VACUUM 은 잠금이 없고 공간을 재사용 가능하게 만들어 총량을 붙잡아 둔다.
  // (OS 로 되돌리려면 `vacuum full` 이 필요한데 잠금이 걸려 수동으로만 돌린다.)
  if (!dry && removed > 0) {
    for (const [table] of TRIM) {
      try {
        await exec(`vacuum (analyze) ${table}`);
      } catch {
        // 권한이 없거나 테이블이 없으면 넘어간다. 정리 자체는 이미 끝났다.
      }
    }
    console.log('빈 공간 회수 완료');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
