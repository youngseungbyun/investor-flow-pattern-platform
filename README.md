# 수급·패턴 분석 플랫폼

장 마감 후 배치로 데이터를 모아 세 갈래로 분석한다.

| 탭 | 하는 일 |
|---|---|
| **수급분석** | 투자자 12구분 × 지표 × 임계값 × 패턴 위치를 조합한 **조건 빌더**로 종목을 뽑는다 |
| **패턴분석** | 상승 8 / 하락 6 / 중립 2, 총 **16종 패턴**과 현재 단계(넥라인 부근·돌파·눌림목)를 보여준다 |
| **라인분석** | 변곡점 지지선, 거래량 돌파 후 눌림목, 3·5일선 지지를 리스트업한다 |

대표 조건 예시는 이렇게 표현된다.

> 사모펀드가 하루에 유통주식수의 1% 이상 순매수한 날이 역헤드앤숄더 또는 컵앤핸들 패턴 기간 안에 있고,
> 지금은 넥라인 부근이거나 돌파 후 눌림목인 종목

---

## 데이터 소스 현황 (2026-08 기준 실측)

| 데이터 | 소스 | 상태 |
|---|---|---|
| **투자자별 12구분(사모 포함) 일별** | **한국투자증권 KIS Open API** `FHPTJ04160001` | **정상. 796종목 검증 완료** |
| 일봉 OHLCV·거래대금·상장주식수·시총 | DATA.go.kr 금융위원회 주식시세정보 | 정상. 2,872종목/일 (전종목 하루치를 1콜) |
| 분봉 | KIS `FHKST03010200` | 정상. 단, **최근 세션만** 반환 |
| 프로그램매매(일별) | KIS `FHPPG04650201` | 정상. 30영업일/콜 |
| 프로그램매매(분) | KIS `FHPPG04650101` | 최근 수분치 스냅샷만 |
| 거래원별(증권사 창구) | KIS `FHPST04540000` | 회원사코드별 1건씩 조회 |
| 내부자(임원) 소유상황 보고 | OpenDART `elestock.json` + `document.xml` | 정상 |
| corp_code ↔ 종목코드 | OpenDART `corpCode.xml` | 정상. 2,846종목 매핑 |
| 최대주주등·자기주식 | OpenDART `hyslrSttus` / `tesstkAcqsDspsSttus` | 정상 |
| 개인·외국인·기관합계 (폴백) | 네이버 증권 모바일 API | 정상. 무료·무로그인 |
| 차트 시세 공급 | 자체 UDF 서버 `/api/udf/*` | 정상 |

### KIS 가 KRX CSV 를 대체했다

원래 사모 세분은 KRX Data Marketplace 뿐이라고 알려져 있었고, 실제로 `data.krx.co.kr` 통계 화면은
회원 전용으로 바뀌어 비로그인 `POST /comm/bldAttendant/getJsonData.cmd` 가 `400 LOGOUT` 을 돌려준다.

그런데 KIS 의 **종목별 투자자매매동향(일별)** `FHPTJ04160001` 이 `pe_fund_ntby_vol`(사모)를 포함한
**투자자 12구분을 일별로 전부** 준다. 한 번 호출에 30영업일치가 온다.

정확도 검증 (2026-08-07):

| 항목 | KIS | 대조 기준 | 판정 |
|---|---|---|---|
| 파마리서치(214450) 사모 순매수 2026-07-27~29 합 | 365,977 | 365,977 (KRX CSV 원본) | 일치 |
| 같은 종목·기간 개인 순매수 합 | −244,245 | −244,245 (네이버) | 일치 |

그래서 기본 provider 는 `kis` 다. `krx-csv` / `krx-marketplace` 는 폴백으로 남겨 두었다.

> **KIS 계정 종류에 따른 차이**
> 모의(`openapivts…:29443`)는 **초당 2건**, 실전(`openapi…:9443`)은 초당 20건이다.
> 796종목 수급 수집이 모의로 약 45분, 실전으로 약 5분 걸린다.
> **과거 일별 데이터는 모의에서도 실데이터**지만, **당일 장중 시세는 모의 서버 값**이라
> 실시간 분봉·프로그램매매를 쓰려면 실전 계정이 필요하다.

