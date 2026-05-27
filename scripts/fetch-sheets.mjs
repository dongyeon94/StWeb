// ============================================================
//  구글 시트 거래내역 수집 (테스트 탭용)
//
//  공개 시트의 CSV export 를 받아 sheets.json 으로 저장합니다.
//  '링크가 있는 모든 사용자에게 보기 허용' 으로 공유돼 있어야 동작합니다.
//
//  로컬 실행:  node scripts/fetch-sheets.mjs
// ============================================================

import { writeFile } from "node:fs/promises";

const SHEET_ID = "18y9OJnkAqVZ5W9grL5diRQrloD2bXl-CsT1JuC2WKLU";
const GID = "1870356595";
const SHEET_NAME = "거래내역";   // 화면 표시용 라벨

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
  // 끝의 빈 행 제거
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

const url =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

console.log(`GET   ${url}`);
const res = await fetch(url, {
  headers: { "User-Agent": "stweb-sheets" },
  redirect: "follow",
});
if (!res.ok) {
  console.log(`FAIL  HTTP ${res.status}`);
  process.exit(1);
}
const csv = await res.text();
const parsed = parseCsv(csv);
if (!parsed.length) {
  console.log("FAIL  빈 응답");
  process.exit(1);
}

const headers = parsed[0];
const rows = parsed.slice(1);

const out = {
  updatedAt: new Date().toISOString(),
  source: { sheetId: SHEET_ID, gid: GID, name: SHEET_NAME },
  headers,
  rows,
};

await writeFile(new URL("sheets.json", root), JSON.stringify(out, null, 2) + "\n");
console.log(`OK    ${SHEET_NAME}  ${rows.length}행 · 컬럼 ${headers.length}개`);
