# 📈 내 주식 · 🏠 청약 대시보드

내가 설정한 한국·미국 주식의 현재가·등락률·손익·미니 차트와,
LH·청약홈의 부동산 청약 일정을 한 화면에서 보여주는 GitHub Pages 홈페이지입니다.

GitHub Actions가 주기적으로 Yahoo Finance에서 시세를, 공공데이터포털에서 청약
일정을 받아 `data.json`·`cheongyak.json`에 저장하고 사이트를 배포합니다.
데이터 수집이 **서버에서** 이루어지므로 CORS·프록시가 필요 없습니다.

## 동작 구조

```
GitHub Actions (10분마다 + 수동 실행)
  ├ scripts/fetch-stocks.mjs     →  Yahoo Finance 조회        →  data.json 생성
  ├ scripts/fetch-cheongyak.mjs  →  청약홈·LH 오픈API 조회    →  cheongyak.json 생성
  └ GitHub Pages 로 사이트 배포
       └ 브라우저: index.html 이 portfolio.json + data.json + cheongyak.json 을 읽어 렌더링
```

| 파일 | 역할 |
|------|------|
| `portfolio.json` | 보유 종목 설정 (직접 편집) |
| `scripts/fetch-stocks.mjs` | 시세 수집 스크립트 (Actions가 실행) |
| `scripts/fetch-cheongyak.mjs` | 청약 일정 수집 스크립트 (Actions가 실행) |
| `.github/workflows/update-stocks.yml` | 갱신·배포 워크플로우 |
| `data.json` | 수집된 시세 (자동 생성) |
| `cheongyak.json` | 수집된 청약 일정 (자동 생성) |
| `index.html` · `style.css` · `app.js` | 화면 |

## 1. 보유 종목 설정

`portfolio.json`의 `holdings` 배열을 수정하세요.

```json
{
  "colorScheme": "kr",
  "holdings": [
    { "ticker": "005930.KS", "name": "삼성전자", "buyPrice": 70000, "quantity": 10 },
    { "ticker": "AAPL",      "name": "Apple",    "buyPrice": 180,   "quantity": 5 },
    { "ticker": "O", "name": "리얼티인컴", "buyPrice": 55, "quantity": 10, "group": "월배당" }
  ]
}
```

| 항목 | 설명 |
|------|------|
| `ticker` | 야후 심볼 — KOSPI `종목코드.KS`, KOSDAQ `종목코드.KQ`, 미국은 티커 그대로 |
| `name` | 화면에 표시할 이름 |
| `buyPrice` | 내 평균 매수 단가 (한국 원화 / 미국 달러) |
| `quantity` | 보유 수량 |
| `group` | (선택) 종목을 묶을 그룹 이름. 같은 그룹끼리 **탭**으로 분리됨. 생략하면 `일반` |
| `colorScheme` | `"kr"` 상승 빨강·하락 파랑 / `"us"` 상승 초록·하락 빨강 |

> 손익 요약은 통화(원화/달러)별로 따로 합산됩니다.

### 탭으로 그룹 나누기

`group` 값이 서로 다른 종목이 2개 이상이면 화면 상단에 탭이 생깁니다.
예를 들어 월배당 종목에 `"group": "월배당"`을 주면 `전체` · `일반` · `월배당`
탭이 만들어지고, 각 탭은 그 그룹의 종목과 자산 요약만 보여줍니다.
그룹이 하나뿐이면 탭은 표시되지 않습니다.
특정 탭은 `주소/#월배당` 처럼 URL 해시로 바로 열 수 있습니다.

## 2. GitHub Pages 켜기

1. 이 저장소를 GitHub에 푸시합니다 (`main` 브랜치).
2. 저장소 → **Settings → Pages** 이동.
3. **Source**를 **`GitHub Actions`** 로 선택합니다. *(branch 방식 아님)*
4. **Actions** 탭에서 `시세 갱신 & 배포` 워크플로우가 실행되면,
   완료 후 `https://<사용자명>.github.io/<저장소명>/` 에서 접속됩니다.

## 3. 갱신 방식

- **자동**: 10분마다 워크플로우가 시세를 다시 받아 배포합니다.
  (GitHub 사정에 따라 실제 실행은 다소 지연될 수 있습니다.)
- **수동**: **Actions 탭 → `시세 갱신 & 배포` → `Run workflow`** 로 즉시 갱신.
- 페이지의 **갱신** 버튼은 현재 배포된 `data.json`을 다시 불러옵니다.
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
  private이라면 워크플로우의 `cron`을 `*/30` 등으로 늘리세요.
- 예약 워크플로우는 저장소가 60일간 활동이 없으면 비활성화될 수 있습니다.
- 갱신 간격은 `.github/workflows/update-stocks.yml`의 `cron` 값에서 조정합니다.

## 로컬에서 확인

```sh
node scripts/fetch-stocks.mjs                      # data.json 생성 (Node 18+ 필요)
DATA_GO_KR_KEY=발급키 node scripts/fetch-cheongyak.mjs  # cheongyak.json 생성
python3 -m http.server 8000                        # http://localhost:8000 접속
```
