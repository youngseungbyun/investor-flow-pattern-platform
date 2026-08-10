/**
 * 배치 러너.
 *
 *   npx tsx scripts/run.ts ohlcv --days 260      일봉 백필
 *   npx tsx scripts/run.ts ohlcv --date 2026-08-05
 *   npx tsx scripts/run.ts all   --date 2026-08-05
 *
 * 모든 단계는 멱등이다. 같은 날짜로 두 번 돌려도 중복 행이 생기지 않는다.
 */
import { addDays, bulkInsert, candidateDays, errMessage, logStep, pool, query, todayKst } from '../src/lib/core';
import { ingestDay } from '../src/providers/ohlcv';
import {
  activeProviders,
  saveDaily,
  savePeriods,
  type InvestorFlowProvider,
  type InvestorType,
} from '../src/providers/investor-flow';
import { detectAll, loadBars, saveHits, type PatternHit } from '../src/domain/patterns';
import {
  availablePeriods,
  runScreener,
  runScreenerFromPeriod,
  type MarketFilter,
  type ScreenerParams,
  type ScreenerResult,
} from '../src/domain/screener';
import { exec } from '../src/lib/core';
import {
  computeFreeFloat,
  enrichPendingReports,
  syncCorpCodes,
  syncInsiderReports,
} from '../src/providers/dart';
import {
  fetchDailyBars,
  fetchProgramDaily,
  fetchProgramMinute,
  kisConfigured,
  saveProgramDaily,
  saveProgramMinute,
} from '../src/providers/kis';
import {
  configuredMinuteProviders,
  fetchMinuteDay,
  saveMinute,
  type MinuteInterval,
} from '../src/providers/minute';
import { computeFlowEvents } from '../src/domain/rules';
import { clearLineScan, saveLines, saveSignals, scanLines } from '../src/domain/lines';

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? dflt;
}

/**
 * DATA.go.kr 이 아직 안 올린 날짜를 KIS 일봉으로 메운다.
 *
 * 금융위 시세는 T+1 이라 장이 끝나도 당일·전일이 비어 있는 시간대가 길다.
 * KIS 는 마감 직후 바로 주므로 그 공백만 채운다. 전 종목이 아니라
 * 이미 우리가 보고 있는 유니버스(거래대금 상위)만 대상으로 한다.
 */
async function stepOhlcvKis(dateIso: string, days: number) {
  console.log(`[batch] cmd=ohlcv-kis 기준일=${dateIso} 대상일수=${days}`);
  const from = addDays(dateIso, -Math.max(days, 1) * 2);

  // 이미 채워진 날짜는 건너뛴다.
  const have = new Set(
    (
      await query<{ d: string }>(
        `select to_char(date,'YYYY-MM-DD') d from ohlcv_daily
          where date between $1 and $2 group by date having count(*) > 100`,
        [from, dateIso],
      )
    ).map((r) => r.d),
  );

  const lastFilled =
    (await query<{ d: string }>(`select to_char(max(date),'YYYY-MM-DD') d from ohlcv_daily`))[0]?.d ?? dateIso;
  const { symbols } = await universe(lastFilled);
  if (symbols.length === 0) {
    console.log('  유니버스가 비어 있습니다. 먼저 ohlcv 를 한 번 받아 주세요.');
    return;
  }
  console.log(`  대상 ${symbols.length}종목(${lastFilled} 거래대금 상위) · 이미 있는 날짜 ${[...have].join(', ') || '없음'}`);

  // 장이 끝나지 않은 세션의 봉은 받으면 안 된다. KIS 는 개장 전에도 당일 행을
  // 내주는데 거래량 0 의 빈 봉이라, 넣으면 패턴·지지선 판정이 통째로 오염된다.
  const nowKst = new Date(Date.now() + (new Date().getTimezoneOffset() + 540) * 60_000);
  const todayIso = nowKst.toISOString().slice(0, 10);
  const closed = nowKst.getHours() * 60 + nowKst.getMinutes() >= 15 * 60 + 40;
  const acceptable = (d: string) => d < todayIso || (d === todayIso && closed);

  const rows: Array<[string, string, number, number, number, number, number, number]> = [];
  const dateSet = new Set<string>();
  let done = 0;

  for (const symbol of symbols) {
    try {
      const bars = await fetchDailyBars(symbol, from, dateIso);
      for (const b of bars) {
        if (have.has(b.date)) continue;
        if (!acceptable(b.date)) continue;
        // 거래량 0 은 휴장·미체결이거나 아직 안 끝난 세션이다.
        if (!(b.volume > 0)) continue;
        dateSet.add(b.date);
        rows.push([symbol, b.date, b.o, b.h, b.l, b.c, b.volume, b.tradedValue]);
      }
    } catch {
      // 개별 종목 실패는 건너뛴다. 총계는 아래 로그로 확인한다.
    }
    if (++done % 100 === 0) console.log(`  ${done}/${symbols.length}종목 · 누적 ${rows.length}행`);
  }

  if (rows.length === 0) {
    console.log('  채울 일봉이 없습니다(이미 있거나 KIS 에도 없음).');
    return;
  }

  const n = await bulkInsert(
    'ohlcv_daily',
    ['symbol', 'date', 'o', 'h', 'l', 'c', 'volume', 'traded_value'],
    rows,
    `on conflict (symbol, date) do update set
       o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
       volume = excluded.volume, traded_value = excluded.traded_value`,
  );
  // 캘린더도 같이 채워야 조건 검색의 거래일 창이 맞는다.
  for (const d of dateSet) {
    await exec(
      `insert into trading_days (date, is_open) values ($1, true)
       on conflict (date) do update set is_open = true`,
      [d],
    );
  }
  console.log(`KIS 일봉 보강 완료 — ${n}행 / 날짜 ${[...dateSet].sort().join(', ')}`);
}

