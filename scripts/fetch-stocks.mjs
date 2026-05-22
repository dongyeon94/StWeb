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
const RANGE = "1mo";       // 차트 기간
const INTERVAL = "1d";     // 차트 간격
const HEADERS = { "User-Agent": "Mozilla/5.0 (stock-dashboard)" };

const root = new URL("../", import.meta.url);

async function fetchTicker(ticker) {
  const url = `${YAHOO}${encodeURIComponent(ticker)}?range=${RANGE}&interval=${INTERVAL}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || "빈 응답");

  const meta = r.meta || {};
  const closes = (r.indicators?.quote?.[0]?.close || [])
    .filter((v) => typeof v === "number");

  if (typeof meta.regularMarketPrice !== "number") {
    throw new Error("시세 없음");
  }

  const price = meta.regularMarketPrice;
  // 전일 종가: 일별 종가 배열의 끝에서 두 번째 값.
  // (range=1mo 의 chartPreviousClose 는 '한 달 전' 종가라 일간 등락 계산에 부적합)
  const prevClose =
    closes.length >= 2 ? closes[closes.length - 2]
                       : (meta.chartPreviousClose ?? price);

  return { price, prevClose, currency: meta.currency || "USD", closes };
}

const portfolio = JSON.parse(await readFile(new URL("portfolio.json", root), "utf8"));
const quotes = {};

// 같은 종목이 여러 그룹에 있을 수 있으므로 고유 티커만 조회
const tickers = [...new Set(portfolio.holdings.map((h) => h.ticker))];

for (const ticker of tickers) {
  try {
    quotes[ticker] = await fetchTicker(ticker);
    console.log(`OK    ${ticker.padEnd(12)} ${quotes[ticker].price}`);
  } catch (e) {
    quotes[ticker] = { error: String(e.message || e) };
    console.log(`FAIL  ${ticker.padEnd(12)} ${e.message || e}`);
  }
  await new Promise((r) => setTimeout(r, 300)); // 야후 부담 완화
}

const data = { updatedAt: new Date().toISOString(), quotes };
await writeFile(new URL("data.json", root), JSON.stringify(data, null, 2) + "\n");

const ok = Object.values(quotes).filter((q) => !q.error).length;
console.log(`\ndata.json 작성 완료 — 성공 ${ok} / 전체 ${tickers.length} 종목`);