> ## ⚠️ KRX Data Marketplace 를 쓸 경우에만 해당
>
> `krx-csv` / `krx-marketplace` provider 로 되돌린다면, 상용 배포 전 KRX Data Marketplace
> 이용 계약이 필요하다. 어느 provider 든 **수집한 원본은 재배포하지 않고 파생 지표(비율·순위)만 노출**한다.
> 요청 간격은 `REQUEST_INTERVAL_MS`(기본 1000ms) 미만으로 낮추지 말 것.

`openapi.krx.co.kr`(KRX OPEN API)에는 투자자별 데이터가 없다. `data.krx.co.kr` 과는 다른 서비스다.

---

## 빠른 시작

```bash
npm install
cp .env.example .env.local     # DATA_GO_KR_API_KEY, OPEN_DART_API_KEY 채우기
npm run db:server              # 로컬 PostgreSQL(PGlite 소켓 서버). 별도 터미널에서 계속 띄워둔다
npm run db:migrate
npm run batch -- ohlcv --date 2026-08-05 --days 220
npm run batch -- all   --date 2026-08-05
npm run dev                    # http://localhost:3000
```

### DB

기본값은 **PGlite 소켓 서버**다. PostgreSQL 18 을 Docker나 관리자 권한 없이 로컬에서 그대로 쓴다.
데이터 디렉터리는 OneDrive 밖(`%LOCALAPPDATA%\supply-demand-dashboard\pgdata`)에 둔다. 동기화 충돌을 피하기 위해서다.
접속은 표준 `pg` 드라이버라 **`DATABASE_URL` 한 줄만 바꾸면 Supabase나 원격 Postgres로 그대로 옮겨간다.**
마이그레이션 SQL은 순수 PostgreSQL이라 수정 없이 재사용된다.

---

## 배치 파이프라인

한국 시장 마감(15:30 KST) 이후 실행한다. 모든 단계는 **멱등**이다.

| 시각 | 단계 | 명령 | 하는 일 |
|---|---|---|---|
| 18:00 | ① 일봉 | `batch -- ohlcv` | DATA.go.kr 일봉·거래대금·상장주식수. 거래일 캘린더 확정 |
| 18:10 | ② 수급 | `batch -- flow` | `InvestorFlowProvider`(기본 kis)로 투자자 12구분. 40종목씩 나눠 저장 |
| 18:30 | ③④ 공시 | `batch -- dart` | 내부자 보고서 수집·원문 파싱, 유통주식수 계산 |
| 18:40 | ⑤ 패턴 | `batch -- patterns` | 전 종목 16패턴 스캔 + 단계(stage) 판정 |
| 18:50 | ⑥ 수급 정규화 | `batch -- flow-events` | 유통주식수 대비 %·평소 거래대금 대비 배수 계산 → `flow_events` |
| 18:55 | ⑦ 라인 | `batch -- lines` | 변곡점 지지선 · 거래량 돌파 눌림목 · 이평 지지 |
| 19:00 | ⑧ 스냅샷 | `batch -- screener` | 스크리너 조건 평가 후 스냅샷 확정 |
| 수시 | 프로그램매매 | `batch -- program --limit 200` | 종목별 프로그램매매 일별 30영업일 |
| 장중 | 분봉 | `batch -- minute --symbols 005930,000660` | 분봉 + 분봉 프로그램매매 (최근 세션만) |

`batch -- all` 은 ①~⑧을 순서대로 돈다. `program`·`minute` 는 요청량이 많아 별도로 돌린다. 주말·공휴일은 일봉이 비어 있으면 `trading_days.is_open=false` 로 기록하고 건너뛴다.
각 단계의 성공/실패와 건수는 `batch_runs` 에 남고, 대시보드 상단에 **"마지막 갱신: YYYY-MM-DD HH:mm · 정상/일부실패"** 로 표시된다.

### 관찰 대상(유니버스) 상한