async function stepOhlcv(dates: string[]) {
  let open = 0;
  let closed = 0;
  let pending = 0;
  let rows = 0;
  for (const date of dates) {
    try {
      const r = await ingestDay(date);
      if (r.isOpen === true) {
        open++;
        rows += r.quotes;
        console.log(`  ${date}  개장  종목 ${r.quotes}`);
        await logStep(date, 'ohlcv', 'ok', r.quotes, null, 'datagokr');
      } else if (r.isOpen === false) {
        closed++;
        console.log(`  ${date}  휴장`);
        await logStep(date, 'ohlcv', 'skipped', 0, null, 'datagokr');
      } else {
        pending++;
        console.log(`  ${date}  보류 — DATA.go.kr 미공시 (당일 시세는 보통 다음 영업일 오전에 올라옵니다)`);
        await logStep(date, 'ohlcv', 'pending', 0, 'DATA.go.kr 미공시', 'datagokr');
      }
    } catch (e) {
      console.log(`  ${date}  실패: ${errMessage(e)}`);
      await logStep(date, 'ohlcv', 'failed', 0, errMessage(e), 'datagokr');
    }
  }
  console.log(`일봉 수집 완료 — 개장 ${open}일 / 휴장 ${closed}일 / 보류 ${pending}일 / 총 ${rows}행`);
}

/**
 * 관찰 대상 종목(유니버스).
 * 전 종목 × 종목당 1요청은 하루 배치로 감당이 안 되므로 거래대금으로 자른다.
 * 잘라낸 사실을 조용히 숨기지 않고 항상 콘솔·batch_runs 에 남긴다.
 */
async function universe(date: string): Promise<{ symbols: string[]; total: number; minTv: number; cap: number }> {
  const minTv = Number(process.env.FLOW_MIN_TRADED_VALUE ?? 1_000_000_000);
  const cap = Number(process.env.FLOW_UNIVERSE ?? 1200);
  const total = Number(
    (await query<{ n: string }>(`select count(*) n from ohlcv_daily where date = $1`, [date]))[0]?.n ?? 0,
  );
  const rows = await query<{ symbol: string }>(
    `select symbol from ohlcv_daily
      where date = $1 and traded_value >= $2
      order by traded_value desc
      limit $3`,
    [date, minTv, cap],
  );
  return { symbols: rows.map((r) => r.symbol), total, minTv, cap };
}

