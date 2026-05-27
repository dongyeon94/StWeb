// ============================================================
//  구글 시트 — 거래내역 + 티커 매핑 수집 (테스트 탭용)
//
//  공개 시트의 CSV export 를 받아 sheets.json 으로 저장합니다.
//  '링크가 있는 모든 사용자에게 보기 허용' 으로 공유돼 있어야 동작합니다.
//
//  로컬 실행:  node scripts/fetch-sheets.mjs
// ============================================================

import { writeFile } from "node:fs/promises";

const SHEET_ID = "18y9OJnkAqVZ5W9grL5diRQrloD2bXl-CsT1JuC2WKLU";
const TX_GID = "1870356595";   // 거래내역 탭
const TK_GID = "1784159560";   // 티커 탭 (종목명 ↔ 야후 티커 매핑)

const root = new URL("../", import.meta.url);

// 따옴표·셀 안 콤마·줄바꿈을 처리하는 최소 CSV 파서
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

async function fetchCsv(gid, label) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  console.log(`GET   ${label}  ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": "stweb-sheets" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCsv(await res.text());
}

// 시트 티커(예: '379780', 'TSLA', 'BTC')를 야후 심볼로 정규화.
// 거래소·통화 정보가 적은 경우 KRW 6자리는 .KS 가정, BTC 는 BTC-USD.
function normalizeTicker(rawTicker, currency) {
  const t = (rawTicker || "").trim();
  const c = (currency || "").trim();
  if (!t) return "";
  // 이미 야후 형식이면 그대로 (.KS / .KQ / -USD 포함, ^지수, 외화/X 등)
  if (/[\.\-\^=]/.test(t)) return t;
  // 한국 6자리 숫자 — KOSPI(.KS) 가정. KOSDAQ 이면 사용자가 시트에 '6자리.KQ' 로 명시.
  if (/^\d{6}$/.test(t) && (c === "KRW" || c === "")) return `${t}.KS`;
  // 비트코인 등 통화 비어있고 짧은 영문은 야후 *-USD 형식
  if (t === "BTC") return "BTC-USD";
  if (t === "ETH") return "ETH-USD";
  // 그 외 단순 알파벳 (USD 종목 — TSLA, MSTR 등) 은 그대로
  return t;
}

// 티커 시트(A: 항목, B: 티커, C: 국가) 행에서 매핑만 추출
function parseTickerSheet(rows) {
  if (!rows.length) return [];
  const tickers = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {     // 첫 행 = 헤더
    const r = rows[i] || [];
    const name = (r[0] || "").trim();
    const rawTk = (r[1] || "").trim();
    const cur = (r[2] || "").trim();
    if (!name || !rawTk) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const ticker = normalizeTicker(rawTk, cur);
    tickers.push({ name, ticker, currency: cur || null });
  }
  return tickers;
}

const txRows = await fetchCsv(TX_GID, "거래내역");
const tkRows = await fetchCsv(TK_GID, "티커");

if (!txRows.length) {
  console.log("FAIL  거래내역 비어 있음");
  process.exit(1);
}

const txHeaders = txRows[0];
const txData = txRows.slice(1);
const tickers = parseTickerSheet(tkRows);

const out = {
  updatedAt: new Date().toISOString(),
  source: { sheetId: SHEET_ID, txGid: TX_GID, tickerGid: TK_GID },
  transactions: { headers: txHeaders, rows: txData },
  tickers,
};

await writeFile(new URL("sheets.json", root), JSON.stringify(out, null, 2) + "\n");
console.log(
  `\nOK    거래내역 ${txData.length}행 · 티커 매핑 ${tickers.length}개 (${tickers.map((t) => t.ticker).filter(Boolean).slice(0, 6).join(", ")} …)`
);
