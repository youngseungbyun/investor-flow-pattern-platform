import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, fmtCard, fmtForeignLine, fmtInsider, fmtMoney, fmtTitle } from '../src/domain/alertText';
import { DEFAULT_TIERS, starCount, starsFor } from '../src/domain/stars';

test('금액 표기: 억 · 만원', () => {
  assert.equal(fmtMoney(6_110_000_000), '61.1억');
  assert.equal(fmtMoney(-223_000_000_00), '223.0억');
  assert.equal(fmtMoney(29_940_000), '2,994만원');
  assert.equal(fmtMoney(1_234_500_000_00), '1,234.5억');
});

test('제목: 날짜·요일·종목 수', () => {
  assert.equal(fmtTitle('2026-10-16', 7), '📊 10/16(금) 장 마감 · 신호 7종목');
  assert.equal(fmtTitle('2026-10-13', 2), '📊 10/13(화) 장 마감 · 신호 2종목');
});

test('외국인 요약 줄', () => {
  assert.equal(fmtForeignLine(7, 0), '외국인은 7종목 모두 순매도');
  assert.equal(fmtForeignLine(0, 3), '외국인은 3종목 모두 순매수');
  assert.equal(fmtForeignLine(4, 3), '외국인 순매수 3 · 순매도 4종목');
  assert.equal(fmtForeignLine(0, 0), null);
});

test('별 개수: 기준 경계 · 사모 유통 대비 1.0% 가 별 3개', () => {
  const t = DEFAULT_TIERS.private_fund.float;
  assert.equal(starCount(0.44, t), 0);
  assert.equal(starCount(0.45, t), 1);
  assert.equal(starCount(0.7, t), 2);
  assert.equal(starCount(1.0, t), 3);
  assert.equal(starCount(-1.5, t), 0);
  // 유통 대비가 없으면 시총 대비로 판정
  assert.equal(starsFor('private_fund', DEFAULT_TIERS, null, 0.6), 2);
  assert.equal(starsFor('insider', DEFAULT_TIERS, null, 0.2), 2);
});

test('종목 카드: 들여쓰기·사모는 기관 안·항목 앞 아이콘 없음·뒤에 별', () => {
  const text = fmtCard({
    index: 0,
    name: '한양디지텍',
    close: 39100,
    changePct: 13.33,
    pattern: { icon: '🚩', label: '상승깃발 돌파' },
    institution: { amount: 6_110_000_000, pct: 2.52, basisLabel: '유통', stars: 2 },
    privateFund: { amount: 1_580_000_000, pct: 0.65, basisLabel: '유통', stars: 1 },
    foreign: { amount: -5_640_000_000, pct: -2.32, basisLabel: '유통', stars: 0 },
    individual: { amount: 4_250_000_000, pct: 1.1, basisLabel: '유통', stars: 0, warn: true },
    handbuy: { amount: 3_760_000_000, pct: 1.54, basisLabel: '유통', stars: 1 },
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '1️⃣ 한양디지텍 39,100 🔺13.3%');
  assert.equal(lines[1], '   🚩 상승깃발 돌파');
  assert.equal(lines[2], '   기관 ▲61.1억 (유통 2.52%) ⭐⭐');
  assert.equal(lines[3], '     └ 사모 ▲15.8억 (유통 0.65%) ⭐');
  assert.equal(lines[4], '   외국인 ▼56.4억 (유통 2.32%)');
  assert.equal(lines[5], '   개인 ▲42.5억 (유통 1.10%) ⚠️');
  assert.equal(lines[6], '   손매수 ▲37.6억 (유통 1.54%) ⭐');
});

test('임원 줄: 별 · 시총 대비', () => {
  const t = fmtInsider({ name: '뉴파워프라즈마', officer: '최대규', position: '회장', mmdd: '10/12', amount: 1_800_900_000, capPct: 0.31, stars: 2 });
  assert.equal(t, '   뉴파워프라즈마 최대규 회장 · 10/12\n   ▲18.0억 (시총 0.31%) ⭐⭐');
  const small = fmtInsider({ name: '현대건설', officer: '이한우', position: '부사장', mmdd: '10/14', amount: 29_940_000, capPct: 0.0003, stars: 0 });
  assert.match(small, /\(시총 0\.00%\)$/);
});

test('전체 조립: 구분선·접기·섹션', () => {
  const text = assemble({
    date: '2026-10-16',
    total: 3,
    foreignSell: 3,
    foreignBuy: 0,
    cards: ['1️⃣ A', '2️⃣ B'],
    folded: ['C'],
    handbuyLines: ['   D ▲1.0억'],
    insiderLines: [],
  });
  assert.match(text, /^📊 10\/16\(금\) 장 마감 · 신호 3종목\n외국인은 3종목 모두 순매도\n━+\n1️⃣ A\n─ ─/);
  assert.match(text, /외 1종목 · C/);
  assert.match(text, /✋ 손매수 상위 \(카드 밖\)/);
  assert.doesNotMatch(text, /임원/);
});