async function stepFlow(date: string, lookbackDays: number) {
  const providers = await activeProviders();
  if (providers.length === 0) {
    console.log('  쓸 수 있는 수급 provider 가 없습니다. INVESTOR_FLOW_PROVIDER 를 확인하세요.');
    await logStep(date, 'investor_flow', 'failed', 0, 'no active provider', null);
    return;
  }
  const u = await universe(date);
  console.log(
    `  유니버스: ${u.symbols.length}종목 (전체 ${u.total} 중 거래대금 ${(u.minTv / 1e8).toFixed(0)}억 이상 상위 ${u.cap})`,
  );
  if (u.symbols.length === 0) {
    await logStep(date, 'investor_flow', 'pending', 0, `${date} 일봉이 아직 없습니다`, null);
    return;
  }

  const from = addDays(date, -lookbackDays);
  let saved = 0;
  const used: string[] = [];

  for (const p of providers as InvestorFlowProvider[]) {
    try {
      if (p.fetchPeriods) {
        const rows = await p.fetchPeriods();
        const n = await savePeriods(rows, p.id);
        if (n) console.log(`  [${p.id}] 기간합계 ${n}행`);
        saved += n;
      }
      if (p.fetchDaily) {
        // 종목당 1요청인 provider(kis 등)는 전량을 메모리에 모은 뒤 저장하면
        // 진행이 안 보이고 중간에 끊기면 통째로 날아간다. 청크 단위로 바로 저장한다.
        const CHUNK = Number(process.env.FLOW_CHUNK ?? 40);
        let n = 0;
        for (let i = 0; i < u.symbols.length; i += CHUNK) {
          const part = u.symbols.slice(i, i + CHUNK);
          const rows = await p.fetchDaily(part, from, date);
          n += await saveDaily(rows, p.id);
          console.log(`  [${p.id}] ${Math.min(i + CHUNK, u.symbols.length)}/${u.symbols.length}종목 · 누적 ${n}행`);
        }
        console.log(`  [${p.id}] 일별 ${n}행 (${from} ~ ${date})`);
        saved += n;
      }
      used.push(p.id);
    } catch (e) {
      console.log(`  [${p.id}] 실패: ${errMessage(e)}`);
    }
  }

  await logStep(
    date,
    'investor_flow',
    saved > 0 ? 'ok' : 'partial',
    saved,
    `universe=${u.symbols.length}/${u.total}`,
    used.join(','),
  );
  console.log(`수급 수집 완료 — ${saved}행, provider=${used.join(',') || '(없음)'}`);
}

async function stepPatterns(date: string) {
  const u = await universe(date);
  console.log(`  패턴 스캔 대상 ${u.symbols.length}종목 (거래대금 상위, 전체 ${u.total})`);
  let scanned = 0;
  let hits: PatternHit[] = [];
  for (const symbol of u.symbols) {
    const bars = await loadBars(symbol, date);
    const found = detectAll(symbol, bars);
    if (found.length) hits = hits.concat(found);
    if (++scanned % 200 === 0) console.log(`    ${scanned}/${u.symbols.length} 스캔, 후보 ${hits.length}`);
  }
  // 같은 날짜로 다시 돌리면 이전 결과를 지우고 새로 넣어 중복·잔재를 막는다.
  await exec(`delete from pattern_hits where date = $1`, [date]);
  const saved = await saveHits(hits, date);
  const confirmed = hits.filter((h) => h.confirmed).length;
  console.log(`패턴 스캔 완료 — 후보 ${saved}건 (확정 돌파 ${confirmed}건)`);
  await logStep(date, 'patterns', 'ok', saved, `confirmed=${confirmed}`, 'internal');
}

/**
 * step ③④ — OpenDART.
 * 전 종목에 다 돌리면 API 호출이 수천 건이라 하루 배치에 안 들어간다.
 * 스크리너 후보 + 거래대금 상위로 좁히고, 좁힌 사실을 콘솔에 남긴다.
 */
