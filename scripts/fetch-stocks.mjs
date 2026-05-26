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
    // (섹터 카드의 경우 fetchTenAmAnchors 가 다시 10시 스냅샷으로 덮어씁니다.)
    if (bars.length) bars[bars.length - 1].c = price;
  }

  const closes = bars.map((b) => b.c);
  // 직전 구간(전일/전주) 종가: 종가 배열의 끝에서 두 번째 값.
  // (chartPreviousClose 는 차트 기간 시작점 종가라 등락 계산에 부적합)
  const prevClose =
    closes.length >= 2 ? closes[closes.length - 2]
                       : (meta.chartPreviousClose ?? price);

  return { price, prevClose, currency: meta.currency || "USD", closes };
}

// 섹터 카드 전용 — 거래소 현지 '오늘 10시' 가격과 '7일 전 10시' 가격을 찾아 반환.
// 야후 30분 막대(`interval=30m`)로 가져옵니다. 일·시간대 보정은 meta.gmtoffset 사용.
// 한국 종목(09:00 KRX 개장)·미국 종목(09:30 ET 개장) 모두 10:00 시작 30분 막대가 존재.
// 휴일이면 가장 가까운 거래일의 10시 막대로 대체됩니다.
async function fetchTenAmAnchors(ticker) {
  const url = `${YAHOO}${encodeURIComponent(ticker)}?range=15d&interval=30m`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || "빈 응답");

  const meta = r.meta || {};
  const tzOffset = meta.gmtoffset || 0;
  const ts = r.timestamp || [];
  const opens = r.indicators?.quote?.[0]?.open || [];

  // 거래소 현지 10:00 시작 막대만 모음 (open 값이 곧 그 시각의 시초가)
  const tenAm = [];
  for (let i = 0; i < ts.length; i++) {
    if (typeof opens[i] !== "number") continue;
    const local = new Date((ts[i] + tzOffset) * 1000);
    if (local.getUTCHours() === 10 && local.getUTCMinutes() === 0) {
      tenAm.push({ t: ts[i], open: opens[i] });
    }
  }
  if (tenAm.length === 0) return null;

  // 끝점 — 가장 최근의 10시 막대 (오늘이 거래일이면 오늘 10시, 휴일·주말이면 직전 거래일 10시)
  const ref = tenAm[tenAm.length - 1];
  // 시작점 — 끝점 기준 정확히 7일 전과 가장 가까운 10시 막대
  const target = ref.t - 7 * 86400;
  let prev = null, minDiff = Infinity;
  for (const b of tenAm) {
    if (b.t >= ref.t) continue;
    const d = Math.abs(b.t - target);
    if (d < minDiff) { minDiff = d; prev = b; }
  }
  if (!prev) return null;

  return { refPrice: ref.open, prevPrice: prev.open, refTime: ref.t, prevTime: prev.t };
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

// 섹터 등락률 = 오늘 10시 ↔ 7일 전 10시. 스파크라인 마지막 점도 10시 스냅샷으로 맞춰
// 차트 끝과 카드 표시가가 일치하도록 합니다. 10시 막대를 못 찾으면 주봉 fallback 유지.
for (const ticker of weeklyTickers) {
  const w = weekly[ticker];
  if (!w || w.error) continue;
  try {
    const a = await fetchTenAmAnchors(ticker);
    if (a) {
      w.price = a.refPrice;
      w.prevClose = a.prevPrice;
      if (w.closes?.length) w.closes[w.closes.length - 1] = a.refPrice;
      const pct = ((a.refPrice - a.prevPrice) / a.prevPrice * 100).toFixed(2);
      console.log(`OK    10시 ${ticker.padEnd(12)} ${a.refPrice} ↔ ${a.prevPrice} (${pct}%)`);
    } else {
      console.log(`SKIP  10시 ${ticker.padEnd(12)} (10시 막대 부족 — 주봉 fallback 유지)`);
    }
  } catch (e) {
    console.log(`FAIL  10시 ${ticker.padEnd(12)} ${e.message || e}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

const data = { updatedAt: new Date().toISOString(), quotes, weekly };
await writeFile(new URL("data.json", root), JSON.stringify(data, null, 2) + "\n");

const okCount = (m) => Object.values(m).filter((q) => !q.error).length;
console.log(
  `\ndata.json 작성 완료 — 일봉 ${okCount(quotes)}/${dailyTickers.length} · ` +
    `주봉 ${okCount(weekly)}/${weeklyTickers.length} 종목`
);
