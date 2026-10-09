/**
 * 패턴 과거 성과 측정.
 *
 *   npx tsx scripts/backtest.ts                  거래대금 상위 유니버스 전체
 *   npx tsx scripts/backtest.ts --limit 100      상위 100종목만
 *   npx tsx scripts/backtest.ts --dry            결과만 찍고 저장하지 않는다
 *
 * 보관 중인 일봉(약 370거래일)으로 "그날 기준 데이터만 보고" 패턴을 판정한 뒤,
 * 그 뒤 5·10·20거래일의 수익률을 잰다. 미래 봉은 판정에 쓰지 않는다.
 * 하락 패턴은 부호를 뒤집어 "방향이 맞았는가"로 센다.
 *
 * 결과는 pattern_stats 에 쌓이고, 패턴 판정 단계가 점수 옆에 과거 승률을 붙인다.
 * 점수가 높을수록 실제로 더 잘 맞는지도 점수 구간별로 같이 남긴다.
 */
import { pool, query, exec, bulkInsert, todayKst } from '../src/lib/core';
import { detectAll, loadBarsBatch } from '../src/domain/patterns';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const HORIZONS = [5, 10, 20];
const ACTIONABLE = new Set(['near_pivot', 'breakout', 'pullback']);

interface Acc {
  rets: number[];
}

async function main() {
  const limit = Number(arg('limit') ?? 2000);
  const step = Number(arg('step') ?? 4);
  const dry = process.argv.includes('--dry');
  const asOf = arg('date') ?? todayKst();

  const syms = (
    await query<{ symbol: string }>(
      `select symbol from ohlcv_daily
        where date = (select max(date) from ohlcv_daily where date <= $1::date)
          and traded_value >= 1000000000
        order by traded_value desc limit $2`,
      [asOf, limit],
    )
  ).map((r) => r.symbol);
  console.log(`백테스트 대상 ${syms.length}종목 · 간격 ${step}봉`);

  const barsBy = await loadBarsBatch(syms, asOf, 400);
  const acc = new Map<string, Acc>();
  const push = (key: string, r: number) => {
    const a = acc.get(key) ?? { rets: [] };
    a.rets.push(r);
    acc.set(key, a);
  };

  let done = 0;
  const t0 = Date.now();
  for (const symbol of syms) {
    const all = barsBy.get(symbol) ?? [];
    for (let t = 150; t < all.length - 5; t += step) {
      const window = all.slice(Math.max(0, t - 219), t + 1);
      const hits = detectAll(symbol, window);
      for (const h of hits) {
        if (!ACTIONABLE.has(h.stage)) continue;
        const sign = h.direction === 'bearish' ? -1 : 1;
        for (const hz of HORIZONS) {
          if (t + hz >= all.length) continue;
          const r = (all[t + hz].c / all[t].c - 1) * 100 * sign;
          push(`${h.pattern}|${h.stage}|${hz}`, r);
          push(`*|${h.stage}|${hz}`, r);
          push(`*|score${h.score >= 60 ? '>=60' : '<60'}|${hz}`, r);
          if (h.score >= 70) push(`*|score>=70|${hz}`, r);
          if (h.stage === 'breakout') {
            const vr = Number((h.evidence as Record<string, unknown>).breakoutVolumeRatio ?? 0);
            push(`*|breakout_vol${vr >= 2 ? '>=2x' : vr >= 1.5 ? '1.5~2x' : '<1.5x'}|${hz}`, r);
          }
          if (h.stage === 'near_pivot' && Math.abs(h.distancePct ?? 99) <= 1.5) push(`*|near_pivot<=1.5%|${hz}`, r);
        }
      }
    }
    if (++done % 50 === 0) {
      const sec = Math.round((Date.now() - t0) / 1000);
      console.log(`  ${done}/${syms.length} · ${sec}초`);
    }
  }

  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const rows: Array<[string, string, number, number, number, number, number]> = [];
  for (const [key, a] of acc) {
    const [pattern, stage, hz] = key.split('|');
    const n = a.rets.length;
    const win = (a.rets.filter((x) => x > 0).length / n) * 100;
    const avg = a.rets.reduce((s, x) => s + x, 0) / n;
    rows.push([pattern, stage, Number(hz), n, Number(win.toFixed(2)), Number(avg.toFixed(3)), Number(med(a.rets).toFixed(3))]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);

  console.log('\n패턴              단계         기간  표본   승률%   평균%   중앙%');
  for (const r of rows.filter((x) => x[2] === 10 && x[3] >= 30)) {
    console.log(`${r[0].padEnd(24)} ${r[1].padEnd(12)} ${String(r[2]).padStart(3)} ${String(r[3]).padStart(6)} ${r[4].toFixed(1).padStart(6)} ${r[5].toFixed(2).padStart(7)} ${r[6].toFixed(2).padStart(7)}`);
  }

  if (dry) {
    console.log('\n--dry: 저장하지 않았습니다.');
    return;
  }
  await exec(`delete from pattern_stats`);
  await bulkInsert(
    'pattern_stats',
    ['pattern', 'stage', 'horizon', 'n', 'win_rate', 'avg_ret', 'med_ret'],
    rows,
    `on conflict (pattern, stage, horizon) do update set
       n = excluded.n, win_rate = excluded.win_rate, avg_ret = excluded.avg_ret,
       med_ret = excluded.med_ret, updated_at = now()`,
  );
  console.log(`\n저장 ${rows.length}행 (pattern_stats)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