async function stepDart(date: string) {
  const limit = Number(arg('dartLimit') ?? 120);
  const year = arg('bsnsYear') ?? String(Number(date.slice(0, 4)) - 1);

  console.log('  corp_code 매핑 동기화...');
  const mapped = await syncCorpCodes();
  console.log(`  corp_code 갱신 ${mapped}종목`);

  // 대상: 최근 스크리너 후보(기간·일별 모두) 우선, 부족하면 거래대금 상위로 채움
  const targets = await query<{ symbol: string; corp_code: string }>(
    `with cand as (
       select p.symbol
         from investor_flow_period p
        where p.investor_type = 'private_fund' and p.net_buy_qty > 0
        union
       select o.symbol from ohlcv_daily o where o.date = $1 order by 1
     )
     select i.symbol, i.corp_code
       from instruments i
       join cand on cand.symbol = i.symbol
       join ohlcv_daily o on o.symbol = i.symbol and o.date = $1
      where i.corp_code is not null
      order by o.traded_value desc
      limit $2`,
    [date, limit],
  );
  console.log(`  대상 ${targets.length}종목 (상한 --dartLimit=${limit})`);

  let reports = 0;
  let computed = 0;
  let listedBasis = 0;
  for (const t of targets) {
    try {
      reports += await syncInsiderReports(t.corp_code, t.symbol);
    } catch (e) {
      console.log(`    [${t.symbol}] elestock 실패: ${errMessage(e)}`);
    }
    try {
      const r = await computeFreeFloat(t.symbol, t.corp_code, year);
      if (r.basis === 'computed') computed++;
      else listedBasis++;
    } catch {
      listedBasis++;
    }
  }
  const enriched = await enrichPendingReports(Number(arg('detailLimit') ?? 80));
  console.log(
    `  보고서 ${reports}건 적재 · 원문 파싱 ${enriched.parsed}건 → 거래내역 ${enriched.trades}건`,
  );
  console.log(`  유통주식수 실계산 ${computed}종목 / 상장주식수 대체 ${listedBasis}종목`);
  await logStep(date, 'dart', 'ok', reports + enriched.trades, `computed=${computed}`, 'opendart');
}

/**
 * 분봉 + 분봉 프로그램매매 수집.
 * 종목당 요청이 많아(분봉 1종목 = 최대 14콜) 대상은 --symbols 로 좁히거나
 * 유니버스 상위 --limit 개만 돈다. 잘라낸 사실은 콘솔에 남긴다.
 */
async function stepMinute(date: string) {
  const explicit = arg('symbols')?.split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Number(arg('limit') ?? 10);
  const interval = (arg('interval') ?? '1m') as MinuteInterval;
  const u = await universe(date);
  const symbols = explicit ?? u.symbols.slice(0, limit);
  const providers = configuredMinuteProviders();

  console.log(
    `  분봉 대상 ${symbols.length}종목 · 간격 ${interval}` +
      (explicit ? ' (--symbols 지정)' : ` (거래대금 상위 ${limit}, 유니버스 ${u.symbols.length} 중)`),
  );
  console.log(`  provider 순서: ${providers.map((p) => p.id).join(' → ') || '없음'}`);
  if (providers.length === 0) {
    await logStep(date, 'minute', 'skipped', 0, 'provider 없음', null);
    return;
  }

  let bars = 0;
  let pgm = 0;
  const usedProviders = new Set<string>();
  const allNotes = new Set<string>();

  for (const symbol of symbols) {
    try {
      const r = await fetchMinuteDay(symbol, date, interval, todayKst());
      r.notes.forEach((n) => allNotes.add(n));
      if (r.bars.length === 0) {
        console.log(`    ${symbol} · 분봉 없음 (${r.notes.join(' / ') || '사유 없음'})`);
        continue;
      }
      bars += await saveMinute(r.bars);
      if (r.provider) usedProviders.add(r.provider);

      // 프로그램매매 분봉은 KIS 전용이고 "최근 세션"만 준다.
      // 분봉과 같은 세션 날짜에 찍어야 시각이 어긋나지 않는다.
      if (kisConfigured() && r.sessionDates.length > 0) {
        const sessionDate = r.sessionDates[r.sessionDates.length - 1];
        if (dayDiffFromToday(sessionDate) <= 1) {
          pgm += await saveProgramMinute(await fetchProgramMinute(symbol, sessionDate));
        }
      }
      console.log(`    ${symbol} · ${r.provider} · 누적 분봉 ${bars} / 프로그램 ${pgm}`);
    } catch (e) {
      console.log(`    ${symbol} 실패: ${errMessage(e)}`);
    }
  }

  allNotes.forEach((n) => console.log(`  · ${n}`));
  console.log(`분봉 수집 완료 — 분봉 ${bars}행 / 분봉 프로그램 ${pgm}행`);
  await logStep(
    date,
    'minute',
    bars > 0 ? 'ok' : 'partial',
    bars + pgm,
    `symbols=${symbols.length} interval=${interval}`,
    [...usedProviders].join(',') || null,
  );
}

