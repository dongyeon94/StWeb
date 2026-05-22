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

// 주봉 그룹핑용 — 해당 시각이 속한 주의 시작(월요일 00:00 UTC) epoch
function weekStart(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7;            // 월=0 … 일=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

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

  const ts = r.timestamp || [];
  const rawCloses = r.indicators?.quote?.[0]?.close || [];

  let closes;
  if (interval === "1wk") {
    // 야후 주봉은 '현재 주' 막대 위에 실시간 포인트를 덧붙여 끝 종가가 중복됩니다.
    // 주 단위로 묶어 한 주당 마지막 종가만 남깁니다(중복 제거).
    const byWeek = new Map();
    ts.forEach((t, i) => {
      const c = rawCloses[i];
      if (typeof c === "number") byWeek.set(weekStart(t * 1000), c);
    });
    closes = [...byWeek.values()];
  } else {
    closes = rawCloses.filter((v) => typeof v === "number");
  }

  const price = meta.regularMarketPrice;
  // 직전 구간(전일/전주) 종가: 종가 배열의 끝에서 두 번째 값.
  // (chartPreviousClose 는 차트 기간 시작점 종가라 등락 계산에 부적합)
  const prevClose =
    closes.length >= 2 ? closes[closes.length - 2]
                       : (meta.chartPreviousClose ?? price);

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
