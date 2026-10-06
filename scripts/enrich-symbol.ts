/**
 * 종목 하나만 골라 비어 있는 보강 데이터를 채운다.
 *
 *   npm run enrich -- 484120 [--year 2025]
 *
 * 하루 배치(`npm run batch -- dart` 등)는 거래대금 상위·스크리너 후보만 돌아서
 * 소형주는 유통주식수·임원 변동·지지선·프로그램매매가 비어 종목 화면이 반쪽으로 나온다.
 * 이 도구는 그 종목에 한해 같은 단계를 한 번씩 돌린다. 운영 DB 에 쓰려면
 * DATABASE_URL 을 운영 값으로 주고 실행한다(REMOTE_DATABASE_URL 을 그대로 넘기면 된다).
 */
import { query, pool, todayKst } from '../src/lib/core';
import { computeFreeFloat, syncInsiderReports, enrichPendingReports } from '../src/providers/dart';
import { loadBars } from '../src/domain/patterns';
import { saveLines, saveSignals, scanLines } from '../src/domain/lines';
import { exec } from '../src/lib/core';
import { fetchProgramDaily, saveProgramDaily, kisConfigured } from '../src/providers/kis';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const symbol = process.argv.slice(2).find((a) => /^\d{6}$/.test(a));
  if (!symbol) throw new Error('종목코드 6자리를 주세요. 예) npm run enrich -- 484120');

  const [inst] = await query<{ corp_code: string | null; name: string }>(
    `select corp_code, name from instruments where symbol = $1`,
    [symbol],
  );
  if (!inst) throw new Error(`instruments 에 ${symbol} 이 없습니다`);
  console.log(`${inst.name}(${symbol}) corp_code=${inst.corp_code ?? '없음'}`);

  if (inst.corp_code) {
    const year = arg('year') ?? String(Number(todayKst().slice(0, 4)) - 1);
    const n = await syncInsiderReports(inst.corp_code, symbol);
    console.log(`  임원 소유보고 ${n}건 적재`);
    const parsed = await enrichPendingReports(60);
    console.log(`  원문 파싱 ${parsed.parsed}건 → 거래내역 ${parsed.trades}건`);
    const ff = await computeFreeFloat(symbol, inst.corp_code, year);
    console.log(`  유통주식수 ${ff.basis} ${ff.free ?? '-'}`);
  } else {
    console.log('  corp_code 가 없어 공시 단계는 건너뜁니다');
  }

  // 화면이 읽는 기준일과 같은 값(완전한 최신 거래일)
  const [d] = await query<{ d: string | null }>(
    `select to_char(max(date), 'YYYY-MM-DD') d from support_lines`,
  );
  const [p] = await query<{ d: string | null }>(
    `select to_char(max(date), 'YYYY-MM-DD') d from pattern_hits`,
  );
  const date = p?.d ?? d?.d;
  if (date) {
    const bars = await loadBars(symbol, date);
    const res = scanLines(symbol, bars);
    await exec(`delete from line_signals where symbol = $1 and date = $2`, [symbol, date]);
    await exec(`delete from support_lines where symbol = $1 and date = $2`, [symbol, date]);
    const lines = await saveLines(symbol, date, res.lines);
    const sig = await saveSignals(res.signals, date);
    console.log(`  지지선 ${lines}개 · 시그널 ${sig}건 (기준일 ${date})`);
  }

  if (kisConfigured()) {
    const rows = await saveProgramDaily(await fetchProgramDaily(symbol, todayKst()));
    console.log(`  프로그램매매(일별) ${rows}행`);
  } else {
    console.log('  KIS 키가 없어 프로그램매매는 건너뜁니다');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
