import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOfficerOfInterest, isOpenMarketBuy, parseReportXml } from '../src/providers/dart';

const xml = readFileSync(new URL('./fixtures/elestock-detail.xml', import.meta.url), 'utf8');

test('세부변동내역의 TU 칸(방법·변동일)까지 읽어 거래내역을 만든다', () => {
  const rows = parseReportXml(xml);
  // 2026-10-11 버그: 방법·변동일 칸이 TU 태그라 읽지 못해 항상 0건이었다.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { tradeDate: '2026-10-07', officer: null, method: '장내매수(+)', qty: 2549, unitPrice: 274235 });
  assert.equal(rows[1].tradeDate, '2026-10-08');
  assert.equal(rows[1].qty, -100);
});

test('요약 표와 합계 행은 거래로 세지 않는다', () => {
  assert.equal(parseReportXml('<TR><TD>직전보고서</TD><TD>1</TD><TD>2</TD><TD>3</TD><TD>4</TD></TR>').length, 0);
  assert.equal(parseReportXml('').length, 0);
});

test('옛 서식(TD 만 쓰는 표)도 읽는다', () => {
  const old = '<TR><TD>장내매수(+)</TD><TD>2026-09-01</TD><TD>보통주</TD><TD>100</TD><TD>50</TD><TD>150</TD><TD>1,000</TD><TD>-</TD></TR>';
  const rows = parseReportXml(old);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 50);
});

test('장내매수 판별', () => {
  assert.equal(isOpenMarketBuy('장내매수(+)'), true);
  assert.equal(isOpenMarketBuy('장내매도(-)'), false);
  assert.equal(isOpenMarketBuy('유상신주취득(+)'), false);
  assert.equal(isOpenMarketBuy(''), false);
});

test('관심 임원 판별', () => {
  assert.equal(isOfficerOfInterest('대표이사', '등기임원'), true);
  assert.equal(isOfficerOfInterest('상무', '비등기임원'), false);
  assert.equal(isOfficerOfInterest('사내이사', '등기임원'), true);
});
