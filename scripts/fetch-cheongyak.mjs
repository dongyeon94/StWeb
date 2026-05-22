// ============================================================
//  청약 일정 수집 스크립트  (GitHub Actions 또는 로컬에서 실행)
//
//  공공데이터포털(data.go.kr) 오픈API 두 곳에서 분양·임대 공고를
//  받아 cheongyak.json 으로 저장합니다.
//    · 한국부동산원 청약홈 — APT 분양정보 조회 서비스
//    · 한국토지주택공사(LH) — 분양임대공고문 조회 서비스
//
//  ▶ 무료 인증키가 필요합니다:
//    1. data.go.kr 회원가입
//    2. 위 두 API 를 각각 "활용신청" (보통 즉시 승인)
//    3. 발급된 인증키를 환경변수 DATA_GO_KR_KEY 로 전달
//       GitHub → 저장소 Settings → Secrets and variables → Actions
//              → New repository secret → 이름 DATA_GO_KR_KEY
//
//  키가 없거나 API 가 실패해도 cheongyak.json 은 항상 작성되고
//  스크립트는 정상 종료합니다(배포가 멈추지 않도록).
//
//  로컬 실행:  DATA_GO_KR_KEY=발급키 node scripts/fetch-cheongyak.mjs
// ============================================================

import { writeFile } from "node:fs/promises";

const KEY = (process.env.DATA_GO_KR_KEY || process.env.CHEONGYAK_API_KEY || "").trim();

const root = new URL("../", import.meta.url);
const OUT = new URL("cheongyak.json", root);

const LOOKBACK_DAYS = 90;   // 최근 N일 안에 난 모집공고까지 표시
const MAX_NOTICES = 100;    // 화면에 너무 많지 않도록 상한

/* ---------- 공통 유틸 ---------- */

// data.go.kr 인증키는 '인코딩 키'와 '디코딩 키' 두 형태로 발급됩니다.
// 인코딩 키(이미 %XX 포함)는 그대로, 디코딩 키는 인코딩해서 사용합니다.
function svcKey() {
  return /%[0-9A-Fa-f]{2}/.test(KEY) ? KEY : encodeURIComponent(KEY);
}

// "20260520" · "2026.05.20" · "2026/05/20" → "2026-05-20"
function normDate(v) {
  if (!v) return "";
  const digits = String(v).replace(/[^0-9]/g, "");
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return String(v).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "cheongyak-dashboard" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const sinceStr = new Date(today.getTime() - LOOKBACK_DAYS * 86400000)
  .toISOString()
  .slice(0, 10);

/* ============================================================
   1) 청약홈 — odcloud 자동변환 API
   응답: { data: [ {...} ], totalCount, ... }
   APT 일반 분양과 무순위/잔여세대(줍줍)는 같은 서비스의 다른 엔드포인트.
   ============================================================ */

// APT 일반 분양 (분양주택 + 공공임대 APT)
function mapApplyHome(r) {
  const rent = r.RENT_SECD_NM || r.HOUSE_DTL_SECD_NM || "";
  return {
    source: "청약홈",
    kind: /임대/.test(rent) ? "임대" : "분양",
    name: r.HOUSE_NM || "(이름 없음)",
    region: r.SUBSCRPT_AREA_CODE_NM || "",
    address: r.HSSPLY_ADRES || "",
    noticeDate: normDate(r.RCRIT_PBLANC_DE),       // 모집공고일
    applyStart: normDate(r.RCEPT_BGNDE),           // 청약접수 시작일
    applyEnd: normDate(r.RCEPT_ENDDE),             // 청약접수 종료일
    winnerDate: normDate(r.PRZWNER_PRESNATN_DE),   // 당첨자발표일
    url: r.PBLANC_URL || r.HMPG_ADRES || "",
  };
}

// APT 무순위/잔여세대(줍줍) — 접수일 필드명이 데이터셋마다 달라 후보를 함께 봅니다.
function mapRemndr(r) {
  return {
    source: "청약홈",
    kind: "무순위",
    name: r.HOUSE_NM || "(이름 없음)",
    region: r.SUBSCRPT_AREA_CODE_NM || "",
    address: r.HSSPLY_ADRES || "",
    noticeDate: normDate(r.RCRIT_PBLANC_DE),
    applyStart: normDate(r.SUBSCRPT_RCEPT_BGNDE || r.RCEPT_BGNDE),
    applyEnd: normDate(r.SUBSCRPT_RCEPT_ENDDE || r.RCEPT_ENDDE),
    winnerDate: normDate(r.PRZWNER_PRESNATN_DE),
    url: r.PBLANC_URL || r.HMPG_ADRES || "",
  };
}

// odcloud 엔드포인트를 페이지 단위로 모두 받아옵니다.
async function fetchOdcloudPages(endpoint, mapper, useCond) {
  const base = `https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/${endpoint}`;
  // cond[RCRIT_PBLANC_DE::GTE]=날짜  → 최근 모집공고만 (URL 인코딩 형태)
  const cond = useCond
    ? `&cond%5BRCRIT_PBLANC_DE%3A%3AGTE%5D=${sinceStr}`
    : "";

  const rows = [];
  for (let page = 1; page <= 5; page++) {
    const url =
      `${base}?page=${page}&perPage=100${cond}&serviceKey=${svcKey()}`;
    const json = await getJson(url);
    const data = json && json.data;
    if (!Array.isArray(data)) {
      if (page === 1) throw new Error(json?.message || json?.msg || "예상치 못한 응답");
      break;
    }
    rows.push(...data);
    if (data.length < 100) break;
    await sleep(250);
  }
  return rows.map(mapper);
}

// cond 필터가 막히는 환경을 대비해 전체 조회로 한 번 더 시도합니다.
async function fetchOdcloud(endpoint, mapper) {
  try {
    return await fetchOdcloudPages(endpoint, mapper, true);   // 날짜 필터 사용
  } catch (e) {
    return await fetchOdcloudPages(endpoint, mapper, false);  // 전체 조회로 폴백
  }
}

const fetchApplyHome = () => fetchOdcloud("getAPTLttotPblancDetail", mapApplyHome);
const fetchRemndr = () => fetchOdcloud("getRemndrLttotPblancDetail", mapRemndr);

/* ============================================================
   2) LH — 분양임대공고문
   응답: [ { resHeader:[...] }, { dsList:[...] } ] 형태
   ※ LH API 필드명은 변경 가능성이 있어 여러 후보를 함께 봅니다.
   ============================================================ */
function absLhUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `https://apply.lh.or.kr${u}`;
  return u;
}

