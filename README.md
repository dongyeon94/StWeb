# 📈 내 주식 · 🏠 청약 대시보드

내가 고른 관심 종목(주식·지수·코인·환율) 시세와 보유 종목 손익,
LH·청약홈의 부동산 청약 일정을 한 화면에서 보여주는 GitHub Pages 홈페이지입니다.

GitHub Actions가 주기적으로 Yahoo Finance에서 시세를, 공공데이터포털에서 청약
일정을 받아 `data.json`·`cheongyak.json`에 저장하고 사이트를 배포합니다.
데이터 수집이 **서버에서** 이루어지므로 CORS·프록시가 필요 없습니다.

## 동작 구조

```
GitHub Actions (30분마다 + 수동 실행)
  ├ scripts/fetch-stocks.mjs     →  Yahoo Finance 조회        →  data.json (매 실행 갱신)
  ├ scripts/fetch-cheongyak.mjs  →  청약홈·LH 오픈API 조회    →  cheongyak.json (하루 2회 갱신)
  └ GitHub Pages 로 사이트 배포
       └ 브라우저: index.html 이 portfolio.json + data.json + cheongyak.json 을 읽어 렌더링
```

| 파일 | 역할 |
|------|------|
| `portfolio.json` | 관심 종목·보유 종목 설정 (직접 편집) |
| `scripts/fetch-stocks.mjs` | 시세 수집 스크립트 (Actions가 실행) |
| `scripts/fetch-cheongyak.mjs` | 청약 일정 수집 스크립트 (Actions가 실행) |
| `.github/workflows/update-stocks.yml` | 갱신·배포 워크플로우 |
| `data.json` | 수집된 시세 (자동 생성) |
| `cheongyak.json` | 수집된 청약 일정 (자동 생성) |
| `index.html` · `style.css` · `app.js` | 화면 |

## 1. 종목 설정

`portfolio.json` 한 파일에서 **관심 종목(`watchlist`)** 과 **보유 종목(`holdings`)**
을 함께 관리합니다.

```json
{
  "colorScheme": "kr",
  "watchlist": [
    { "kind": "주식", "ticker": "005930.KS", "name": "삼성전자" },
    { "kind": "지수", "ticker": "^GSPC",     "name": "S&P 500" },
    { "kind": "코인", "ticker": "BTC-USD",   "name": "비트코인 (BTC/USD)" },
    { "kind": "통화", "ticker": "KRW=X",     "name": "USD/KRW" }
  ],
  "holdings": [
    { "ticker": "005930.KS", "name": "삼성전자", "buyPrice": 70000, "quantity": 10 },
    { "ticker": "AAPL",      "name": "Apple",    "buyPrice": 180,   "quantity": 5 },
    { "ticker": "O", "name": "리얼티인컴", "buyPrice": 55, "quantity": 10, "group": "월배당" }
  ]
}
```

| 공통 항목 | 설명 |
|------|------|
| `ticker` | 야후 심볼 — KOSPI `종목코드.KS`, KOSDAQ `종목코드.KQ`, 미국 주식은 티커 그대로,<br>지수 `^GSPC`·`^IXIC`·`^KS11`·`^KQ11`, 코인 `BTC-USD`, 환율 `KRW=X`·`JPYKRW=X` |
| `name` | 화면에 표시할 이름 |
| `colorScheme` | `"kr"` 상승 빨강·하락 파랑 / `"us"` 상승 초록·하락 빨강 |

### 관심 종목 — `watchlist`

상단 첫 탭 **`관심그룹`** 에 모이는, 시세만 지켜보는 종목입니다.
보유 수량·평단 없이 현재가·등락률·미니 차트만 보여줍니다.
분류별 섹션으로 묶이고, 탭 상단에 각 분류로 바로 이동하는 바로가기 바가 고정됩니다.

| 항목 | 설명 |
|------|------|
| `kind` | 분류 — `통화` · `지수` · `주식` · `코인` 순으로 섹션이 표시됨 |
| `mul` | (선택) 표시 배율. 예: `JPYKRW=X` 에 `100` 을 주면 100엔 기준 환율로 표시. 등락률은 영향 없음 |

> 지수·환율은 통화 기호 없이 숫자만, 주식·코인은 통화 기호와 함께 표시됩니다.

### 섹터 — `sectors`

관심그룹 탭 맨 아래(코인 섹션 뒤)에 들어가는 섹터 영역입니다. 섹터별로
ETF·대장주를 **미니 카드**(일반 카드의 약 절반 크기)로 시세와 함께 보여줍니다.
`sectors` 배열의 각 원소가 한 섹터이며, `items` 에 그 섹터의 종목을 담습니다.

| 항목 | 설명 |
|------|------|
| `name` | 섹터 이름 (예: `AI 반도체`) |
| `items[].ticker` | 야후 심볼 — 시세를 받아올 종목 코드 |
| `items[].name` | 카드에 표시할 이름 |
| `items[].cat` | (선택) 분류 꼬리표 — 예: `미국 ETF` · `한국 종목` |

> 한 섹터 안에서 같은 `ticker` 가 중복되면 한 번만 표시됩니다.
> 섹터 카드는 **주봉(최근 1년)** 기준 — 등락률·차트가 주간 추이입니다.
> (관심그룹·보유 종목 카드는 일봉 기준.) 시세는 `fetch-stocks.mjs` 가 함께 받아옵니다.

### 보유 종목 — `holdings`

실제 매수한 종목입니다. 매수 단가·수량으로 평가손익을 계산합니다.

