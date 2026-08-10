/**
 * core.ts — 환경변수 / DB / HTTP(rate limit) / 날짜 유틸.
 * 서버 전용. 클라이언트 컴포넌트에서 import 하지 말 것.
 */
import { config as loadEnvFile } from 'dotenv';
import { Pool, type QueryResultRow } from 'pg';

loadEnvFile({ path: '.env.local', quiet: true });
loadEnvFile({ quiet: true });

/* ────────────────────────────── env ────────────────────────────── */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 비어 있습니다. .env.local 을 확인하세요.`);
  return v;
}
const num = (name: string, dflt: number) => Number(process.env[name] ?? dflt);
const str = (name: string, dflt = '') => (process.env[name] ?? dflt).trim();

export const env = {
  get dataGoKrKey() {
    return required('DATA_GO_KR_API_KEY');
  },
  get openDartKey() {
    return required('OPEN_DART_API_KEY');
  },
  /**
   * 접속 문자열 우선순위.
   *
   * Netlify DB(Neon) 확장은 빌드 때 DB 를 잡아 NETLIFY_DATABASE_URL 을 주입한다.
   * 이 값은 사람이 넣는 게 아니라 플랫폼이 넣으므로 DATABASE_URL 보다 뒤에 둔다.
   * 로컬에서 DATABASE_URL 을 지정하면 그쪽이 이긴다.
   *
   * 마지막 폴백은 로컬 PGlite 다. 배포 환경에서 이 값이 쓰이면 127.0.0.1 로 붙다가
   * ECONNREFUSED 가 나므로, 그 자체가 "환경변수를 안 넣었다"는 신호가 된다.
   */
  databaseUrl:
    str('DATABASE_URL') ||
    // Netlify DB 가 실제로 주입하는 이름은 NETLIFY_DB_URL 이다.
    // 문서·홍보 이미지에 보이는 NETLIFY_DATABASE_URL 은 구 확장 시절 이름이라
    // 그것만 읽으면 영원히 못 찾는다. 둘 다 본다.
    str('NETLIFY_DB_URL') ||
    str('NETLIFY_DATABASE_URL') ||
    str('NETLIFY_DATABASE_URL_UNPOOLED') ||
    'postgres://postgres:postgres@127.0.0.1:55432/postgres',
  investorFlowProviders: str('INVESTOR_FLOW_PROVIDER', 'naver')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  memberFlowProvider: str('MEMBER_FLOW_PROVIDER', 'none'),
  krxCsvDir: str('KRX_CSV_DIR', 'data/krx-csv'),
  krxMarketplaceId: str('KRX_MARKETPLACE_ID'),
  krxMarketplacePw: str('KRX_MARKETPLACE_PW'),
  licensedApiBase: str('LICENSED_FLOW_API_BASE'),
  licensedApiKey: str('LICENSED_FLOW_API_KEY'),
  requestIntervalMs: Math.max(1000, num('REQUEST_INTERVAL_MS', 1000)),
  historyDays: num('HISTORY_DAYS', 260),
  defaultUserId: str('DEFAULT_USER_ID', 'local'),
};

/* ────────────────────────────── db ────────────────────────────── */

declare global {
  // eslint-disable-next-line no-var
  var __sdPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__sdPool) {
    const schema = str('DB_SCHEMA');
    globalThis.__sdPool = new Pool({
      connectionString: env.databaseUrl,
      max: num('PG_POOL_MAX', 4),
      idleTimeoutMillis: 30_000,
      // Supabase 는 전용 스키마(market)에 넣는다. 로컬 PGlite 는 public 을 그대로 쓴다.
      // URL 쿼리스트링 대신 연결 옵션으로 넘겨야 인코딩 문제가 없다.
      ...(schema ? { options: `-c search_path=${schema},public` } : {}),
      // 관리형 Postgres(Supabase·Neon)는 TLS 필수. 로컬 소켓 서버는 TLS 가 없다.
      // 127.0.0.1 이나 localhost 가 아니면 원격으로 보고 TLS 를 켠다.
      ...(/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)/.test(env.databaseUrl)
        ? {}
        : { ssl: { rejectUnauthorized: false } }),
    });
  }
  return globalThis.__sdPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(sql, params as never);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pool().query(sql, params as never);
  return res.rowCount ?? 0;
}

/** 파라미터 상한에 걸리지 않도록 나눠서 넣는 다중 INSERT 헬퍼. */
export async function bulkInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const perRow = columns.length;
  const maxRows = Math.max(1, Math.floor(60000 / perRow));
  let total = 0;
  for (const part of chunk(rows, maxRows)) {
    const values: unknown[] = [];
    const tuples = part.map((row, i) => {
      const ph = row.map((_, j) => `$${i * perRow + j + 1}`);
      values.push(...row);
      return `(${ph.join(',')})`;
    });
    total += await exec(
      `insert into ${table} (${columns.join(',')}) values ${tuples.join(',')} ${conflict}`,
      values,
    );
  }
  return total;
}

/* ──────────────────────────── helpers ──────────────────────────── */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 숫자 문자열("1,234", "+1,234", "-", "") → number. 못 읽으면 null. */
export function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,\s%+]/g, '');
  if (s === '' || s === '-' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const int = (v: unknown): number => Math.round(parseNum(v) ?? 0);

/* ───────────────────────────── dates ───────────────────────────── */

/** 내부 표준은 'YYYY-MM-DD'. 외부 API 입력은 'YYYYMMDD'. */
export const ymd = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const compact = (isoDate: string) => isoDate.replace(/-/g, '');
export const expand = (yyyymmdd: string) =>
  `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/** KST 기준 오늘 (서버 타임존과 무관하게 동작). */
