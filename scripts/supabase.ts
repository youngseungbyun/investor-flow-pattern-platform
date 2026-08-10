/**
 * Supabase 연결 확인 · 데이터 이관.
 *
 *   npm run supabase:check          접속·스키마·행수 확인
 *   npm run supabase:sync           로컬(PGlite) → Supabase market 스키마로 데이터 복사
 *   npm run supabase:sync -- --tables instruments,ohlcv_daily
 *
 * 접속 정보는 SUPABASE_DATABASE_URL 환경변수로만 받는다(코드에 하드코딩하지 않는다).
 * Supabase 대시보드 > Connect > Session pooler 의 URI 를 그대로 붙여넣으면 된다.
 */
import { config as loadEnvFile } from 'dotenv';
import { Client, Pool } from 'pg';

loadEnvFile({ path: '.env.local', quiet: true });
loadEnvFile({ quiet: true });

const LOCAL_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55432/postgres';
// 대상 DB. Supabase 전용이 아니라 어떤 Postgres 든 받는다(Neon·Netlify DB 포함).
const REMOTE_URL = process.env.REMOTE_DATABASE_URL ?? process.env.SUPABASE_DATABASE_URL ?? '';
// 전용 스키마가 필요 없으면 비워 둔다. Netlify DB(Neon)는 public 을 그대로 쓴다.
const REMOTE_SCHEMA = process.env.REMOTE_SCHEMA ?? process.env.SUPABASE_SCHEMA ?? '';

/** 이관 순서 — 참조 관계상 instruments 를 먼저 넣는다. */
const TABLES = [
  'trading_days',
  'instruments',
  'ohlcv_daily',
  'ohlcv_minute',
  'investor_flow_daily',
  'investor_flow_period',
  'flow_events',
  'member_flow_daily',
  'program_trade_daily',
  'program_trade_minute',
  'insider_reports',
  'insider_trades',
  'pattern_hits',
  'support_lines',
  'line_signals',
  'screener_snapshots',
  'chart_drawings',
  'chart_layouts',
  'batch_runs',
];

/** upsert 충돌키 — 각 테이블의 자연키 */
const CONFLICT: Record<string, string> = {
  trading_days: 'date',
  instruments: 'symbol',
  ohlcv_daily: 'symbol, date',
  ohlcv_minute: 'symbol, ts',
  investor_flow_daily: 'symbol, date, investor_type',
  investor_flow_period: 'symbol, start_date, end_date, investor_type',
  flow_events: 'symbol, date, investor_type',
  member_flow_daily: 'symbol, date, member_name',
  program_trade_daily: 'symbol, date',
  program_trade_minute: 'symbol, ts',
  insider_reports: 'rcept_no',
  insider_trades: 'rcept_no, symbol, officer_name, trade_date, change_qty, method',
  pattern_hits: 'symbol, date, pattern',
  support_lines: 'symbol, date, line_id',
  line_signals: 'symbol, date, signal',
  screener_snapshots: 'date, params_hash',
  chart_drawings: 'user_id, symbol',
  chart_layouts: 'user_id, client_id, name',
  batch_runs: 'date, step',
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return process.argv[process.argv.indexOf(hit) + 1];
}

function remotePool(): Pool {
  if (!REMOTE_URL) {
    throw new Error(
      'SUPABASE_DATABASE_URL 이 비어 있습니다.\n' +
        '  Supabase 대시보드 > 프로젝트 > Connect > Session pooler 의 URI 를 복사해\n' +
        '  .env.local 의 SUPABASE_DATABASE_URL 에 넣으세요. ([YOUR-PASSWORD] 를 실제 비밀번호로 치환)',
    );
  }
  return new Pool({
    connectionString: REMOTE_URL,
    max: 4,
    ssl: { rejectUnauthorized: false },
    ...(REMOTE_SCHEMA ? { options: `-c search_path=${REMOTE_SCHEMA},public` } : {}),
  });
}

/* ─────────────────────────── check ─────────────────────────── */

