// ============================================================
//  시세 수집 스크립트  (GitHub Actions 또는 로컬에서 실행)
//
//  portfolio.json 의 종목들을 Yahoo Finance 에서 조회해
//  data.json 으로 저장합니다.  서버에서 실행되므로 CORS 가 없습니다.
//
//  로컬 실행:  node scripts/fetch-stocks.mjs
// ============================================================

import { readFile, writeFile } from "node:fs/promises";

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";
const HEADERS = { "User-Agent": "Mozilla/5.0 (stock-dashboard)" };

// 관심그룹·보유 종목은 '일봉'(최근 1개월), 섹터 종목은 '주봉'(최근 1년) 차트를 받습니다.
const DAILY = { range: "1mo", interval: "1d" };
const WEEKLY = { range: "1y", interval: "1wk" };

const root = new URL("../", import.meta.url);

async function fetchTicker(ticker, { range, interval }) {
  const url = `${YAHOO}${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || "빈 응답");

  const meta = r.meta || {};
  if (typeof meta.regularMarketPrice !== "number") {
    throw new Error("시세 없음");
  }
  const price = meta.regularMarketPrice;

  // (시각, 종가) 쌍 중 종가가 숫자인 막대만
  const ts = r.timestamp || [];
  const rawCloses = r.indicators?.quote?.[0]?.close || [];
  const bars = ts
    .map((t, i) => ({ t, c: rawCloses[i] }))
    .filter((b) => typeof b.c === "number");

  if (interval === "1wk") {
    // 야후 주봉은 '현재 주' 막대 뒤에 실시간 포인트를 하나 더 붙입니다.
    // 정상 주봉은 정확히 7일 간격이므로, 마지막 간격이 그보다 짧으면(<6일)
    // 그 실시간 포인트를 버립니다. (시간대와 무관 — 한국 종목도 안전)
    if (
      bars.length >= 2 &&
      bars[bars.length - 1].t - bars[bars.length - 2].t < 6 * 86400
    ) {
      bars.pop();
    }
    // 마지막(현재 주) 종가는 실시간가로 맞춰 차트가 현재가에서 끝나게 합니다.
    if (bars.length) bars[bars.length - 1].c = price;
  }

  const closes = bars.map((b) => b.c);

  let prevClose;
  if (interval === "1wk") {
    // 주봉 등락률의 기준은 '이번 주 월요일 시가(개장가)'로 잡습니다.
    // 야후 주봉 막대는 거래소 현지 월요일 00:00 에 앵커되고, 그 막대의 open 이
    // 곧 그 주 월요일 첫 거래 가격(한국 09:00 KRX, 미국 09:30 ET)입니다.
    // 현재 진행 중인 주 막대는 close 가 null 이라 필터에서 빠지므로, 원본 ts/open 을
    // 따로 훑어 가장 최근의 '현지 월요일 00:00' 막대 open 을 찾습니다.
    const rawOpens = r.indicators?.quote?.[0]?.open || [];
    const tzOffset = meta.gmtoffset || 0;   // 거래소 표준시 오프셋 (초). 한국 +32400
    const isMondayLocal = (t) => {
      const local = new Date((t + tzOffset) * 1000);
      // UTC 메서드를 쓰면 (UTC + offset) 의 결과를 그대로 읽을 수 있음
      return local.getUTCDay() === 1 && local.getUTCHours() === 0;
    };
    let mondayOpen = null;
    for (let i = ts.length - 1; i >= 0; i--) {
      if (isMondayLocal(ts[i]) && typeof rawOpens[i] === "number") {
        mondayOpen = rawOpens[i];
        break;
      }
    }
    prevClose = mondayOpen
      ?? (closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose ?? price));
  } else {
    // 일봉: 전일 종가 = 종가 배열 끝에서 두 번째 값.
    // (chartPreviousClose 는 차트 기간 시작점 종가라 등락 계산에 부적합)
    prevClose =
      closes.length >= 2 ? closes[closes.length - 2]
                         : (meta.chartPreviousClose ?? price);
  }

  return { price, prevClose, currency: meta.currency || "USD", closes };
}

// 티커 묶음을 받아 map 에 채웁니다. (chart = DAILY | WEEKLY)
async function fetchInto(map, list, chart, label) {
  for (const ticker of list) {
    try {
      map[ticker] = await fetchTicker(ticker, chart);
      console.log(`OK    ${label} ${ticker.padEnd(12)} ${map[ticker].price}`);
    } catch (e) {
      map[ticker] = { error: String(e.message || e) };
      console.log(`FAIL  ${label} ${ticker.padEnd(12)} ${e.message || e}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // 야후 부담 완화
  }
}

const portfolio = JSON.parse(await readFile(new URL("portfolio.json", root), "utf8"));

// 관심그룹(watchlist)·보유 종목(holdings) → 일봉, 섹터(sectors) → 주봉
const dailyTickers = [
  ...new Set(
    [
      ...(portfolio.watchlist || []).map((w) => w.ticker),
      ...(portfolio.holdings || []).map((h) => h.ticker),
    ].filter(Boolean)
  ),
];
const weeklyTickers = [
  ...new Set(
    (portfolio.sectors || [])
      .flatMap((s) => (s.items || []).map((it) => it.ticker))
      .filter(Boolean)
  ),
];

const quotes = {};   // 일봉 — 관심그룹·보유 종목
const weekly = {};   // 주봉 — 섹터 종목

await fetchInto(quotes, dailyTickers, DAILY, "일봉");
await fetchInto(weekly, weeklyTickers, WEEKLY, "주봉");

const data = { updatedAt: new Date().toISOString(), quotes, weekly };
await writeFile(new URL("data.json", root), JSON.stringify(data, null, 2) + "\n");

const okCount = (m) => Object.values(m).filter((q) => !q.error).length;
console.log(
  `\ndata.json 작성 완료 — 일봉 ${okCount(quotes)}/${dailyTickers.length} · ` +
    `주봉 ${okCount(weekly)}/${weeklyTickers.length} 종목`
);