전 종목 × 종목당 1요청은 하루 배치에 들어가지 않는다. 그래서 수급·패턴 단계는
`FLOW_MIN_TRADED_VALUE`(기본 10억) 이상 종목 중 거래대금 상위 `FLOW_UNIVERSE`(기본 1200)개로 자른다.
**잘라낸 사실은 콘솔과 `batch_runs.error` 에 `universe=798/2872` 형태로 항상 남긴다.** 조용히 줄이지 않는다.

---

## Provider 전환 (환경변수 한 줄)

```bash
INVESTOR_FLOW_PROVIDER=krx-csv,naver     # 앞쪽이 우선, 뒤쪽이 나머지 구분을 채움
```

| id | 공급 구분 | 조건 |
|---|---|---|
| **`kis`** (기본) | **12구분 전부 — 개인·외국인·기타외국인·기관합계·금융투자·보험·투신·사모·은행·기타금융·연기금·기타법인** | `KIS_APP_KEY` / `KIS_APP_SECRET` |
| `naver` | 개인·외국인·기관합계 | 없음. 항상 사용 가능 |
| `krx-csv` | 전 구분(내려받은 파일 범위) | `data/krx-csv/` 에 CSV 존재 |
| `krx-marketplace` | 전 구분 | `KRX_MARKETPLACE_ID` / `_PW`. 미검증 |
| `licensed` | 전 구분 | `LICENSED_FLOW_API_BASE` / `_KEY` |

KIS 금액 필드는 **백만원 단위**로 내려오므로 provider 가 원 단위로 정규화해서 저장한다.

설정이 안 된 provider는 `provider 비활성(설정 부족)` 로 로그를 남기고 건너뛴다.
현재 어떤 provider가 어떤 값을 공급했는지는 **대시보드 상단 "데이터 출처" 줄에 항상 표기된다.**

### krx-csv 파일 이름 규칙

기간과 투자자 구분을 파일명에서 읽는다. 아래 형식을 모두 인식한다.

```
26.07.27~26.07.29_사모펀드 순매수 상위 종목.csv
20260727-20260729_private_fund.csv
20260805_사모.csv
```

CP949·UTF-8 자동 판별. 컬럼은 `종목코드, 종목명, 거래량_매도, 거래량_매수, 거래량_순매수, 거래대금_*`.
시작일과 종료일이 다르면 일별로 위장하지 않고 `investor_flow_period`(기간합계)에 그대로 넣는다.
스크리너는 이 기간을 프리셋으로 노출하고, 조건 A(개인)도 **같은 구간의 일별 합**으로 맞춰 계산한다.

---

## 유통주식수 정의

```
유통주식수 = 상장주식수 − 최대주주등 소유주식수 − 자기주식
```

세 값을 다 못 구한 종목은 상장주식수로 대체하되 `instruments.free_float_basis = 'listed_shares'` 로 남기고,
**UI에 `상장주식수 기준` 배지를 반드시 띄운다.** 조용히 상장주식수를 쓰고 "유통주식수"라고 적지 않는다.
종목 상세 화면에는 상장주식수·최대주주등·자기주식·유통주식수를 나눠서 보여주고,
대체된 경우 "이 종목의 비율 지표는 실제보다 작게 나옵니다"를 명시한다.

---

## 내부자 매수 판별

- 목록: OpenDART `elestock.json` (임원·주요주주 특정증권등 소유상황보고서)
- 상세: `document.xml` 원문의 **세부변동내역** 표를 파싱한다.
  한 행은 `[취득/처분방법 | 변동일 | 증권종류 | 변동전 | 증감 | 변동후 | 단가 | 비고]` 순인데,
  열 위치를 그대로 믿지 않고 **`변동전 + 증감 = 변동후` 항등식**으로 증감 열을 특정한다.
- 보고서는 거래일로부터 5영업일 이내 제출이라 공시일과 실제 매수일이 다르다.
  **반드시 `trade_date`(변동일) 기준으로 매칭**하고, 늦게 잡히는 건은 `enrichPendingReports(sinceDays)` 로 소급 반영한다.
- 직위가 대표이사·사내이사(등기)인 건만 대상으로 삼고, 취득방법이 장내매수인 건에만 `is_open_market_buy` 를 세운다.
  유상신주취득·증여 등은 배지를 붙이지 않는다.

---

## 차트 패턴

