/**
 * 장 마감 알림 문구 조립(순수 함수). 모양은 대표 확정(2026-10-17):
 * 종목 이름 줄만 왼쪽 끝, 아래는 3칸 들여쓰기, 사모는 기관 안이라 한 칸 더 들여 "└". 항목 앞 아이콘 없이 뒤에 별만.
 */
export const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const THICK = '━━━━━━━━━━━━━━━━━━';
export const THIN = '─ ─ ─ ─ ─ ─ ─ ─ ─ ─';

const comma = (n: number, d = 0) => n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });

/** 원 → "61.1억" · 1억 미만이면 "2,994만원" */
export function fmtMoney(won: number): string {
  const abs = Math.abs(won);
  if (abs >= 1e8) return `${comma(abs / 1e8, 1)}억`;
  return `${comma(Math.round(abs / 1e4))}만원`;
}

export const arrow = (v: number) => (v >= 0 ? '▲' : '▼');

export interface FlowCell {
  amount: number; // 원
  pct: number | null; // 유통(또는 상장) 대비 %
  basisLabel: '유통' | '상장' | '시총';
  stars: number;
  warn?: boolean;
}

export function fmtFlowLine(label: string, c: FlowCell | null, indent: string): string | null {
  if (!c) return null;
  const pct = c.pct === null ? '' : ` (${c.basisLabel} ${comma(Math.abs(c.pct), 2)}%)`;
  const star = c.stars > 0 ? ` ${'⭐'.repeat(c.stars)}` : '';
  const warn = c.warn ? ' ⚠️' : '';
  return `${indent}${label} ${arrow(c.amount)}${fmtMoney(c.amount)}${pct}${star}${warn}`;
}

export interface CardInput {
  index: number; // 0 부터
  name: string;
  close: number;
  changePct: number | null;
  pattern: { icon: string; label: string } | null;
  institution: FlowCell | null;
  privateFund: FlowCell | null;
  foreign: FlowCell | null;
  individual: FlowCell | null;
  handbuy: FlowCell | null;
}

export function fmtCard(c: CardInput): string {
  const chg = c.changePct === null ? '' : ` ${c.changePct >= 0 ? '🔺' : '🔻'}${comma(Math.abs(c.changePct), 1)}%`;
  const lines: Array<string | null> = [
    `${NUM_EMOJI[c.index] ?? '▪️'} ${c.name} ${comma(c.close)}${chg}`,
    c.pattern ? `   ${c.pattern.icon} ${c.pattern.label}` : null,
    fmtFlowLine('기관', c.institution, '   '),
    fmtFlowLine('└ 사모', c.privateFund, '     '),
    fmtFlowLine('외국인', c.foreign, '   '),
    fmtFlowLine('개인', c.individual, '   '),
    fmtFlowLine('손매수', c.handbuy, '   '),
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

export function fmtTitle(date: string, total: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `📊 ${m}/${d}(${w}) 장 마감 · 신호 ${total}종목`;
}

export function fmtForeignLine(sell: number, buy: number): string | null {
  const n = sell + buy;
  if (n === 0) return null;
  if (sell === n) return `외국인은 ${n}종목 모두 순매도`;
  if (buy === n) return `외국인은 ${n}종목 모두 순매수`;
  return `외국인 순매수 ${buy} · 순매도 ${sell}종목`;
}

export interface InsiderLine {
  name: string;
  officer: string;
  position: string;
  mmdd: string;
  amount: number; // 원
  capPct: number;
  stars: number;
}

export function fmtInsider(r: InsiderLine): string {
  const cap = r.capPct < 0.005 ? '0.00' : comma(r.capPct, 2);
  const star = r.stars > 0 ? ` ${'⭐'.repeat(r.stars)}` : '';
  return `   ${r.name} ${r.officer} ${r.position} · ${r.mmdd}\n   ▲${fmtMoney(r.amount)} (시총 ${cap}%)${star}`;
}

export function assemble(p: {
  date: string;
  total: number;
  foreignSell: number;
  foreignBuy: number;
  cards: string[];
  folded: string[];
  handbuyLines: string[];
  insiderLines: string[];
}): string {
  const out: string[] = [fmtTitle(p.date, p.total)];
  const f = fmtForeignLine(p.foreignSell, p.foreignBuy);
  if (f) out.push(f);
  out.push(THICK);
  if (p.cards.length === 0) {
    out.push('신규 신호 종목이 없어요');
  } else {
    out.push(p.cards.join(`\n${THIN}\n`));
  }
  if (p.folded.length) out.push(THIN, `외 ${p.folded.length}종목 · ${p.folded.join(' · ')}`);
  if (p.handbuyLines.length) out.push(THICK, '✋ 손매수 상위 (카드 밖)', ...p.handbuyLines);
  if (p.insiderLines.length) out.push(THICK, '🧑‍💼 임원 장내매수 (최근 5거래일)', ...p.insiderLines);
  return out.join('\n');
}
