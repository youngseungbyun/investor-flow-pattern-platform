import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from '../src/lib/pool';
import { overLimit, resetRateLimit } from '../src/lib/ratelimit';
import { tickSize } from '../src/domain/lines';
import { atr, detectAll, type Bar } from '../src/domain/patterns';

test('mapPool 은 순서를 지키고 동시 실행 수를 넘지 않는다', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapPool([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [10, 2, 8, 4, 6, 12, 14]);
  assert.ok(peak <= 3);
});

test('호출 제한: 한도를 넘으면 막고 창이 지나면 풀린다', () => {
  resetRateLimit();
  const req = new Request('http://x/api', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(overLimit(req, 5, 't', t0 + i), false);
  assert.equal(overLimit(req, 5, 't', t0 + 10), true);
  assert.equal(overLimit(req, 5, 't', t0 + 61_000), false);
  const other = new Request('http://x/api', { headers: { 'x-forwarded-for': '5.6.7.8' } });
  assert.equal(overLimit(other, 5, 't', t0 + 10), false);
});

test('호가 단위(원)', () => {
  assert.equal(tickSize(1500), 1);
  assert.equal(tickSize(60000), 100);
  assert.equal(tickSize(300000), 500);
});

function bars(n: number, f: (i: number) => number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, o: c, h: c * 1.01, l: c * 0.99, c, volume: 1000 };
  });
}

test('패턴 판정: 평평한 시세에서도 오류 없이 점수가 범위 안이다', () => {
  const hits = detectAll('000000', bars(220, () => 10000));
  for (const h of hits) assert.ok(h.score >= 0 && h.score <= 100);
});

test('ATR 은 양수이고 변동이 클수록 크다', () => {
  const calm = atr(bars(40, () => 100));
  const wild = atr(bars(40, (i) => 100 + (i % 2 ? 8 : -8)));
  assert.ok(calm > 0 && wild > calm);
});

import { decodeCsv, encodeCsv } from '../src/domain/archive';

test('일별 수급 압축 보관: 넣은 그대로 되돌아온다', () => {
  const buf = encodeCsv('symbol,investor_type,net_buy_qty,net_buy_amount', [
    ['005930', 'foreign', '-123', '-45600'],
    ['000660', 'individual', '7', null],
  ]);
  const rows = decodeCsv(buf);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { symbol: '005930', investor_type: 'foreign', net_buy_qty: '-123', net_buy_amount: '-45600' });
  assert.equal(rows[1].net_buy_amount, '');
});