| 항목 | 설명 |
|------|------|
| `buyPrice` | 내 평균 매수 단가 (한국 원화 / 미국 달러) |
| `quantity` | 보유 수량 |
| `group` | (선택) 종목을 묶을 그룹 이름. 같은 그룹끼리 **탭**으로 분리됨. 생략하면 `일반` |

> 손익 요약은 통화(원화/달러)별로 따로 합산됩니다.

### 탭 구성

상단 탭은 **`관심그룹`** → 보유 종목 `group` 탭들 → **`🏠 청약`** 순서로 놓입니다.
`group` 값이 서로 다른 보유 종목이 여러 개면 그룹마다 탭이 생기고, 각 탭은
그 그룹의 종목과 자산 요약만 보여줍니다.
특정 탭은 `주소/#관심그룹`, `주소/#월배당` 처럼 URL 해시로 바로 열 수 있습니다.

## 2. GitHub Pages 켜기

1. 이 저장소를 GitHub에 푸시합니다 (`main` 브랜치).
2. 저장소 → **Settings → Pages** 이동.
3. **Source**를 **`GitHub Actions`** 로 선택합니다. *(branch 방식 아님)*
4. **Actions** 탭에서 `시세·청약 갱신 & 배포` 워크플로우가 실행되면,
   완료 후 `https://<사용자명>.github.io/<저장소명>/` 에서 접속됩니다.

## 3. 갱신 방식

- **주식 시세**: 워크플로우가 30분마다 실행돼 매번 다시 받아 배포합니다.
  (GitHub 사정에 따라 실제 실행은 다소 지연될 수 있습니다.)
- **청약 일정**: 공고가 자주 바뀌지 않아 **한국 기준 하루 2회**(오전 10시·오후 3시)만
  새로 받습니다. 나머지 실행은 캐시에 보관된 청약 데이터를 그대로 씁니다.
- **수동·푸시**: **Actions 탭 → `시세·청약 갱신 & 배포` → `Run workflow`** 로 즉시 갱신.
  수동 실행이나 코드 푸시일 때는 청약 일정도 함께 새로 받습니다.
  (인증키를 막 등록했다면 한 번 수동 실행하면 바로 반영됩니다.)
- 화면의 "시세 기준 시각"이 데이터를 마지막으로 받아온 시점입니다.

## 4. 청약 일정 설정 (data.go.kr API 키)

상단 **`🏠 청약`** 탭은 한국부동산원 청약홈과 LH의 분양·임대·무순위(줍줍)
공고 일정을 보여줍니다. 이 데이터는 공공데이터포털(data.go.kr)의 무료 오픈API에서 받아오며,
**인증키 한 개**만 발급받아 등록하면 됩니다. (키 없이도 사이트는 정상 동작하고,
청약 탭에 "인증키 설정 필요" 안내만 표시됩니다.)

### 인증키 발급 — 약 2분

1. [data.go.kr](https://www.data.go.kr) 회원가입 후 로그인.
2. 아래 두 API 페이지에서 각각 **`활용신청`** 클릭 (보통 즉시 자동 승인):
   - [한국부동산원_청약홈 분양정보 조회 서비스](https://www.data.go.kr/data/15098547/openapi.do)
   - [한국토지주택공사_분양임대공고문 조회 서비스](https://www.data.go.kr/data/15058530/openapi.do)
3. **마이페이지 → 인증키 발급현황**에서 일반 인증키를 복사합니다.
   (한 계정의 인증키 하나가 활용신청한 모든 API에 공통으로 쓰입니다.
   `인코딩`/`디코딩` 둘 중 아무거나 써도 스크립트가 알아서 처리합니다.)

### GitHub Secret 등록

저장소 → **Settings → Secrets and variables → Actions → New repository secret**

| 항목 | 값 |
|------|-----|
| Name | `DATA_GO_KR_KEY` |
| Secret | 발급받은 인증키 |

등록 후 **Actions 탭에서 워크플로우를 한 번 실행**(또는 아무 커밋 push)하면
`🏠 청약` 탭에 일정이 채워집니다. 키는 코드·`cheongyak.json`에 들어가지 않으므로
저장소가 public이어도 노출되지 않습니다.

> 활용신청 직후 잠깐은 키가 활성화 전이라 호출이 실패할 수 있습니다.
> 청약 탭에 출처별 오류가 뜨면 몇 분 뒤 다시 실행해 보세요.
> 표시 범위는 최근 90일 내 모집공고 또는 접수 진행/예정 공고(전국, 최대 100건)입니다.
> 청약홈 일반 분양·무순위(줍줍)·LH 공고가 각각 칩으로 구분돼 표시됩니다.

## 참고

- **저장소를 public으로 두는 것을 권장**합니다. public 저장소는 GitHub Actions
  사용 시간이 무제한이지만, private은 매월 무료 시간이 제한됩니다.
  private이라면 워크플로우의 `cron`을 `0 * * * *`(1시간) 등으로 늘리세요.
- 예약 워크플로우는 저장소가 60일간 활동이 없으면 비활성화될 수 있습니다.
- 갱신 간격은 `.github/workflows/update-stocks.yml`의 `cron` 값에서 조정합니다.

## 로컬에서 확인

```sh
node scripts/fetch-stocks.mjs                      # data.json 생성 (Node 18+ 필요)
DATA_GO_KR_KEY=발급키 node scripts/fetch-cheongyak.mjs  # cheongyak.json 생성
python3 -m http.server 8000                        # http://localhost:8000 접속
```