역헤드앤숄더와 컵앤핸들을 좌우 k봉 피벗(기본 k=5) 기반으로 탐지한다.
각 후보는 **0~100 매칭 점수**와 **조건별 실제 수치(evidence)** 를 함께 저장한다.

오탐이 많은 게 정상이다. 그래서 패턴 탭에서 **점수 임계값을 슬라이더로 조절**할 수 있고,
행마다 "근거 보기"로 어깨 대칭도·컵 깊이·V자 배제 봉수·돌파일 거래량 배수 같은 실제 값을 펼쳐 볼 수 있다.
종목 상세 차트에서는 패턴 골격(왼쪽 어깨·머리·오른쪽 어깨, 넥라인)이 캔들 위에 겹쳐 표시된다.

---

## 차트와 도형 저장

요구사항은 TradingView **Charting Library(Advanced Charts)** 다. 무료지만 신청·승인을 받아야 저장소에 접근할 수 있고,
시세는 UDF 프로토콜로 직접 공급해야 한다. 무료 위젯(`s3.tradingview.com/tv.js`)은 저장이 안 되므로 쓰지 않았다.

승인 전에 개발이 막히지 않도록 아래 순서로 만들어 두었다.

1. **UDF 서버** `/api/udf/config`, `/symbols`, `/search`, `/history`, `/time` 이 우리 DB의 국내 일봉을 공급한다.
2. **도형 저장 API** `GET|PUT /api/drawings?symbol=` 가 `chart_drawings(user_id, symbol, payload_json)` 에 사용자별 도형 JSON을 넣는다.
   `save_load_adapter` 가 쓸 계약과 같다.
3. **렌더러**는 지금 당장 동작하는 lightweight-charts로 그렸다. 수평 지지선·추세선을 긋고 새로고침해도 복원된다.

승인 후에는 `src/components/PriceChart.tsx` 만 Charting Library 위젯으로 갈아끼우고
`NEXT_PUBLIC_TV_LIBRARY_PATH` 를 설정하면 된다. UDF·도형 저장 경로는 그대로 재사용한다.

---

## 하지 않는 것

- 종목 추천, 매수·매도 지시, 목표가 제시를 하지 않는다. **사실과 순위만 보여준다.**
- 수익률을 보장하거나 예측하지 않는다.
- 검증되지 않은 수치를 화면에 넣지 않는다. 값이 없으면 "데이터 없음"으로 표시한다.
- 유통주식수를 못 구했는데 구한 척하지 않는다.
- 패턴 결과를 근거 없이 단정하지 않는다. 점수와 수치를 함께 보여준다.
- 자동 주문·실거래 연동 기능은 만들지 않는다.

---

## 주요 테이블

```
instruments(symbol, name, market, listed_shares, major_holder_shares, treasury_shares,
            free_float_shares, free_float_basis, corp_code)
trading_days(date, is_open)
ohlcv_daily(symbol, date, o, h, l, c, volume, traded_value, market_cap)
investor_flow_daily(symbol, date, investor_type, net_buy_qty, net_buy_amount, source)
investor_flow_period(symbol, start_date, end_date, investor_type, net_buy_qty, source)
member_flow_daily(symbol, date, member_name, buy_qty, sell_qty)
insider_reports(rcept_no, symbol, disclosed_at, position, change_qty, detail_status)
insider_trades(rcept_no, symbol, trade_date, disclosed_at, change_qty, method, is_open_market_buy)
pattern_hits(symbol, date, pattern, score, evidence_json, confirmed)
screener_snapshots(date, params_hash, params_json, rows_json)
chart_drawings(user_id, symbol, payload_json)
chart_layouts(user_id, client_id, name, content)   -- TradingView save_load_adapter 용
batch_runs(date, step, status, row_count, error, provider)
```

인증키는 **서버에서만** 읽는다. `NEXT_PUBLIC_` 에 넣지 않는다.

---

## 검증

```bash
npm run typecheck && npm run build
npm run verify -- --date 2026-08-05 --n 5
```

`verify` 는 스크리너를 실제로 돌려 조건 A·B 충족 여부와 정렬이 내림차순인지를 원본 수치로 출력한다.
