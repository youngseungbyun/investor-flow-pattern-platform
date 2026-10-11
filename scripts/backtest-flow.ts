/**
 * 수급 결합 필터 실험.
 *
 *   npx tsx scripts/backtest-flow.ts [--limit 2000] [--save]
 *
 * 수급 이벤트(flow_events)는 최근 약 25거래일만 보관하므로, 그 기간의 각 날짜를 기준일로 삼아
 * 이후 5·10거래일 수익률을 잰다(표본은 많지만 한 시장 국면이라 참고용).
 * 시장 전체가 오른 날의 착시를 빼려고 "그날 전 종목 중앙값 대비 초과수익"으로 승률을 센다.
 * --save 를 주면 결과를 pattern_stats 에 stage='flow:<조건>' 으로 남긴다.
 */
import { pool, query, exec, bulkInsert, todayKst } from '../src/lib/core';
import { detectAll, loadBarsBatch } from '../src/domain/patterns';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const HORIZONS = [5, 10];
const MAIN = ['foreign', 'institution_total', 'private_fund', 'trust'];

interface Obs {
  date: string;
  excessBase: number;
  ret: Record<number, number>;
  tags: Set<string>;
}

async function main() {
  const limit = Number(arg('limit') ?? 2000);
  const asOf = todayKst();
  const syms = (
    await query<{ symbol: string }>(
      `select symbol from ohlcv_daily
        where date = (select max(date) from ohlcv_daily where date <= $1::date) and traded_value >= 1000000000
        order by traded_value desc limit $2`,
      [asOf, limit],
    )
  ).map((r) => r.symbol);
  const flow = await query<{ symbol: string; date: string; t: string; z: string | null; s: number | null; r: string | null; q: string }>(
    `select symbol, to_char(date,'YYYY-MM-DD') date, investor_type t, z20 z, streak s, float_ratio_pct r, net_buy_qty q
       from flow_events where symbol = any($1::text[])`,
    [syms],
  );
  const flowBy = new Map<string, typeof flow>();
  for (const f of flow) {
    const k = `${f.symbol}|${f.date}`;
    const a = flowBy.get(k) ?? [];
    a.push(f);
    flowBy.set(k, a);
  }
  const dates = [...new Set(flow.map((f) => f.date))].sort();
  console.log(`대상 ${syms.length}종목 · 수급 보관 ${dates[0]}~${dates[dates.length - 1]} (${dates.length}일)`);

  const barsBy = await loadBarsBatch(syms, asOf, 400);
  const obs: Array<Obs & { symbol: string }> = [];
  for (const symbol of syms) {
    const bars = barsBy.get(symbol) ?? [];
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    for (const d of dates) {
      const t = idx.get(d);
      if (t === undefined || t < 150) continue;
      const ret: Record<number, number> = {};
      for (const hz of HORIZONS) if (t + hz < bars.length) ret[hz] = (bars[t + hz].c / bars[t].c - 1) * 100;
      if (Object.keys(ret).length === 0) continue;

      const tags = new Set<string>(['all']);
      const fl = flowBy.get(`${symbol}|${d}`) ?? [];
      const mainBuy = fl.filter((f) => MAIN.includes(f.t) && Number(f.q) > 0);
      if (mainBuy.some((f) => (f.s ?? 0) >= 3)) tags.add('flow:streak3');
      if (mainBuy.some((f) => Number(f.z ?? 0) >= 2)) tags.add('flow:z2');
      if (mainBuy.some((f) => Number(f.r ?? 0) >= 0.3)) tags.add('flow:float0.3');
      const fi = fl.filter((f) => ['foreign', 'institution_total'].includes(f.t) && Number(f.q) > 0);
      if (fi.length === 2) tags.add('flow:foreign+inst');
      const hb = fl.find((f) => f.t === 'handbuy_total');
      if (hb && Number(hb.q) > 0 && ((hb.s ?? 0) >= 2 || Number(hb.z ?? 0) >= 1.5)) tags.add('flow:handbuy');
      const anyFlow = [...tags].some((x) => x.startsWith('flow:'));

      const window = bars.slice(Math.max(0, t - 219), t + 1);
      const pat = detectAll(symbol, window).filter(
        (h) => h.direction === 'bullish' && ['near_pivot', 'breakout', 'pullback'].includes(h.stage),
      );
      if (pat.length) {
        tags.add('pat');
        if (pat.some((h) => h.score >= 60)) tags.add('pat:score60');
        for (const x of [...tags].filter((x) => x.startsWith('flow:'))) tags.add(`pat+${x}`);
        tags.add(anyFlow ? 'pat+anyflow' : 'pat+noflow');
      }
      obs.push({ symbol, date: d, excessBase: 0, ret, tags });
    }
  }

  // 그날 전 종목 중앙값
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const dayMed = new Map<string, number>();
  for (const hz of HORIZONS)
    for (const d of dates) {
      const xs = obs.filter((o) => o.date === d && o.ret[hz] !== undefined).map((o) => o.ret[hz]);
      if (xs.length > 200) dayMed.set(`${d}|${hz}`, med(xs));
    }

  const rows: Array<[string, string, number, number, number, number, number]> = [];
  const keys = new Set<string>();
  obs.forEach((o) => o.tags.forEach((t) => keys.add(t)));
  console.log('\n조건                     기간  표본    초과승률%  평균초과%  원승률%');
  for (const hz of HORIZONS) {
    for (const key of [...keys].sort()) {
      const xs: number[] = [];
      const raws: number[] = [];
      for (const o of obs) {
        if (!o.tags.has(key) || o.ret[hz] === undefined) continue;
        const m = dayMed.get(`${o.date}|${hz}`);
        if (m === undefined) continue;
        xs.push(o.ret[hz] - m);
        raws.push(o.ret[hz]);
      }
      if (xs.length < 30) continue;
      const win = (xs.filter((x) => x > 0).length / xs.length) * 100;
      const avg = xs.reduce((s, x) => s + x, 0) / xs.length;
      const rawWin = (raws.filter((x) => x > 0).length / raws.length) * 100;
      console.log(`${key.padEnd(24)} ${String(hz).padStart(3)} ${String(xs.length).padStart(7)} ${win.toFixed(1).padStart(9)} ${avg.toFixed(2).padStart(9)} ${rawWin.toFixed(1).padStart(8)}`);
      rows.push([`excess`, `flow:${key}`, hz, xs.length, Number(win.toFixed(2)), Number(avg.toFixed(3)), Number(med(xs).toFixed(3))]);
    }
  }
  if (process.argv.includes('--save')) {
    await exec(`delete from pattern_stats where pattern = 'excess'`);
    await bulkInsert('pattern_stats', ['pattern', 'stage', 'horizon', 'n', 'win_rate', 'avg_ret', 'med_ret'], rows,
      `on conflict (pattern, stage, horizon) do update set n = excluded.n, win_rate = excluded.win_rate, avg_ret = excluded.avg_ret, med_ret = excluded.med_ret, updated_at = now()`);
    console.log(`\n저장 ${rows.length}행`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool().end());