function mapLh(r) {
  const type = r.AIS_TP_CD_NM || r.UPP_AIS_TP_NM || r.PAN_NM || "";
  return {
    source: "LH",
    kind: /분양/.test(type) && !/임대/.test(type) ? "분양" : "임대",
    name: r.PAN_NM || "(이름 없음)",
    region: r.CNP_CD_NM || r.AISTC || "",
    address: "",
    noticeDate: normDate(r.PAN_NT_ST_DT || r.PAN_DT),   // 공고게시일
    applyStart: "",
    applyEnd: normDate(r.CLSG_DT),                      // 접수마감일
    winnerDate: "",
    url: absLhUrl(r.DTL_URL || r.AHFL_URL || ""),
  };
}

async function fetchLh() {
  const base =
    "http://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1";
  const url = `${base}?serviceKey=${svcKey()}&PG_SZ=100&PAGE=1`;
  const json = await getJson(url);

  // 응답 구조에서 dsList(공고 목록)와 resHeader(처리결과) 추출
  let list = [];
  let header = null;
  if (Array.isArray(json)) {
    list = json.find((p) => Array.isArray(p?.dsList))?.dsList || [];
    header = json.find((p) => p?.resHeader)?.resHeader;
  } else if (json && typeof json === "object") {
    list = Array.isArray(json.dsList) ? json.dsList : [];
    header = json.resHeader;
  }

  const rc = Array.isArray(header) ? header[0]?.RS_CD : header?.RS_CD;
  if (rc && rc !== "00") {
    const rn = Array.isArray(header) ? header[0]?.RS_NM : header?.RS_NM;
    throw new Error(rn || `LH 응답코드 ${rc}`);
  }
  if (!Array.isArray(list)) throw new Error("예상치 못한 응답");

  return list.map(mapLh);
}

/* ---------- 상태 판정 / 정렬 ---------- */
function statusOf(n) {
  if (n.applyStart && todayStr < n.applyStart) return "예정";
  if (n.applyEnd && todayStr > n.applyEnd) return "마감";
  if (n.applyStart || n.applyEnd) return "접수중";
  return "공고중";
}

const RANK = { 접수중: 0, 예정: 1, 공고중: 2, 마감: 3 };

function sortNotices(a, b) {
  const ra = RANK[statusOf(a)];
  const rb = RANK[statusOf(b)];
  if (ra !== rb) return ra - rb;
  const ka = a.applyEnd || a.noticeDate || "";
  const kb = b.applyEnd || b.noticeDate || "";
  // 접수중·예정은 마감 임박 순, 그 외는 최신 공고 순
  return ra <= 1 ? ka.localeCompare(kb) : kb.localeCompare(ka);
}

/* ---------- 메인 ---------- */
async function main() {
  const sources = {};
  let notices = [];

  const jobs = [
    ["청약홈", fetchApplyHome],
    ["줍줍", fetchRemndr],
    ["LH", fetchLh],
  ];

  for (const [name, fn] of jobs) {
    if (!KEY) {
      sources[name] = { ok: false, error: "인증키 미설정" };
      console.log(`SKIP  ${name}  — DATA_GO_KR_KEY 환경변수 없음`);
      continue;
    }
    try {
      const got = await fn();
      notices.push(...got);
      sources[name] = { ok: true, count: got.length };
      console.log(`OK    ${name}  ${got.length}건`);
    } catch (e) {
      sources[name] = { ok: false, error: String(e.message || e) };
      console.log(`FAIL  ${name}  ${e.message || e}`);
    }
  }

  // 최근 모집공고이거나 접수가 아직 끝나지 않은 공고만, 정렬 후 상한 적용
  notices = notices
    .filter((n) => {
      const recent = n.noticeDate && n.noticeDate >= sinceStr;
      const open = n.applyEnd && n.applyEnd >= todayStr;
      return recent || open;
    })
    .sort(sortNotices)
    .slice(0, MAX_NOTICES);

  return { updatedAt: new Date().toISOString(), sources, notices };
}

let out;
try {
  out = await main();
} catch (e) {
  // 예기치 못한 오류 — 빈 결과라도 파일은 남겨 배포가 끊기지 않게 함
  console.log(`ERROR ${e.message || e}`);
  out = {
    updatedAt: new Date().toISOString(),
    sources: { _: { ok: false, error: String(e.message || e) } },
    notices: [],
  };
}

await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`\ncheongyak.json 작성 완료 — ${out.notices.length}건`);
