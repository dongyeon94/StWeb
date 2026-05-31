// ============================================================
//  구글 시트 — 계좌별 거래내역 + 티커 매핑 수집 (테스트 탭용)
//
//  공개 시트의 CSV export 를 받아 sheets.json 으로 저장합니다.
//  '링크가 있는 모든 사용자에게 보기 허용' 으로 공유돼 있어야 동작합니다.
//
//  계좌 탭(종합·ISA·연금저축)은 각각 거래내역이고, '필요 티커' 탭이
//  종목명 ↔ 야후 티커 매핑 소스입니다. 매핑이 없는 보유 종목은 앱이
//  '필요 티커' 목록으로 보여줘서 사용자가 시트에 채워 넣게 합니다.
//
//  로컬 실행:  node scripts/fetch-sheets.mjs
// ============================================================

import { writeFile } from "node:fs/promises";

const SHEET_ID = "1JXCFGpgqZX0cwCvMrA9jaO1dWqNaiQNjtLVOfCKxNpA";
// 계좌 탭 — 각 탭이 하나의 거래내역. 섹션으로 묶어 보여줍니다.
const ACCOUNTS = [
  { key: "종합", label: "종합",     gid: "0" },
  { key: "isa",  label: "ISA",      gid: "1094025677" },
  { key: "연금", label: "연금저축", gid: "2068601321" },
];
const TK_GID = "545533008";   // 필요 티커 탭 (종목명 ↔ 야후 티커 매핑)

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

// 계좌 탭 각각 수집 — 빈 탭(거래 없음)은 빈 거래내역으로 저장하고 넘어감
const accounts = [];
for (const a of ACCOUNTS) {
  let rows = [];
  try {
    rows = await fetchCsv(a.gid, a.label);
  } catch (e) {
    console.log(`WARN  ${a.label} 받기 실패: ${e.message || e}`);
  }
  const headers = rows.length ? rows[0] : [];
  const data = rows.length ? rows.slice(1) : [];
  accounts.push({ key: a.key, label: a.label, transactions: { headers, rows: data } });
  console.log(`      ${a.label}: ${data.length}행`);
}

const tkRows = await fetchCsv(TK_GID, "필요 티커").catch(() => []);
const tickers = parseTickerSheet(tkRows);

const totalRows = accounts.reduce((s, a) => s + a.transactions.rows.length, 0);
if (!totalRows) {
  console.log("FAIL  모든 계좌 거래내역이 비어 있음");
  process.exit(1);
}

const out = {
  updatedAt: new Date().toISOString(),
  source: {
    sheetId: SHEET_ID,
    accounts: ACCOUNTS.map(({ key, label, gid }) => ({ key, label, gid })),
    tickerGid: TK_GID,
  },
  accounts,
  tickers,
};

await writeFile(new URL("sheets.json", root), JSON.stringify(out, null, 2) + "\n");
console.log(
  `\nOK    거래내역 ${totalRows}행(${accounts.map((a) => `${a.label} ${a.transactions.rows.length}`).join(", ")}) · 티커 매핑 ${tickers.length}개`
);