export function todayKst(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60_000);
  return ymd(kst);
}

export function addDays(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export const isWeekend = (isoDate: string) => {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
};

/** 주말을 제외한 후보 날짜를 최신순으로. 공휴일은 trading_days 로 확정한다. */
export function candidateDays(endIso: string, count: number): string[] {
  const out: string[] = [];
  let cur = endIso;
  let guard = 0;
  while (out.length < count && guard++ < count * 3 + 40) {
    if (!isWeekend(cur)) out.push(cur);
    cur = addDays(cur, -1);
  }
  return out;
}

/** DB 에 확정된 개장일 목록(최신순). */
export async function openTradingDays(endIso: string, count: number): Promise<string[]> {
  const rows = await query<{ date: Date }>(
    `select date from trading_days where is_open and date <= $1 order by date desc limit $2`,
    [endIso, count],
  );
  return rows.map((r) => ymd(new Date(r.date)));
}

/* ──────────────────────── HTTP (rate limited) ──────────────────── */

const lastCallAt = new Map<string, number>();

async function throttle(host: string, intervalMs: number) {
  const prev = lastCallAt.get(host) ?? 0;
  const wait = prev + intervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt.set(host, Date.now());
}

export interface FetchOptions extends RequestInit {
  /** 호스트별 최소 요청 간격(ms). 기본 env.requestIntervalMs */
  intervalMs?: number;
  retries?: number;
  timeoutMs?: number;
  /** 응답을 utf-8 이 아닌 인코딩으로 디코드할 때 사용 */
  decode?: (buf: ArrayBuffer) => string;
}

/** 호스트별 최소 간격 + 지수 백오프 재시도. 라이선스 가드레일 4번 항목. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { intervalMs, retries = 3, timeoutMs = 30_000, decode, ...init } = opts;
  const host = new URL(url).host;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, intervalMs ?? env.requestIntervalMs);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${host}`);
      }
      const buf = await res.arrayBuffer();
      return decode ? decode(buf) : new TextDecoder('utf-8').decode(buf);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`JSON 파싱 실패 (${url}): ${text.slice(0, 200)}`);
  }
}

export async function fetchBuffer(url: string, opts: RequestInit = {}): Promise<Buffer> {
  const host = new URL(url).host;
  await throttle(host, env.requestIntervalMs);
  const res = await fetch(url, opts);
  return Buffer.from(await res.arrayBuffer());
}

/* ─────────────────────────── batch log ─────────────────────────── */

export type BatchStatus = 'running' | 'ok' | 'partial' | 'pending' | 'failed' | 'skipped';

export async function logStep(
  date: string,
  step: string,
  status: BatchStatus,
  rowCount = 0,
  error?: string | null,
  provider?: string | null,
) {
  await exec(
    `insert into batch_runs (date, step, status, row_count, error, provider, started_at, ran_at)
     values ($1,$2,$3,$4,$5,$6, now(), now())
     on conflict (date, step) do update
       set status = excluded.status,
           row_count = excluded.row_count,
           error = excluded.error,
           provider = excluded.provider,
           ran_at = now()`,
    [date, step, status, rowCount, error ?? null, provider ?? null],
  );
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