async function check() {
  console.log('■ 로컬');
  const local = new Client({ connectionString: LOCAL_URL });
  await local.connect();
  const lv = await local.query('select version()');
  console.log(`  ${LOCAL_URL.replace(/:[^:@/]*@/, ':****@')}`);
  console.log(`  ${String(lv.rows[0].version).slice(0, 60)}`);
  const lrows = await local.query(
    `select relname, n_live_tup from pg_stat_user_tables order by relname`,
  );
  const localCounts = new Map(lrows.rows.map((r) => [r.relname as string, Number(r.n_live_tup)]));

  console.log('\n■ Supabase');
  let remote: Pool | null = null;
  try {
    remote = remotePool();
    const rv = await remote.query('select version(), current_schema()');
    console.log(`  ${REMOTE_URL.replace(/:[^:@/]*@/, ':****@')}`);
    console.log(`  ${String(rv.rows[0].version).slice(0, 60)}`);
    console.log(`  current_schema = ${rv.rows[0].current_schema}`);

    console.log('\n■ 테이블별 행수 (로컬 → Supabase)');
    for (const t of TABLES) {
      let remoteN = '-';
      try {
        const r = await remote.query(`select count(*)::text n from ${REMOTE_SCHEMA}.${t}`);
        remoteN = Number(r.rows[0].n).toLocaleString();
      } catch {
        remoteN = '없음';
      }
      // n_live_tup 은 근사치라 정확한 값이 필요하면 count 를 쓴다
      const lr = await local.query(`select count(*)::text n from ${t}`).catch(() => null);
      const localN = lr ? Number(lr.rows[0].n).toLocaleString() : String(localCounts.get(t) ?? 0);
      console.log(`  ${t.padEnd(24)} ${localN.padStart(11)} → ${remoteN.padStart(11)}`);
    }
  } catch (e) {
    console.log(`  연결 실패: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await remote?.end();
    await local.end();
  }
}

/* ─────────────────────────── sync ─────────────────────────── */

async function sync() {
  const only = arg('tables')?.split(',').map((s) => s.trim()).filter(Boolean);
  const chunk = Number(arg('chunk') ?? 2000);
  const targets = only ?? TABLES;
  const since = arg('since');
  if (since) console.log(`  기준: ${since} 이후 데이터만 올립니다`);

  const local = new Client({ connectionString: LOCAL_URL });
  await local.connect();
  const remote = remotePool();

  console.log(`이관 대상 ${targets.length}개 테이블 · 청크 ${chunk}행\n`);

  for (const table of targets) {
    const conflict = CONFLICT[table];
    if (!conflict) {
      console.log(`  ${table.padEnd(24)} 충돌키 미정의 → 건너뜀`);
      continue;
    }

    // 로컬 컬럼 목록 (bigserial id 같은 자동생성 컬럼은 제외)
    const colsRes = await local.query<{ column_name: string; is_identity: string; column_default: string | null }>(
      `select column_name, is_identity, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position`,
      [table],
    );
    if (colsRes.rows.length === 0) {
      console.log(`  ${table.padEnd(24)} 로컬에 없음 → 건너뜀`);
      continue;
    }
    const cols = colsRes.rows
      .filter((c) => !(c.column_default ?? '').startsWith('nextval('))
      .map((c) => c.column_name);

    // --since 가 있으면 날짜 컬럼이 있는 테이블만 그 이후로 자른다.
    // 무료 DB 는 용량 한도가 있어 전 구간을 올리면 들어가지 않는다.
    const dateCol = colsRes.rows.some((c) => c.column_name === 'date')
      ? 'date'
      : colsRes.rows.some((c) => c.column_name === 'ts')
        ? 'ts'
        : null;
    const where = since && dateCol ? ` where ${dateCol} >= '${since}'` : '';

    const total = Number(
      (await local.query(`select count(*)::text n from ${table}${where}`)).rows[0].n,
    );
    if (total === 0) {
      console.log(`  ${table.padEnd(24)} 0행 → 건너뜀`);
      continue;
    }

    const updateSet = cols
      .filter((c) => !conflict.split(',').map((x) => x.trim()).includes(c))
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');

    let done = 0;
    for (let offset = 0; offset < total; offset += chunk) {
      const batch = await local.query(
        `select ${cols.join(',')} from ${table}${where} order by ${cols.slice(0, 2).join(',')} limit $1 offset $2`,
        [chunk, offset],
      );
      if (batch.rows.length === 0) break;

      const values: unknown[] = [];
      const tuples = batch.rows.map((row, i) => {
        const ph = cols.map((_, j) => `$${i * cols.length + j + 1}`);
        cols.forEach((c) => values.push((row as Record<string, unknown>)[c]));
        return `(${ph.join(',')})`;
      });

      await remote.query(
        `insert into ${REMOTE_SCHEMA}.${table} (${cols.join(',')}) values ${tuples.join(',')}
         on conflict (${conflict}) do ${updateSet ? `update set ${updateSet}` : 'nothing'}`,
        values,
      );
      done += batch.rows.length;
      if (offset === 0 || done % (chunk * 10) === 0 || done >= total) {
        process.stdout.write(`\r  ${table.padEnd(24)} ${done.toLocaleString()}/${total.toLocaleString()}   `);
      }
    }
    console.log(`\r  ${table.padEnd(24)} ${done.toLocaleString()}/${total.toLocaleString()} 완료      `);
  }

  await remote.end();
  await local.end();
  console.log('\n이관 완료.');
}

const cmd = process.argv[2] ?? 'check';
(cmd === 'sync' ? sync() : check()).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
