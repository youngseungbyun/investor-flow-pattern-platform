/**
 * 알림 설정 화면(/alerts)용: 지금 돌고 있는 알림 조건과, 그 조건으로 만든 오늘 알림 미리보기.
 *
 * 조건의 원천은 이 사이트의 `src/data/alert-rules.json` 이다. 맥미니 알림 작업은 /api/alert-rules 의 defs 를 읽고,
 * 읽지 못할 때만 `orchestration-system/macmini/schedules/sd-rules.json`(폴백 사본)을 쓴다. 조건을 바꾸면 두 파일을 같이 고친다.
 * 신규 판정과 거르기는 맥미니 알림 작업(`sd-after-close.md` 3절)과 같은 순서를 따른다:
 *   신규 = 기준일 결과 − 직전 거래일 결과 → 같은 종목은 앞선 조건에만 → 당일 상승 마감 → 종가 ≥ 20일 이동평균.
 */
import { query } from '../lib/core';
import rulesJson from '../data/alert-rules.json';
import { buildAlert } from './alert';
import { fmtTitle } from './alertText';
import { FLOW_LABEL } from './handbuy';
import { STAGE_KO, type Stage } from './patterns';
import { runRule, type Rule } from './rules';

export interface AlertRuleDef {
  id: string;
  name: string;
  rule: Omit<Rule, 'date'>;
}

export const ALERT_RULES = rulesJson as unknown as AlertRuleDef[];

const MARKET_KO: Record<string, string> = { ALL: '전체 시장', KOSPI: 'KOSPI', KOSDAQ: 'KOSDAQ' };
const SORT_KO: Record<string, string> = { flow: '수급 강도순', score: '패턴 점수순', traded_value: '거래대금순' };
const amountText = (metric: string, v: number): string =>
  metric === 'float_pct' ? `유통주식수 대비 ${v}%` : metric === 'z_score' ? `${v}σ` : metric === 'amount' ? money(v)
  : metric === 'turnover_x' ? `거래대금 회전 ${v}배` : metric === 'streak' ? `${v}일 연속` : `${metric} ${v}`;

function money(v: number): string {
  return v >= 1e8 ? `${v / 1e8}억` : `${v.toLocaleString('ko-KR')}원`;
}

/** 조건 한 건을 사람이 읽는 줄들로 풀어 쓴다. */
export function describeRule(def: AlertRuleDef): string[] {
  const r = def.rule;
  const lines: string[] = [];
  const logic = r.flowLogic === 'OR' ? ' 또는 ' : ' 그리고 ';
  const flows = r.flow.map((f) => {
    const who = FLOW_LABEL[f.investorType] ?? f.investorType;
    const side = f.side === 'buy' ? '순매수' : '순매도';
    const how = f.agg === 'daily_max' ? '하루라도' : '기간 합계가';
    return `${who} ${side} ${amountText(f.metric, f.value)} ${f.op === '>=' ? '이상' : '이하'} · 최근 ${f.windowDays}거래일 중 ${how}`;
  });
  if (flows.length) lines.push(`수급 · ${flows.join(logic)}`);
  if (r.pattern) {
    const p = r.pattern;
    const parts = [
      p.directions?.length ? (p.directions.includes('bullish') && p.directions.length === 1 ? '상승형 패턴' : '패턴') : '패턴',
      p.stages?.length ? p.stages.map((s) => STAGE_KO[s as Stage] ?? s).join('·') : null,
      p.minScore ? `점수 ${p.minScore} 이상` : null,
      p.maxDistancePct ? `돌파선 거리 ${p.maxDistancePct}% 이내` : null,
    ].filter(Boolean);
    lines.push(`패턴 · ${parts.join(' · ')}`);
  }
  lines.push(`공통 · ${MARKET_KO[r.market] ?? r.market} · 거래대금 ${money(r.minTradedValue)} 이상 · ${SORT_KO[r.sortBy] ?? r.sortBy}`);
  return lines;
}

/** 알림 작업이 조건과 별개로 마지막에 거르는 기준(sd-after-close 3절). */
export const ALERT_FILTER_LINES = [
  '신규 · 직전 거래일에는 조건에 없다가 오늘 새로 걸린 종목만',
  '상승 마감 · 당일 등락률이 0보다 큰 종목만',
  '추세 · 종가가 20일 이동평균 이상인 종목만',
];

export interface PreviewRule {
  id: string;
  name: string;
  lines: string[];
  matched: number;
  fresh: number;
  kept: string[];
}

export interface AlertPreview {
  date: string;
  prev: string | null;
  rules: PreviewRule[];
  symbols: string[];
  text: string;
}

export async function alertPreview(date: string): Promise<AlertPreview> {
  const prevRows = await query<{ d: string }>(
    `select to_char(max(date),'YYYY-MM-DD') d from ohlcv_daily where symbol = '005930' and date < $1::date`,
    [date],
  );
  const prev = prevRows[0]?.d ?? null;

  const perRule = await Promise.all(
    ALERT_RULES.map(async (def) => {
      const today = await runRule({ ...def.rule, date });
      const before = prev ? await runRule({ ...def.rule, date: prev }) : { rows: [] as typeof today.rows };
      const had = new Set(before.rows.map((x) => x.symbol));
      return { def, matched: today.rows.length, fresh: today.rows.filter((x) => !had.has(x.symbol)) };
    }),
  );

  // 같은 종목은 앞선 조건에만 쓴다.
  const seen = new Set<string>();
  const candidates = perRule.map((p) => {
    const rows = p.fresh.filter((x) => {
      if (seen.has(x.symbol)) return false;
      seen.add(x.symbol);
      return true;
    });
    return { ...p, rows };
  });

  // 상승 마감 + 종가 ≥ 20일 이동평균
  const all = candidates.flatMap((c) => c.rows.filter((x) => (x.changePct ?? 0) > 0).map((x) => x.symbol));
  const ok = new Set<string>();
  if (all.length) {
    const ma = await query<{ symbol: string; last: string; n: string; c: string; ma: string }>(
      `with r as (
         select symbol, date, c::float8 c, row_number() over (partition by symbol order by date desc) rn
           from ohlcv_daily where symbol = any($1::text[]) and date <= $2::date and date > ($2::date - 60)
       )
       select symbol,
              to_char(max(date) filter (where rn = 1),'YYYY-MM-DD') last,
              (count(*) filter (where rn <= 20))::text n,
              (max(c) filter (where rn = 1))::text c,
              (avg(c) filter (where rn <= 20))::text ma
         from r group by symbol`,
      [all, date],
    );
    for (const m of ma) if (m.last === date && Number(m.n) >= 20 && Number(m.c) >= Number(m.ma)) ok.add(m.symbol);
  }

  const symbols: string[] = [];
  const rules: PreviewRule[] = candidates.map((c) => {
    const kept = c.rows.filter((x) => (x.changePct ?? 0) > 0 && ok.has(x.symbol));
    kept.forEach((x) => symbols.push(x.symbol));
    return {
      id: c.def.id,
      name: c.def.name,
      lines: describeRule(c.def),
      matched: c.matched,
      fresh: c.fresh.length,
      kept: kept.map((x) => x.name),
    };
  });

  let text: string;
  if (symbols.length === 0) {
    text = fmtTitle(date, 0).replace(/ · 신호 0종목$/, ' · 신규 신호 없음');
  } else {
    text = (await buildAlert(date, symbols, 5)).text;
  }
  return { date, prev, rules, symbols, text };
}