const dayDiffFromToday = (iso: string) =>
  Math.round((Date.parse(`${todayKst()}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);

/** 종목별 프로그램매매(일별). 한 번 호출에 30영업일이 온다. */
async function stepProgram(date: string) {
  if (!kisConfigured()) {
    console.log('  KIS_APP_KEY / KIS_APP_SECRET 가 없어 프로그램매매를 수집할 수 없습니다.');
    await logStep(date, 'program', 'skipped', 0, 'KIS 미설정', 'kis');
    return;
  }
  const u = await universe(date);
  const limit = Number(arg('limit') ?? u.symbols.length);
  const symbols = u.symbols.slice(0, limit);
  console.log(`  프로그램매매(일별) 대상 ${symbols.length}종목 (유니버스 ${u.symbols.length})`);

  let saved = 0;
  let done = 0;
  for (const symbol of symbols) {
    try {
      saved += await saveProgramDaily(await fetchProgramDaily(symbol, date));
    } catch {
      /* 개별 실패는 건너뛴다 */
    }
    if (++done % 40 === 0) console.log(`    ${done}/${symbols.length} · 누적 ${saved}행`);
  }
  console.log(`프로그램매매 수집 완료 — ${saved}행`);
  await logStep(date, 'program', saved > 0 ? 'ok' : 'partial', saved, `symbols=${symbols.length}`, 'kis');
}

/** step ⑤ — 수급을 유통주식수 대비 %·평소 거래대금 대비 배수로 정규화 */
async function stepFlowEvents(date: string, lookbackDays: number) {
  const from = addDays(date, -lookbackDays);
  const n = await computeFlowEvents(from, date);
  console.log(`수급 이벤트 정규화 완료 — ${from} ~ ${date} 구간 ${n}행`);
  await logStep(date, 'flow_events', 'ok', n, null, 'internal');
}

/** step ⑦ — 라인분석 (변곡점 지지선 · 거래량 돌파 눌림목 · 이평 지지) */
async function stepLines(date: string) {
  const u = await universe(date);
  console.log(`  라인 스캔 대상 ${u.symbols.length}종목 (거래대금 상위, 전체 ${u.total})`);
  await clearLineScan(date);

  let lineCount = 0;
  let signalCount = 0;
  let scanned = 0;
  for (const symbol of u.symbols) {
    const bars = await loadBars(symbol, date);
    const res = scanLines(symbol, bars);
    lineCount += await saveLines(symbol, date, res.lines);
    signalCount += await saveSignals(res.signals, date);
    if (++scanned % 200 === 0) console.log(`    ${scanned}/${u.symbols.length} 스캔`);
  }
  console.log(`라인 스캔 완료 — 지지선 ${lineCount}개 / 시그널 ${signalCount}건`);
  await logStep(date, 'lines', 'ok', signalCount, `lines=${lineCount}`, 'internal');
}

function paramsFrom(date: string, n: number, buyerType: InvestorType): ScreenerParams {
  return {
    date,
    n,
    market: (arg('market') ?? 'ALL') as MarketFilter,
    minTradedValue: Number(arg('minTradedValue') ?? 1_000_000_000),
    buyerType,
    limit: Number(arg('limit') ?? 100),
  };
}

async function saveSnapshot(result: ScreenerResult) {
  const hash = Buffer.from(
    JSON.stringify({ ...result.params, mode: result.mode, window: result.windowDates }),
  )
    .toString('base64url')
    .slice(0, 40);
  await exec(
    `insert into screener_snapshots (date, params_hash, params_json, rows_json, row_count)
     values ($1,$2,$3,$4,$5)
     on conflict (date, params_hash) do update set
       params_json = excluded.params_json,
       rows_json = excluded.rows_json,
       row_count = excluded.row_count,
       created_at = now()`,
    [
      result.params.date,
      hash,
      JSON.stringify({ ...result.params, mode: result.mode, windowDates: result.windowDates }),
      JSON.stringify(result.rows),
      result.rows.length,
    ],
  );
}

async function stepScreener(date: string, n: number) {
  const buyerType = (arg('buyerType') ?? 'private_fund') as InvestorType;

  const daily = await runScreener(paramsFrom(date, n, buyerType));
  console.log(`  [daily] ${daily.rows.length}건  기간=${daily.windowDates.at(-1)}~${daily.windowDates[0]}`);
  daily.notes.forEach((x) => console.log(`    · ${x}`));
  await saveSnapshot(daily);

  // CSV 기간합계가 있으면 그 기간으로도 한 번 더 돌린다.
  const periods = await availablePeriods();
  for (const p of periods.filter((x) => x.investorType === buyerType)) {
    const res = await runScreenerFromPeriod(paramsFrom(p.end, n, buyerType), p.start, p.end);
    console.log(`  [period ${p.start}~${p.end}] ${res.rows.length}건`);
    await saveSnapshot(res);
  }

  const total = daily.rows.length;
  await logStep(date, 'screener', 'ok', total, `periods=${periods.length}`, 'internal');
}

async function stepVerify(date: string) {
  const n = Number(arg('n') ?? 5);
  const buyerType = (arg('buyerType') ?? 'private_fund') as InvestorType;
  const periods = await availablePeriods();

  console.log('\n=== 완료기준 3 · 스크리너 실결과 검증 ===');
  for (const p of periods.filter((x) => x.investorType === buyerType)) {
    const res = await runScreenerFromPeriod(paramsFrom(p.end, n, buyerType), p.start, p.end);
    console.log(`\n[기간 ${p.start} ~ ${p.end}] 조건충족 ${res.rows.length}종목`);
    console.log(res.notes.map((x) => `  · ${x}`).join('\n'));
    console.log(
      '  ' +
        ['종목', '개인순매수', `${res.rows[0]?.buyerLabel ?? ''}순매수`, '유통주식수', '비율%', '기준'].join(
          ' | ',
        ),
    );
    for (const r of res.rows.slice(0, 10)) {
      console.log(
        `  ${r.name}(${r.symbol}) | ${r.individualNetQty.toLocaleString()} | ${r.buyerNetQty.toLocaleString()} | ` +
          `${r.floatShares?.toLocaleString() ?? '-'} | ${r.ratioPct?.toFixed(4) ?? '-'} | ` +
          `${r.floatBasis === 'computed' ? '유통주식수' : '상장주식수 기준'}`,
      );
    }
    const ratios = res.rows.map((r) => r.ratioPct ?? 0);
    const sorted = ratios.every((v, i) => i === 0 || ratios[i - 1] >= v);
    console.log(`  정렬 내림차순 확인(완료기준 4): ${sorted ? 'OK' : '실패'}`);
    const condOk = res.rows.every((r) => r.individualNetQty < 0 && r.buyerNetQty > 0);
    console.log(`  조건 A(개인<0)·B(${buyerType}>0) 전건 충족: ${condOk ? 'OK' : '실패'}`);
  }

  const daily = await runScreener(paramsFrom(date, n, buyerType));
  console.log(`\n[일별 ${n}거래일] ${daily.rows.length}종목`);
  daily.notes.forEach((x) => console.log(`  · ${x}`));
}

async function main() {
  const cmd = process.argv[2] ?? 'all';
  const date = arg('date') ?? todayKst();
  const days = Number(arg('days') ?? '1');
  const dates = days > 1 ? candidateDays(date, days).reverse() : [date];

  console.log(`[batch] cmd=${cmd} 기준일=${date} 대상일수=${dates.length}`);

  const lookback = Number(arg('lookback') ?? '30');

  switch (cmd) {
    case 'ohlcv':
      await stepOhlcv(dates);
      break;
    case 'ohlcv-kis':
      await stepOhlcvKis(date, Number(arg('days') ?? 5));
      break;
    case 'flow':
      await stepFlow(date, lookback);
      break;
    case 'dart':
      await stepDart(date);
      break;
    case 'patterns':
      await stepPatterns(date);
      break;
    case 'minute':
      await stepMinute(date);
      break;
    case 'program':
      await stepProgram(date);
      break;
    case 'flow-events':
      await stepFlowEvents(date, lookback);
      break;
    case 'lines':
      await stepLines(date);
      break;
    case 'screener':
      await stepScreener(date, Number(arg('n') ?? 5));
      break;
    case 'verify':
      await stepVerify(date);
      break;
    case 'all':
      await stepOhlcv(dates);
      await stepFlow(date, lookback);
      await stepDart(date);
      await stepPatterns(date);
      await stepFlowEvents(date, lookback);
      await stepLines(date);
      await stepScreener(date, Number(arg('n') ?? 5));
      break;
    default:
      console.error(`알 수 없는 명령: ${cmd}`);
      process.exitCode = 1;
  }

  await pool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
