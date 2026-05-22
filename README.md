# 📈 내 주식 대시보드

내가 설정한 한국·미국 주식의 현재가, 등락률, 매수가 대비 손익, 미니 차트를
한 화면에서 보여주는 GitHub Pages 홈페이지입니다.

GitHub Actions가 주기적으로 Yahoo Finance에서 시세를 받아 `data.json`에 저장하고
사이트를 배포합니다. 시세 수집이 **서버에서** 이루어지므로 CORS·API 키·프록시가
전혀 필요 없습니다.

## 동작 구조

```
GitHub Actions (10분마다 + 수동 실행)
  └ scripts/fetch-stocks.mjs  →  Yahoo Finance 조회  →  data.json 생성
       └ GitHub Pages 로 사이트 배포
            └ 브라우저: index.html 이 portfolio.json + data.json 을 읽어 렌더링
```

| 파일 | 역할 |
|------|------|
| `portfolio.json` | 보유 종목 설정 (직접 편집) |
| `scripts/fetch-stocks.mjs` | 시세 수집 스크립트 (Actions가 실행) |
| `.github/workflows/update-stocks.yml` | 갱신·배포 워크플로우 |
| `data.json` | 수집된 시세 (자동 생성) |
| `index.html` · `style.css` · `app.js` | 화면 |

## 1. 보유 종목 설정

`portfolio.json`의 `holdings` 배열을 수정하세요.

```json
{
  "colorScheme": "kr",
  "holdings": [
    { "ticker": "005930.KS", "name": "삼성전자", "buyPrice": 70000, "quantity": 10 },
    { "ticker": "AAPL",      "name": "Apple",    "buyPrice": 180,   "quantity": 5 }
  ]
}
```

| 항목 | 설명 |
|------|------|
| `ticker` | 야후 심볼 — KOSPI `종목코드.KS`, KOSDAQ `종목코드.KQ`, 미국은 티커 그대로 |
| `name` | 화면에 표시할 이름 |
| `buyPrice` | 내 평균 매수 단가 (한국 원화 / 미국 달러) |
| `quantity` | 보유 수량 |
| `colorScheme` | `"kr"` 상승 빨강·하락 파랑 / `"us"` 상승 초록·하락 빨강 |

> 손익 요약은 통화(원화/달러)별로 따로 합산됩니다.

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

## 참고

- **저장소를 public으로 두는 것을 권장**합니다. public 저장소는 GitHub Actions
  사용 시간이 무제한이지만, private은 매월 무료 시간이 제한됩니다.
  private이라면 워크플로우의 `cron`을 `*/30` 등으로 늘리세요.
- 예약 워크플로우는 저장소가 60일간 활동이 없으면 비활성화될 수 있습니다.
- 갱신 간격은 `.github/workflows/update-stocks.yml`의 `cron` 값에서 조정합니다.

## 로컬에서 확인

```sh
node scripts/fetch-stocks.mjs   # data.json 생성 (Node 18+ 필요)
python3 -m http.server 8000     # http://localhost:8000 접속
```
