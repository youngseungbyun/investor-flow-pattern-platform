/**
 * 일별 수급 장기 보관.
 *
 * investor_flow_daily · program_trade_daily 는 보관 25거래일을 넘으면 지워진다. 그 전에
 * 완성된 날(가장 최근 날 제외)을 하루 한 덩어리 gzip CSV 로 flow_archive 에 넣는다.
 * 일별 백테스트가 몇 달치를 다시 쓸 수 있게 하는 것이 목적이다. 같은 날을 두 번 넣지 않는다.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { exec, query } from '../lib/core';

export type ArchiveKind = 'flow' | 'program';

const FLOW_HEADER = 'symbol,investor_type,net_buy_qty,net_buy_amount';
const PROGRAM_HEADER = 'symbol,sell_qty,buy_qty,net_qty,sell_amt,buy_amt,net_amt';

export function encodeCsv(header: string, rows: Array<Array<string | number | null>>): Buffer {
  const text = [header, ...rows.map((r) => r.map((v) => (v === null ? '' : String(v))).join(','))].join('\n');
  return gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
}

export function decodeCsv(buf: Buffer): Array<Record<string, string>> {
  const [head, ...lines] = gunzipSync(buf).toString('utf8').split('\n');
  const cols = head.split(',');
  return lines.filter(Boolean).map((l) => {
    const v = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
}

/** 아직 보관하지 않은 완성된 날(가장 최근 날 제외)을 모두 넣는다. 넣은 (날짜, 종류) 수를 돌려준다. */
export async function archiveFlowDays(): Promise<{ days: number; rows: number }> {
  const latest = (await query<{ d: string | null }>(`select to_char(max(date),'YYYY-MM-DD') d from investor_flow_daily`))[0]?.d;
  if (!latest) return { days: 0, rows: 0 };
  let days = 0;
  let total = 0;

  const flowDates = await query<{ d: string }>(
    `select to_char(f.date,'YYYY-MM-DD') d from investor_flow_daily f
      where f.date < $1::date
        and not exists (select 1 from flow_archive a where a.date = f.date and a.kind = 'flow')
      group by f.date order by f.date`,
    [latest],
  );
  for (const { d } of flowDates) {
    const rows = await query<{ symbol: string; investor_type: string; q: string; a: string | null }>(
      `select symbol, investor_type, net_buy_qty::text q, net_buy_amount::text a
         from investor_flow_daily where date = $1::date order by symbol, investor_type`,
      [d],
    );
    const payload = encodeCsv(FLOW_HEADER, rows.map((r) => [r.symbol, r.investor_type, r.q, r.a]));
    await exec(
      `insert into flow_archive (date, kind, n_rows, payload) values ($1::date, 'flow', $2, $3)
       on conflict (date, kind) do nothing`,
      [d, rows.length, payload],
    );
    days++;
    total += rows.length;
  }

  const progDates = await query<{ d: string }>(
    `select to_char(p.date,'YYYY-MM-DD') d from program_trade_daily p
      where p.date < $1::date
        and not exists (select 1 from flow_archive a where a.date = p.date and a.kind = 'program')
      group by p.date order by p.date`,
    [latest],
  );
  for (const { d } of progDates) {
    const rows = await query<Record<string, string>>(
      `select symbol, sell_qty::text, buy_qty::text, net_qty::text, sell_amt::text, buy_amt::text, net_amt::text
         from program_trade_daily where date = $1::date order by symbol`,
      [d],
    );
    const payload = encodeCsv(
      PROGRAM_HEADER,
      rows.map((r) => [r.symbol, r.sell_qty, r.buy_qty, r.net_qty, r.sell_amt, r.buy_amt, r.net_amt]),
    );
    await exec(
      `insert into flow_archive (date, kind, n_rows, payload) values ($1::date, 'program', $2, $3)
       on conflict (date, kind) do nothing`,
      [d, rows.length, payload],
    );
    days++;
    total += rows.length;
  }
  return { days, rows: total };
}

/** 보관한 날들을 읽어 온다(백테스트용). from~to 는 YYYY-MM-DD, 양 끝 포함. */
export async function loadArchivedFlow(kind: ArchiveKind, from: string, to: string) {
  const rows = await query<{ d: string; payload: Buffer }>(
    `select to_char(date,'YYYY-MM-DD') d, payload from flow_archive
      where kind = $1 and date between $2::date and $3::date order by date`,
    [kind, from, to],
  );
  return rows.map((r) => ({ date: r.d, rows: decodeCsv(r.payload) }));
}
