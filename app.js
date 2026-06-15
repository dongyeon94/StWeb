// ============================================================
//  관심 대시보드 — 동작 로직
//
//  portfolio.json (종목 설정) + data.json (GitHub Actions가 받아둔 시세)
//  를 읽어 화면을 그립니다. 둘 다 같은 출처라 CORS 가 없습니다.
//
//  종목에 "group" 값을 주면 그룹별 탭으로 분리됩니다. (예: "월배당")
// ============================================================

const $ = (sel) => document.querySelector(sel);

const DEFAULT_GROUP = "일반";    // group 이 없는 보유 종목이 들어갈 기본 그룹
const WATCH_TAB = "관심그룹";     // 직접 고른 관심 종목만 모아 보는 탭
const CHEONGYAK_TAB = "🏠 청약";  // 부동산 청약 일정 탭
const TEST_TAB = "🧪 테스트";     // 구글 시트 거래내역 확인용 임시 탭

// 관심그룹 안에서 종목을 묶는 분류 — 이 순서대로 섹션·바로가기가 표시됩니다.
const WATCH_KINDS = ["통화", "지수", "주식", "코인"];
// 관심그룹 중 일봉(전일 대비)으로 등락을 볼 분류. 나머지는 주봉(주간 대비).
const WATCH_DAILY_KINDS = ["주식", "코인"];
const SECTOR_SECTION = "섹터";   // 관심그룹 맨 아래에 들어가는 섹터 분류 표

let portfolioCache = null;
let entries = [];      // 보유 종목 [{ group, cardHtml, summaryRow|null }]
let watchEntries = []; // 관심 종목 [{ kind, cardHtml }]
let sectorGroups = []; // 섹터별 미니 카드 [{ name, cardsHtml, count }]
let tabOrder = [];     // [WATCH_TAB, ...그룹들, CHEONGYAK_TAB]
let currentTab = WATCH_TAB;
let cheongyak = null;       // cheongyak.json 내용 (또는 { __error })
let sheets = null;          // sheets.json 내용 (또는 { __error })
let testReport = null;      // 거래내역으로 계산한 현재 보유·손익 리포트 (load 시 계산)
let stockStatusText = "";   // 주식 탭에서 보여줄 상태줄 텍스트
let groupNotes = {};        // { 그룹명: "탭 상단에 띄울 메모 (인라인 **bold** 지원)" }
let secretUnlocked = false; // 히든 — '전체 수익' 박스 길게 누르면 수익률 시크릿 토글

/* ---------- 숫자 포맷 ---------- */
function fmtCurrency(value, currency) {
  try {
    return new Intl.NumberFormat("ko-KR", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "KRW" ? 0 : 2,
    }).format(value);
  } catch {
    return Math.round(value).toLocaleString("ko-KR");
  }
}

const fmtPct = (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const dirClass = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");

/* ---------- JSON 로드 (캐시 우회) ---------- */
async function loadJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} — HTTP ${res.status}`);
  return res.json();
}

/* ---------- 시세 (현재가 · 등락) ---------- */
// mul: 표시 배율 (예: 100엔 기준으로 보려면 100). 등락률은 배율과 무관합니다.
function quoteOf(q, mul = 1) {
  const price = q.price * mul;
  const prevClose = (typeof q.prevClose === "number" ? q.prevClose : q.price) * mul;
  const change = price - prevClose;
  return {
    price,
    prevClose,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : 0,
    currency: q.currency || "USD",
    closes: (Array.isArray(q.closes) ? q.closes : []).map((v) => v * mul),
  };
}

/* ---------- 보유 종목 손익 계산 ---------- */
function computeQuote(holding, q) {
  const c = quoteOf(q);
  const value = c.price * holding.quantity;
  const cost = holding.buyPrice * holding.quantity;
  return {
    ...c,
    value,
    cost,
    pnl: value - cost,
    pnlPct: holding.buyPrice ? (c.price / holding.buyPrice - 1) * 100 : 0,
  };
}

/* ---------- 미니 차트 (SVG 스파크라인) ---------- */
function sparkline(closes) {
  if (closes.length < 2) return '<div class="spark"></div>';

  const w = 100, h = 42, pad = 3;
  const min = Math.min(...closes), max = Math.max(...closes);
  const span = max - min || 1;

  const pts = closes.map((v, i) => {
    const x = pad + (i / (closes.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const cls = closes[closes.length - 1] >= closes[0] ? "spark-up" : "spark-down";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline class="${cls}" points="${pts.join(" ")}"
      fill="none" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* ---------- 카드 렌더링 ---------- */
function renderCard(holding, c) {
  const arrow = c.change > 0 ? "▲" : c.change < 0 ? "▼" : "■";
  return `
  <article class="card">
    <div class="card-head">
      <div>
        <h2>${holding.name}</h2>
        <span class="ticker">${holding.ticker}</span>
      </div>
      <div class="price">
        ${fmtCurrency(c.price, c.currency)}
        <span class="change ${dirClass(c.change)}">${arrow} ${fmtPct(c.changePct)}</span>
      </div>
    </div>
    ${sparkline(c.closes)}
    <dl class="stats">
      <div><dt>보유</dt><dd>${holding.quantity}주 · 평단 ${fmtCurrency(holding.buyPrice, c.currency)}</dd></div>
      <div><dt>평가액</dt><dd>${fmtCurrency(c.value, c.currency)}</dd></div>
      <div class="pnl"><dt>평가손익</dt>
        <dd class="${dirClass(c.pnl)}">${fmtCurrency(c.pnl, c.currency)} (${fmtPct(c.pnlPct)})</dd>
      </div>
    </dl>
  </article>`;
}

function renderError(holding, msg) {
  return `
  <article class="card card-error">
    <div class="card-head">
      <div><h2>${holding.name}</h2><span class="ticker">${holding.ticker}</span></div>
    </div>
    <p class="err-msg">시세를 불러오지 못했습니다<br><small>${msg}</small></p>
  </article>`;
}

/* ---------- 관심 종목 카드 ---------- */
// 지수·환율은 통화 기호 없이 숫자만, 주식·코인은 통화 기호와 함께 표시합니다.
function fmtWatchPrice(value, kind, currency) {
  if (kind === "지수" || kind === "통화") {
    return value.toLocaleString("ko-KR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return fmtCurrency(value, currency);
}

function renderWatchCard(item, c, weekly = false) {
  const arrow = c.change > 0 ? "▲" : c.change < 0 ? "▼" : "■";
  const kind = item.kind;
  const changeStr =
    (c.change > 0 ? "+" : "") + fmtWatchPrice(c.change, kind, c.currency);
  const prevLabel = weekly ? "1주일 전" : "전일 종가";
  const changeLabel = weekly ? "주간 대비" : "전일 대비";
  const periodBadge = weekly
    ? `<span class="period-badge">주간</span>` : "";
  return `
  <article class="card">
    <div class="card-head">
      <div>
        <h2>${esc(item.name)}</h2>
        <span class="ticker">${esc(item.ticker)}</span>
      </div>
      <div class="price">
        ${fmtWatchPrice(c.price, kind, c.currency)}
        <span class="change ${dirClass(c.change)}">${arrow} ${fmtPct(c.changePct)}${periodBadge}</span>
      </div>
    </div>
    ${sparkline(c.closes)}
    <dl class="stats">
      <div><dt>${prevLabel}</dt><dd>${fmtWatchPrice(c.prevClose, kind, c.currency)}</dd></div>
      <div><dt>${changeLabel}</dt>
        <dd class="${dirClass(c.change)}">${changeStr}</dd>
      </div>
    </dl>
  </article>`;
}

/* ---------- 통화별 요약 ---------- */
function renderSummary(rows) {
  const byCur = {};
  for (const r of rows) {
    const c = (byCur[r.currency] ||= { value: 0, cost: 0, pnl: 0 });
    c.value += r.value; c.cost += r.cost; c.pnl += r.pnl;
  }
  return Object.entries(byCur)
    .map(([cur, t]) => {
      const pct = t.cost ? (t.pnl / t.cost) * 100 : 0;
      return `
      <div class="sum-box">
        <span class="sum-label">${cur === "KRW" ? "원화 자산" : cur + " 자산"}</span>
        <span class="sum-value">${fmtCurrency(t.value, cur)}</span>
        <span class="sum-pnl ${dirClass(t.pnl)}">${fmtCurrency(t.pnl, cur)} (${fmtPct(pct)})</span>
      </div>`;
    })
    .join("");
}

/* ---------- 탭 ---------- */
function renderTabs() {
  const count = (name) =>
    name === WATCH_TAB ? watchEntries.length
    : name === CHEONGYAK_TAB ? (cheongyak?.notices?.length || 0)
    : name === TEST_TAB ? (testReport?.sections?.length || 0)
    : entries.filter((e) => e.group === name).length;

  $("#tabs").innerHTML = tabOrder
    .map(
      (name) => `<button type="button" class="tab" data-tab="${name}">
        ${name}<span class="tab-count">${count(name)}</span></button>`
    )
    .join("");

  $("#tabs")
    .querySelectorAll(".tab")
    .forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
}

function selectTab(name) {
  currentTab = name;

  $("#tabs")
    .querySelectorAll(".tab")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));

  if (name === CHEONGYAK_TAB) {
    renderCheongyak();
    return;
  }
  if (name === TEST_TAB) {
    renderTest();
    return;
  }
  if (name === WATCH_TAB) {
    renderWatchlist();
    return;
  }

  $("#status").textContent = stockStatusText;

  const shown = entries.filter((e) => e.group === name);

  const noteHtml = renderGroupNote(groupNotes[name]);
  $("#grid").innerHTML = noteHtml + (shown.length
    ? shown.map((e) => e.cardHtml).join("")
    : '<p class="empty-msg">이 탭에 표시할 종목이 없습니다.</p>');

  $("#summary").innerHTML = renderSummary(
    shown.map((e) => e.summaryRow).filter(Boolean)
  );
}

/* ---------- 섹터 미니 카드 ---------- */
// 섹터 영역에 들어가는 작은 카드 — 일반 카드의 약 절반 크기.
function renderMiniCard(item, c) {
  const arrow = c.change > 0 ? "▲" : c.change < 0 ? "▼" : "■";
  const showTicker = item.name !== item.ticker;   // 미국 종목은 이름=티커라 생략
  return `
  <article class="card card-mini">
    <div class="mini-head">
      ${item.cat ? `<span class="mini-cat">${esc(item.cat)}</span>` : ""}
      <h2 class="mini-name">${esc(item.name)}</h2>
      ${showTicker ? `<span class="ticker">${esc(item.ticker)}</span>` : ""}
    </div>
    <div class="mini-price">
      <span>${fmtCurrency(c.price, c.currency)}</span>
      <span class="change ${dirClass(c.change)}">${arrow} ${fmtPct(c.changePct)}</span>
    </div>
    ${sparkline(c.closes)}
  </article>`;
}

function renderMiniError(item, msg) {
  return `
  <article class="card card-mini card-error">
    <div class="mini-head">
      ${item.cat ? `<span class="mini-cat">${esc(item.cat)}</span>` : ""}
      <h2 class="mini-name">${esc(item.name)}</h2>
      <span class="ticker">${esc(item.ticker || "")}</span>
    </div>
    <p class="mini-err">시세 없음<br><small>${esc(msg)}</small></p>
  </article>`;
}

/* ---------- 관심그룹 탭 ---------- */
// 보유 종목 탭과 달리 자산 요약이 없고, 분류(통화·지수·주식·코인)별 카드 섹션과
// 맨 아래 섹터 영역(섹터별 미니 카드)으로 구성됩니다. 섹션 위에는 바로가기 바를 둡니다.
function renderWatchlist() {
  $("#status").textContent = stockStatusText;
  $("#summary").innerHTML = "";

  const byKind = {};
  for (const e of watchEntries) (byKind[e.kind] ||= []).push(e);

  // 정해진 분류(통화·지수·주식·코인)를 먼저, 그 밖의 분류는 뒤에 붙입니다.
  const kinds = [
    ...WATCH_KINDS.filter((k) => byKind[k]),
    ...Object.keys(byKind).filter((k) => !WATCH_KINDS.includes(k)),
  ];

  if (!kinds.length && !sectorGroups.length) {
    $("#grid").innerHTML =
      '<p class="empty-msg">관심그룹에 종목이 없습니다 — portfolio.json 의 watchlist 를 편집하세요.</p>';
    return;
  }

  // 카드 분류들 + (섹터가 있으면) 섹터 — 바로가기 바와 섹션을 함께 만듭니다.
  const navKeys = sectorGroups.length ? [...kinds, SECTOR_SECTION] : kinds;
  const sectorCount = sectorGroups.reduce((s, g) => s + g.count, 0);
  const navCount = (k) =>
    k === SECTOR_SECTION ? sectorCount : byKind[k].length;

  const nav = `<nav class="watch-nav">${navKeys
    .map(
      (k) =>
        `<button type="button" class="watch-nav-btn" data-kind="${esc(k)}">` +
        `${esc(k)}<span class="watch-nav-count">${navCount(k)}</span></button>`
    )
    .join("")}</nav>`;

  let sections = kinds
    .map(
      (k) =>
        `<h3 class="watch-section" id="watch-sec-${esc(k)}">${esc(k)}</h3>` +
        byKind[k].map((e) => e.cardHtml).join("")
    )
    .join("");

  if (sectorGroups.length) {
    sections +=
      `<h3 class="watch-section" id="watch-sec-${esc(SECTOR_SECTION)}">` +
      `${esc(SECTOR_SECTION)}<span class="sec-hint">주간 추이</span></h3>` +
      sectorGroups
        .map(
          (g) =>
            `<div class="sector-group">` +
            `<h4 class="sector-name">${esc(g.name)}</h4>` +
            `<div class="mini-grid">${g.cardsHtml}</div>` +
            `</div>`
        )
        .join("");
  }

  $("#grid").innerHTML = nav + sections;

  // 바로가기 클릭 → 해당 섹션으로 부드럽게 스크롤
  $("#grid")
    .querySelectorAll(".watch-nav-btn")
    .forEach((b) =>
      b.addEventListener("click", () => {
        document
          .getElementById("watch-sec-" + b.dataset.kind)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );
}

/* ============================================================
   청약 일정  (cheongyak.json — GitHub Actions가 공공데이터에서 수집)
   ============================================================ */

// 외부 API 에서 온 데이터이므로 HTML 삽입 전 반드시 이스케이프합니다.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

// 그룹 탭 상단 메모 — `**bold**` 만 강조로 변환. 그 외는 평문.
function renderGroupNote(text) {
  if (!text) return "";
  const html = esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return `<p class="group-note">${html}</p>`;
}

// 공고 상세 URL — 개별 링크가 없으면 출처 사이트로 연결해 버튼이 항상 동작하게 함
function noticeUrl(n) {
  return (
    safeUrl(n.url) ||
    (n.source === "LH"
      ? "https://apply.lh.or.kr"
      : n.source === "SH"
      ? "https://housing.seoul.go.kr/site/main/sh/publicSale/01/list"
      : "https://www.applyhome.co.kr")
  );
}

const SH_SALE_URL = "https://housing.seoul.go.kr/site/main/sh/publicSale/01/list";

const ymd = (s) => (s ? esc(s).slice(2).replace(/-/g, ".") : "—"); // 2026-05-20 → 26.05.20
const md  = (s) => (s ? esc(s).slice(5).replace(/-/g, ".") : "");   // 2026-05-20 → 05.20

const STATUS_KEY = { 접수중: "open", 예정: "soon", 공고중: "posted", 마감: "closed" };
const KIND_KEY   = { 분양: "sale", 임대: "rent", 무순위: "extra" };
const SRC_KEY    = { LH: "lh", 청약홈: "home", SH: "sh" };

function cheongyakStatus(n) {
  const today = new Date().toISOString().slice(0, 10);
  if (n.applyStart && today < n.applyStart) return "예정";
  if (n.applyEnd && today > n.applyEnd) return "마감";
  if (n.applyStart || n.applyEnd) return "접수중";
  return "공고중";
}

// 기준일까지 남은 일수 (오늘=0, 지난 날짜는 음수)
function dday(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + "T00:00:00");
  if (isNaN(target)) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}

function noticeMsg(title, sub) {
  return `<article class="card card-error">
    <p class="err-msg">${esc(title)}${sub ? `<br><small>${esc(sub)}</small>` : ""}</p>
  </article>`;
}

function renderNoticeCard(n) {
  const status = cheongyakStatus(n);
  const sk = STATUS_KEY[status] || "posted";
  const src = SRC_KEY[n.source] || "etc";

  // 배지: 접수중이면 마감까지, 예정이면 접수시작까지 D-day
  let badge = status;
  const dRef =
    status === "예정" ? n.applyStart : status === "접수중" ? n.applyEnd : "";
  const d = dRef ? dday(dRef) : null;
  if (d !== null && d >= 0) {
    badge =
      status === "예정" ? `D-${d} 접수시작`
      : d === 0 ? "오늘 마감"
      : `D-${d} 마감`;
  }

  const apply =
    n.applyStart || n.applyEnd
      ? `${md(n.applyStart) || "?"} ~ ${md(n.applyEnd) || "?"}`
      : "—";
  const loc = [n.region, n.address].filter(Boolean).join(" · ");

  return `
  <article class="card notice cy-${sk} src-${src}">
    <div class="notice-top">
      <span class="chip chip-src chip-src-${src}">${esc(n.source || "")}</span>
      <span class="chip chip-${KIND_KEY[n.kind] || "sale"}">${esc(n.kind || "")}</span>
      <span class="cy-badge cy-badge-${sk}">${esc(badge)}</span>
    </div>
    <h2 class="notice-name">${esc(n.name || "(이름 없음)")}</h2>
    ${loc ? `<p class="notice-loc">📍 ${esc(loc)}</p>` : ""}
    <dl class="notice-dates">
      <div><dt>모집공고</dt><dd>${ymd(n.noticeDate)}</dd></div>
      <div><dt>청약접수</dt><dd>${apply}</dd></div>
      <div><dt>당첨발표</dt><dd>${ymd(n.winnerDate)}</dd></div>
    </dl>
    <a class="notice-btn" href="${esc(noticeUrl(n))}" target="_blank" rel="noopener noreferrer">
      상세 보기 →
    </a>
  </article>`;
}

function renderCheongyak() {
  const c = cheongyak;
  const grid = $("#grid");
  const summary = $("#summary");
  const status = $("#status");

  // cheongyak.json 자체를 못 불러온 경우
  if (!c || c.__error) {
    summary.innerHTML = "";
    status.textContent = "청약 일정 불러오기 실패";
    grid.innerHTML = noticeMsg(
      "청약 일정을 불러오지 못했습니다",
      (c && c.__error) ||
        "cheongyak.json 이 없습니다 — GitHub Actions가 아직 실행되지 않았을 수 있습니다."
    );
    return;
  }

  const notices = Array.isArray(c.notices) ? c.notices : [];
  const srcVals = c.sources ? Object.values(c.sources) : [];
  const noKey =
    srcVals.length > 0 &&
    srcVals.every((s) => !s.ok) &&
    srcVals.some((s) => /인증키/.test(s.error || ""));

  status.textContent = c.updatedAt
    ? `청약 일정 기준: ${new Date(c.updatedAt).toLocaleString("ko-KR")}`
    : "청약 일정 — 아직 수집되지 않음";

  // SH(서울주택도시공사) 분양 — 불러오기 실패 시 최상단에 안내 배너만 표시
  const shSrc = c.sources && c.sources.SH;
  const shBanner =
    shSrc && !shSrc.ok && !/인증키/.test(shSrc.error || "")
      ? `<p class="sh-banner">⚠️ SH(서울주택도시공사) 분양 정보를 불러오지 못했습니다
          — <a href="${SH_SALE_URL}" target="_blank" rel="noopener noreferrer">서울주거포털에서 직접 확인 →</a></p>`
      : "";

  if (!notices.length) {
    summary.innerHTML = "";
    grid.innerHTML = shBanner + (
      !c.updatedAt
      ? noticeMsg(
          "청약 일정이 아직 수집되지 않았습니다",
          "GitHub Actions의 '청약 일정 받기' 단계가 실행되면 표시됩니다."
        )
      : noKey
      ? noticeMsg(
          "청약 API 인증키가 설정되지 않았습니다",
          "data.go.kr 인증키를 저장소 Secret(DATA_GO_KR_KEY)에 등록하세요. README 참고."
        )
      : noticeMsg("표시할 청약 공고가 없습니다", ""));
    return;
  }

  // 임대(LH 등) 공고는 조건상 해당 없음 — 카드·집계에서 모두 제외
  const eligible = notices.filter((n) => n.kind !== "임대");

  // 상태별 요약 (마감 카운트는 안내용으로만 노출, 카드는 숨김)
  const tally = { 접수중: 0, 예정: 0, 공고중: 0, 마감: 0 };
  eligible.forEach((n) => {
    tally[cheongyakStatus(n)]++;
  });
  const activeNotices = eligible.filter((n) => cheongyakStatus(n) !== "마감");

  // 신청시작 가장 빠른 공고 — 오늘 이후 applyStart 중 최솟값
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = activeNotices
    .filter((n) => n.applyStart && n.applyStart >= today)
    .sort((a, b) => a.applyStart.localeCompare(b.applyStart))[0];

  let nextBox = "";
  if (upcoming) {
    const d = dday(upcoming.applyStart);
    const dStr = d === 0 ? "오늘 시작" : d > 0 ? `D-${d}` : "";
    nextBox = `
      <div class="sum-box sum-next">
        <span class="sum-label">신청시작 가장 빠름 · ${esc(upcoming.source || "")}</span>
        <span class="sum-value">${dStr} <small>${ymd(upcoming.applyStart)}</small></span>
        <span class="sum-pnl">${esc(upcoming.name || "")}</span>
      </div>`;
  }

  const closedNote = tally.마감 ? ` · 마감 ${tally.마감} 숨김` : "";
  summary.innerHTML = `
    <div class="sum-box">
      <span class="sum-label">청약 공고</span>
      <span class="sum-value">${activeNotices.length}건</span>
      <span class="sum-pnl">접수중 ${tally.접수중} · 예정 ${tally.예정} · 공고중 ${tally.공고중}${closedNote}</span>
    </div>${nextBox}`;

  // 일부 출처만 실패한 경우 경고 한 줄 (SH 는 위 전용 배너로 따로 안내)
  const failed = c.sources
    ? Object.entries(c.sources).filter(
        ([k, s]) => !s.ok && !/인증키/.test(s.error || "") && k !== "SH"
      )
    : [];
  const warn = failed.length
    ? `<p class="empty-msg">⚠ ${failed
        .map(([k, s]) => `${esc(k)} 불러오기 실패 (${esc(s.error || "")})`)
        .join(" · ")}</p>`
    : "";

  grid.innerHTML = activeNotices.length
    ? shBanner + warn + activeNotices.map(renderNoticeCard).join("")
    : shBanner + warn + noticeMsg("표시할 청약 공고가 없습니다", tally.마감 ? `마감된 공고 ${tally.마감}건만 있어 모두 숨김` : "");
}

/* ============================================================
   테스트 탭 — 구글 시트 거래내역으로 현재 보유·손익 계산
   ============================================================ */

const txNum = (v) => {
  if (v == null) return 0;
  const c = String(v).replace(/[₩,\s]/g, "");
  const n = parseFloat(c);
  return Number.isFinite(n) ? n : 0;
};

// 한 계좌(거래내역 탭)를 시간순으로 누적해서 보유 포지션과 현금흐름을 구합니다.
// - 현재 수량은 시트의 '잔고'(브로커 보유 수량)가 권위. 거래 replay 는 평단 산출용.
//   (대체입출고·타사대체·액면병합 등으로 replay 수량이 어긋나도 잔고가 실제 보유.)
// - 평단(원화) = replay 누적 원가 / replay 누적 수량 → 잔고 수량에 곱해 보유 원가 산출.
// - 해외 거래(상세내용에 '외화'·'해외')는 정산금액·단가가 외화(USD/JPY)라, 행의 'USD'/'JPY'
//   환율 열로 원화 환산해 원가에 반영. 환율 변동까지 원가에 녹습니다.
// - 종목 통화는 currencyOf(종목명) 으로 판별 (필요 티커 탭의 국가 열·티커 .T 접미사 기준,
//   모르면 USD 가정). 미국주는 USD 열, 일본주는 JPY 열을 사용.
function accumulateAccount(txs, currencyOf) {
  const headers = Array.isArray(txs?.headers) ? txs.headers : [];
  const rows = Array.isArray(txs?.rows) ? txs.rows : [];
  const idx = {
    type: headers.indexOf("거래유형"),
    detail: headers.indexOf("상세내용"),
    name: headers.indexOf("종목명"),
    qty: headers.indexOf("수량"),
    price: headers.indexOf("단가"),
    // '정산금액' 이 여러 개면 마지막을 사용
    amount: headers.lastIndexOf("정산금액"),
    bal: headers.indexOf("잔고"),  // 종목별 브로커 보유 잔고 (현재 수량의 권위)
    usd: headers.indexOf("USD"),   // 행별 USD/KRW 환율 (없으면 -1)
    jpy: headers.indexOf("JPY"),   // 행별 JPY/KRW 환율 (없으면 -1)
    date: headers.indexOf("실거래일자"),   // 현금흐름 날짜 (IRR용)
    cash: headers.indexOf("예수금잔액"),   // 계좌 예수금 잔고 (현재가치 = 평가액 + 예수금)
  };

  const replay = new Map();      // 종목명 → { qty, totalCostKrw } (평단 산출용)
  const latestBal = new Map();   // 종목명 → 최신 잔고 (수량 있는 행 기준)
  const flows = [];              // IRR용 외부 현금흐름 [{ date:'2021.02.16', krw }] 입금 −, 출금 +
  let cashBalance = null;        // 최신 예수금잔액 (시트 최상단=가장 최근 행)
  let cashIn = 0, cashOut = 0, dividends = 0, realized = 0;
  if (!headers.length)
    return { positions: new Map(), flows, cashBalance, cashIn, cashOut, dividends, realized };
  // 시트 최상단(가장 최근)부터 첫 유효 예수금잔액을 현재 예수금으로 사용
  if (idx.cash >= 0) {
    for (const r of rows) {
      const v = txNum(r[idx.cash]);
      if (r[idx.cash] != null && String(r[idx.cash]).trim() !== "") { cashBalance = v; break; }
    }
  }

  // 시트는 최신순. 시간순 누적을 위해 뒤집어서 순회 → 마지막에 쓴 잔고가 최신.
  for (const r of [...rows].reverse()) {
    const type = (r[idx.type] || "").trim();
    const detail = (r[idx.detail] || "").trim();
    const name = (r[idx.name] || "").trim();
    const qty = txNum(r[idx.qty]);
    if (name && qty !== 0 && idx.bal >= 0) latestBal.set(name, txNum(r[idx.bal]));

    // 해외(외화) 거래면 정산금액·단가를 종목 통화의 행별 환율로 원화 환산
    const isForeign = /외화|해외/.test(detail);
    let fx = 1;
    if (isForeign) {
      const cur = (currencyOf && currencyOf(name)) || "USD";
      const col = cur === "JPY" ? idx.jpy : idx.usd;
      const rate = col >= 0 ? txNum(r[col]) : 0;
      if (rate > 0) fx = rate;
    }
    const amtKrw = txNum(r[idx.amount]) * fx;            // 정산금액(원화 환산)
    const unitKrw = txNum(r[idx.price]) * fx;            // 단가(원화 환산)

    const sellFrom = (p, q) => {                          // 평단 유지하며 수량 차감
      const avg = p.totalCostKrw / p.qty;
      const sq = Math.min(q, p.qty);
      p.qty -= sq;
      p.totalCostKrw -= avg * sq;
      if (p.qty < 1e-6) replay.delete(name);
      return { avg, sq };
    };

    const date = idx.date >= 0 ? (r[idx.date] || "").trim() : "";
    if (type === "입금") {
      if (/분배금/.test(detail)) dividends += amtKrw;
      else if (/이체/.test(detail)) {
        cashIn += amtKrw;
        if (date) flows.push({ date, krw: -amtKrw });   // 투자금 유입 = 음수
      }
      // 대체입금·공모주환불금·예탁금이용료·외화단수주매각대금 등은 순 투자금 집계에서 제외
    } else if (type === "출금") {
      if (/이체/.test(detail)) {
        cashOut += amtKrw;
        if (date) flows.push({ date, krw: amtKrw });     // 회수 = 양수
      }
      // 공모주청약수수료 등 그 외 출금은 제외
    } else if (type === "매수" && name && qty > 0) {
      const p = replay.get(name) || { qty: 0, totalCostKrw: 0 };
      p.qty += qty;
      p.totalCostKrw += amtKrw;
      replay.set(name, p);
    } else if (type === "매도" && name && qty > 0) {
      const p = replay.get(name);
      if (!p || p.qty < 1e-6) continue;
      const { avg, sq } = sellFrom(p, qty);
      realized += amtKrw - avg * sq;
    } else if (type === "입고" && isForeign && name && qty > 0) {
      // 외화주식 액면병합 입고 등 — 단가 기준으로 원가 편입
      const p = replay.get(name) || { qty: 0, totalCostKrw: 0 };
      p.qty += qty;
      p.totalCostKrw += unitKrw * qty;
      replay.set(name, p);
    } else if (type === "출고" && isForeign && name && qty > 0) {
      // 외화주식 액면병합 출고 등 — 평단 유지하며 수량만 제거 (매도 손익 아님)
      const p = replay.get(name);
      if (p && p.qty >= 1e-6) sellFrom(p, qty);
    }
    // 환전·대체입출고(국내) 등 그 외는 평가에 영향 없음 — 무시
  }

  // 잔고(권위)로 현재 보유 확정. 평단은 replay 에서 가져와 잔고 수량에 곱함.
  // 잔고 정보가 없는 옛 시트(잔고 열 없음)는 replay 결과를 그대로 사용.
  const positions = new Map();
  if (idx.bal < 0) {
    for (const [name, p] of replay) if (p.qty > 1e-6) positions.set(name, p);
  } else {
    for (const [name, bal] of latestBal) {
      if (!(bal > 1e-6)) continue;            // 잔고 0 이하 = 보유 아님
      const p = replay.get(name);
      const avgUnit = p && p.qty > 1e-6 ? p.totalCostKrw / p.qty : null;
      positions.set(name, {
        qty: bal,
        totalCostKrw: avgUnit != null ? avgUnit * bal : null,
      });
    }
  }
  return { positions, flows, cashBalance, cashIn, cashOut, dividends, realized };
}

// ── IRR (연환산 내부수익률) — 이분법 ──
// flows: [{ t: Date, krw }] 투자금 −, 회수/현재가치 +. 부호 바뀌는 흐름이 있어야 해(I/O 둘 다).
function computeIRR(flows) {
  const valid = flows.filter((f) => f.t instanceof Date && !isNaN(f.t) && f.krw);
  if (valid.length < 2) return null;
  const hasNeg = valid.some((f) => f.krw < 0), hasPos = valid.some((f) => f.krw > 0);
  if (!hasNeg || !hasPos) return null;
  const t0 = Math.min(...valid.map((f) => f.t.getTime()));
  const yr = (f) => (f.t.getTime() - t0) / (365.25 * 24 * 3600 * 1000);
  const npv = (r) => valid.reduce((s, f) => s + f.krw / Math.pow(1 + r, yr(f)), 0);
  let lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) return null;                 // 구간 내 부호 변화 없음 → 해 없음
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1 || hi - lo < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// '2021.02.16' → Date (로컬). 형식 어긋나면 null.
function parseSheetDate(s) {
  const m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec((s || "").trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d) ? null : d;
}

// 종목별 실현손익·배당 (시크릿 '종목당 수익' 표 전용).
// ★ 계좌 손익(accumulateAccount.realized/overall)에는 영향을 주지 않는 독립 계산.
// - 매도는 deferred: 재고 없으면 보류했다가 매수 다 쌓인 뒤 재처리 → 병합(행 순서 꼬임) 교정.
// - 공모주처럼 매수원가 자체가 없는 매도는 끝까지 재고가 없어 자동 제외(패스)되고 orphan 으로 표시.
function perStockReport(txs, currencyOf) {
  const headers = Array.isArray(txs?.headers) ? txs.headers : [];
  const rows = Array.isArray(txs?.rows) ? txs.rows : [];
  const out = new Map();   // 종목명 → { realizedKrw, dividendsKrw, hadSell, orphan }
  if (!headers.length) return out;
  const idx = {
    type: headers.indexOf("거래유형"), detail: headers.indexOf("상세내용"),
    name: headers.indexOf("종목명"), qty: headers.indexOf("수량"),
    price: headers.indexOf("단가"), amount: headers.lastIndexOf("정산금액"),
    usd: headers.indexOf("USD"), jpy: headers.indexOf("JPY"),
  };
  const replay = new Map();
  const get = (n) => {
    let e = out.get(n);
    if (!e) { e = { realizedKrw: 0, dividendsKrw: 0, hadSell: false, orphan: false }; out.set(n, e); }
    return e;
  };
  const doSell = (nm, q, amtKrw) => {
    const p = replay.get(nm);
    if (!p || p.qty < 1e-6) return false;
    const avg = p.totalCostKrw / p.qty;
    const sq = Math.min(q, p.qty);
    p.qty -= sq; p.totalCostKrw -= avg * sq;
    if (p.qty < 1e-6) replay.delete(nm);
    const e = get(nm); e.realizedKrw += amtKrw - avg * sq; e.hadSell = true;
    return true;
  };
  const pending = [];
  for (const r of [...rows].reverse()) {
    const type = (r[idx.type] || "").trim();
    const detail = (r[idx.detail] || "").trim();
    const name = (r[idx.name] || "").trim();
    const qty = txNum(r[idx.qty]);
    const isForeign = /외화|해외/.test(detail);
    let fx = 1;
    if (isForeign) {
      const cur = (currencyOf && currencyOf(name)) || "USD";
      const col = cur === "JPY" ? idx.jpy : idx.usd;
      const rate = col >= 0 ? txNum(r[col]) : 0;
      if (rate > 0) fx = rate;
    }
    const amtKrw = txNum(r[idx.amount]) * fx;
    const unitKrw = txNum(r[idx.price]) * fx;
    if (type === "입금") {
      if (/분배금/.test(detail) && name) get(name).dividendsKrw += amtKrw;
    } else if (type === "매수" && name && qty > 0) {
      const p = replay.get(name) || { qty: 0, totalCostKrw: 0 };
      p.qty += qty; p.totalCostKrw += amtKrw; replay.set(name, p);
    } else if (type === "매도" && name && qty > 0) {
      if (!doSell(name, qty, amtKrw)) pending.push({ name, qty, amtKrw });
    } else if (type === "입고" && isForeign && name && qty > 0) {
      const p = replay.get(name) || { qty: 0, totalCostKrw: 0 };
      p.qty += qty; p.totalCostKrw += unitKrw * qty; replay.set(name, p);
    } else if (type === "출고" && isForeign && name && qty > 0) {
      const p = replay.get(name);
      if (p && p.qty >= 1e-6) {
        const avg = p.totalCostKrw / p.qty, sq = Math.min(qty, p.qty);
        p.qty -= sq; p.totalCostKrw -= avg * sq;
        if (p.qty < 1e-6) replay.delete(name);
      }
    }
  }
  // 보류된 매도 재처리 (병합 등). 끝까지 재고 없으면 공모주 등 → orphan 표시 후 패스.
  for (const ps of pending) if (!doSell(ps.name, ps.qty, ps.amtKrw)) get(ps.name).orphan = true;
  return out;
}

// 시트의 계좌별 거래내역을 누적해서 섹션별 + 종합 손익 리포트를 만듭니다.
// - 종목명→ticker 매핑은 시트의 '필요 티커' 탭이 권위.
// - 매핑이 없는 보유 종목은 평가에서 빼고 '필요 티커' 목록으로 따로 모읍니다.
function buildTestReport(sheetsData, portfolio, data) {
  // sheets.json 구조: { accounts: [{key,label,transactions:{headers,rows}}], tickers: [...] }
  //   하위 호환: 옛 구조({ transactions:{...} } / { headers, rows }) 는 단일 계좌로 처리
  let accounts = Array.isArray(sheetsData?.accounts) ? sheetsData.accounts : null;
  if (!accounts) {
    const txs = sheetsData?.transactions ?? sheetsData;
    if (!Array.isArray(txs?.headers)) return null;
    accounts = [{ key: "계좌", label: "계좌", transactions: txs }];
  }

  // 종목명 → ticker 맵 — '필요 티커' 탭. 비어 있으면 모든 보유가 '필요 티커' 로 빠짐.
  const nameToTicker = new Map();
  const nameToCurrency = new Map();
  for (const t of sheetsData?.tickers || []) {
    if (t.name && t.ticker) nameToTicker.set(t.name, t.ticker);
    if (t.name && t.currency) nameToCurrency.set(t.name, t.currency);
  }

  // 종목 통화 판별 (외화 거래 환율 열 선택용): 필요 티커 탭의 국가 열 > 티커 .T 접미사 > USD
  const currencyOf = (name) => {
    const cur = nameToCurrency.get(name) || "";
    if (/jp|일본|엔|jpy/i.test(cur)) return "JPY";
    if (/us|미국|usd|달러/i.test(cur)) return "USD";
    const tk = nameToTicker.get(name) || "";
    if (/\.(T|JP)$/i.test(tk)) return "JPY";
    return "USD";
  };

  // 외화 → 원화 환산 (watchlist 의 환율 종목에서 자동 조회)
  // 환율 종목(kind:통화)은 주봉으로 수집돼 weekly 에 들어가므로 quotes·weekly 양쪽을 확인.
  const fxQuote = (sym) =>
    data?.quotes?.[sym]?.price || data?.weekly?.[sym]?.price || null;
  const fxRates = {
    USD: fxQuote("KRW=X"),    // USD/KRW
    JPY: fxQuote("JPYKRW=X"), // JPY/KRW
    EUR: fxQuote("EURKRW=X"), // EUR/KRW
  };
  const toKrw = (price, currency) => {
    if (price == null) return null;
    if (currency === "KRW") return price;
    const rate = fxRates[currency];
    return rate ? price * rate : null;
  };

  const sections = [];
  const need = new Map();   // 종목명 → { name, qty, costKrw, accounts:Set }

  // 종합(전체) 집계 누적
  const total = {
    cashIn: 0, cashOut: 0, dividends: 0, realized: 0,
    totalCostKrw: 0, totalEvalKrw: 0, cashBalance: 0,
  };
  const allFlows = [];   // 모든 계좌의 외부 현금흐름 (IRR용)
  const realizedByName = new Map();  // 시크릿 표 전용: 종목 → { realizedKrw, dividendsKrw, hadSell, orphan, accounts:Set }

  for (const acc of accounts) {
    const { positions, flows, cashBalance, cashIn, cashOut, dividends, realized } =
      accumulateAccount(acc.transactions, currencyOf);
    if (Array.isArray(flows)) allFlows.push(...flows);
    if (cashBalance != null) total.cashBalance += cashBalance;

    // 종목별 실현·배당 (독립 계산 — 계좌 손익엔 영향 없음)
    for (const [name, ps] of perStockReport(acc.transactions, currencyOf)) {
      let e = realizedByName.get(name);
      if (!e) { e = { realizedKrw: 0, dividendsKrw: 0, hadSell: false, orphan: false, accounts: new Set() }; realizedByName.set(name, e); }
      e.realizedKrw += ps.realizedKrw;
      e.dividendsKrw += ps.dividendsKrw;
      e.hadSell = e.hadSell || ps.hadSell;
      e.orphan = e.orphan || ps.orphan;
      if (ps.hadSell || ps.dividendsKrw > 0) e.accounts.add(acc.label);
    }

    const heldList = [];
    let secCostKrw = 0, secEvalKrw = 0;

    for (const [name, p] of positions) {
      if (p.qty < 1e-6) continue;
      const ticker = nameToTicker.get(name);
      const costKrw = p.totalCostKrw;                       // null 가능 (평단 미상)
      const avgCostKrw = costKrw != null ? costKrw / p.qty : null;

      if (!ticker) {
        // '필요 티커' 탭에 없는 종목 — 평가는 못 하지만 보유 사실은 보여줌
        const e = need.get(name) || { name, qty: 0, costKrw: 0, accounts: new Set() };
        e.qty += p.qty;
        e.costKrw += costKrw || 0;
        e.accounts.add(acc.label);
        need.set(name, e);
        heldList.push({
          name, ticker: null, qty: p.qty, avgCostKrw, priceKrw: null,
          costKrw, evalKrw: null, pnlKrw: null, pnlPct: null,
        });
        continue;
      }

      const q = data?.quotes?.[ticker];
      const priceKrw = q ? toKrw(q.price, q.currency) : null;
      const evalKrw = priceKrw != null ? priceKrw * p.qty : null;
      const pnlKrw = evalKrw != null && costKrw != null ? evalKrw - costKrw : null;
      const pnlPct = pnlKrw != null && costKrw > 0 ? (pnlKrw / costKrw) * 100 : null;

      heldList.push({
        name, ticker, qty: p.qty, avgCostKrw, priceKrw,
        costKrw, evalKrw, pnlKrw, pnlPct,
      });
      // 원가·평가 모두 알 때만 합산 (한쪽만 알면 수익률이 왜곡되므로 제외)
      if (evalKrw != null && costKrw != null) { secEvalKrw += evalKrw; secCostKrw += costKrw; }
    }

    // 평가액(없으면 매수원가) 큰 순으로 정렬
    heldList.sort((a, b) =>
      (b.evalKrw ?? b.costKrw ?? -Infinity) - (a.evalKrw ?? a.costKrw ?? -Infinity));

    const netCashIn = cashIn - cashOut;
    const unrealizedKrw = secEvalKrw - secCostKrw;
    const gain = realized + dividends + unrealizedKrw;
    const gainPct = netCashIn > 0 ? (gain / netCashIn) * 100 : null;

    sections.push({
      key: acc.key, label: acc.label,
      netCashIn, cashIn, cashOut, dividends, realized,
      unrealizedKrw, totalCostKrw: secCostKrw, totalEvalKrw: secEvalKrw,
      totalGain: gain, totalGainPct: gainPct,
      heldList,
    });

    total.cashIn += cashIn;
    total.cashOut += cashOut;
    total.dividends += dividends;
    total.realized += realized;
    total.totalCostKrw += secCostKrw;
    total.totalEvalKrw += secEvalKrw;
  }

  const netCashIn = total.cashIn - total.cashOut;
  const unrealizedKrw = total.totalEvalKrw - total.totalCostKrw;
  const totalGain = total.realized + total.dividends + unrealizedKrw;
  const totalGainPct = netCashIn > 0 ? (totalGain / netCashIn) * 100 : null;

  // ── 연환산 IRR (시크릿) ──
  // 외부 현금흐름(이체 입·출금) + 현재가치(보유 평가액 + 예수금)로 내부수익률.
  const currentValue = total.totalEvalKrw + total.cashBalance;   // 지금 전부 빼면 받을 돈
  const irrFlows = allFlows
    .map((f) => ({ t: parseSheetDate(f.date), krw: f.krw }))
    .filter((f) => f.t);
  irrFlows.push({ t: new Date(), krw: currentValue });          // 종료 시점 현재가치 (+)
  const irr = computeIRR(irrFlows);                              // 연이율 (예: 0.123 = 12.3%)
  const firstFlow = irrFlows.reduce((m, f) => (f.t < m ? f.t : m), new Date());
  const investYears = (Date.now() - firstFlow.getTime()) / (365.25 * 24 * 3600 * 1000);

  const overall = {
    netCashIn, cashIn: total.cashIn, cashOut: total.cashOut,
    dividends: total.dividends, realized: total.realized,
    unrealizedKrw, totalCostKrw: total.totalCostKrw, totalEvalKrw: total.totalEvalKrw,
    totalGain, totalGainPct,
    cashBalance: total.cashBalance, currentValue,
    irrPct: irr != null ? irr * 100 : null, investYears,
  };

  const needTickers = [...need.values()]
    .map((e) => ({ name: e.name, qty: e.qty, costKrw: e.costKrw, accounts: [...e.accounts] }))
    .sort((a, b) => b.costKrw - a.costKrw);

  // ── 시크릿 — 종목당 수익 (계좌 합산) ──
  // 수익금 = 평가손익(현재 보유) + 실현손익 + 배당금. 판/티커 없는 종목도 실현·배당으로 합류.
  // 공모주(원가 없는 매도 only)는 제외(패스).
  const byNameMap = new Map();
  const getStock = (name, ticker) => {
    let e = byNameMap.get(name);
    if (!e) {
      e = { name, ticker: ticker || nameToTicker.get(name) || null, priceKrw: null,
        qty: 0, costKrw: 0, evalKrw: 0,
        realizedKrw: 0, dividendsKrw: 0, hadSell: false, orphan: false, accounts: new Set() };
      byNameMap.set(name, e);
    }
    return e;
  };
  // 1) 현재 보유분 (평가손익)
  for (const s of sections) {
    for (const h of s.heldList) {
      const e = getStock(h.name, h.ticker);
      if (!e.ticker && h.ticker) e.ticker = h.ticker;
      if (e.priceKrw == null && h.priceKrw != null) e.priceKrw = h.priceKrw;
      e.qty += h.qty;
      if (h.costKrw != null) e.costKrw += h.costKrw;
      if (h.evalKrw != null) e.evalKrw += h.evalKrw;
      e.accounts.add(s.label);
    }
  }
  // 2) 실현손익·배당 (판 종목·티커 없는 종목도 여기서 합류)
  for (const [name, ps] of realizedByName) {
    const e = getStock(name);
    e.realizedKrw += ps.realizedKrw;
    e.dividendsKrw += ps.dividendsKrw;
    e.hadSell = e.hadSell || ps.hadSell;
    e.orphan = e.orphan || ps.orphan;
    for (const a of ps.accounts) e.accounts.add(a);
  }
  const byStock = [...byNameMap.values()].map((e) => {
    const avgCostKrw = e.costKrw > 0 && e.qty > 0 ? e.costKrw / e.qty : null;
    const unrealKrw = e.evalKrw > 0 && e.costKrw > 0 ? e.evalKrw - e.costKrw : null;
    const realizedKrw = e.hadSell ? e.realizedKrw : null;
    const dividendsKrw = e.dividendsKrw > 0 ? e.dividendsKrw : null;
    const has = unrealKrw != null || realizedKrw != null || dividendsKrw != null;
    const profitKrw = has ? (unrealKrw ?? 0) + (realizedKrw ?? 0) + (dividendsKrw ?? 0) : null;
    return {
      name: e.name, ticker: e.ticker, qty: e.qty, avgCostKrw, priceKrw: e.priceKrw,
      costKrw: e.costKrw || null, evalKrw: e.evalKrw || null,
      unrealKrw, realizedKrw, dividendsKrw, profitKrw,
      held: e.qty > 1e-6, sold: e.qty < 1e-6 && e.hadSell,
      accounts: [...e.accounts],
    };
  })
    // 보유도 아니고 실현·배당도 없는(=공모주 orphan only) 종목은 제외
    .filter((h) => h.held || h.realizedKrw != null || h.dividendsKrw != null)
    .sort((a, b) => (b.profitKrw ?? -Infinity) - (a.profitKrw ?? -Infinity));

  return { overall, sections, needTickers, byStock };
}

// 요소를 ms(기본 5초) 이상 길게 누르면 cb 실행 (탭/클릭 실수로는 안 열림)
function attachLongPress(el, cb, ms = 5000) {
  if (!el) return;
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("pointerdown", () => {
    cancel();
    timer = setTimeout(() => { timer = null; cb(); }, ms);
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("contextmenu", (e) => e.preventDefault());  // 길게 눌러도 메뉴 차단
}

// 시크릿 — 전체 수익률 박스 (누적 + 연환산 IRR)
function renderSecretReturns(ov, h) {
  const { fmt, sign, sPct, cls } = h;
  const irrTxt = ov.irrPct == null ? "—" : `연 ${sPct(ov.irrPct)}`;
  const yrs = ov.investYears != null ? ov.investYears.toFixed(1) : "—";
  return `
    <div class="secret-returns">
      <div class="sr-head">🔒 수익률 시크릿 <small>· 박스를 다시 길게 누르면 닫힘</small></div>
      <div class="sr-metrics">
        <div class="sr-metric">
          <span class="sr-k">누적 수익률</span>
          <span class="sr-v ${cls(ov.totalGainPct)}">${sPct(ov.totalGainPct)}</span>
          <span class="sr-sub">총수익 ${sign(ov.totalGain)} ÷ 순입금 ${fmt(ov.netCashIn)}</span>
        </div>
        <div class="sr-metric">
          <span class="sr-k">연환산 (IRR)</span>
          <span class="sr-v ${cls(ov.irrPct)}">${irrTxt}</span>
          <span class="sr-sub">투자기간 약 ${yrs}년 · 입·출금 타이밍 반영</span>
        </div>
      </div>
      <div class="sr-foot">현재가치 ${fmt(ov.currentValue)} = 평가액 ${fmt(ov.totalEvalKrw)} + 예수금 ${fmt(ov.cashBalance)}</div>
    </div>`;
}

function renderTest() {
  const grid = $("#grid");
  const summary = $("#summary");
  const status = $("#status");

  if (!sheets || sheets.__error) {
    summary.innerHTML = "";
    status.textContent = "구글 시트 불러오기 실패";
    grid.innerHTML = `<article class="card card-error">
      <p class="err-msg">구글 시트 데이터를 불러오지 못했습니다<br>
        <small>${esc((sheets && sheets.__error) || "sheets.json 없음 — GitHub Actions 가 아직 실행되지 않았을 수 있습니다.")}</small>
      </p>
    </article>`;
    return;
  }
  if (!testReport) {
    summary.innerHTML = "";
    status.textContent = "거래내역 계산 결과 없음";
    grid.innerHTML = noticeMsg("계산할 거래내역이 없습니다", "");
    return;
  }

  const tr = testReport;
  const ov = tr.overall;
  status.textContent = sheets.updatedAt
    ? `거래내역 기준: ${new Date(sheets.updatedAt).toLocaleString("ko-KR")}  ·  현재가는 data.json 기준`
    : "거래내역 기준: 알 수 없음";

  const fmt = (v) => v == null ? "—" : Math.round(v).toLocaleString("ko-KR") + "원";
  const sign = (v) => v == null ? "—"
    : (v > 0 ? "+" : "") + Math.round(v).toLocaleString("ko-KR") + "원";
  const sPct = (v) => v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%";
  const cls = (v) => v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "flat";

  // ── 상단: 전체(종합) 요약 ──
  summary.innerHTML = `
    <div class="sum-box">
      <span class="sum-label">순 입금 (실 투자금)</span>
      <span class="sum-value">${fmt(ov.netCashIn)}</span>
      <span class="sum-pnl">입금 ${fmt(ov.cashIn)} − 출금 ${fmt(ov.cashOut)}</span>
    </div>
    <div class="sum-box">
      <span class="sum-label">현재 평가액</span>
      <span class="sum-value">${fmt(ov.totalEvalKrw)}</span>
      <span class="sum-pnl">매수원가 ${fmt(ov.totalCostKrw)}</span>
    </div>
    <div class="sum-box sum-gain" id="sum-gain">
      <span class="sum-label">전체 수익 (3개 계좌 합산)</span>
      <span class="sum-value ${cls(ov.totalGain)}">${sign(ov.totalGain)} <small>${sPct(ov.totalGainPct)}</small></span>
      <span class="sum-pnl">평가 ${sign(ov.unrealizedKrw)} · 실현 ${sign(ov.realized)} · 분배금 ${fmt(ov.dividends)}</span>
    </div>
    ${secretUnlocked ? renderSecretReturns(ov, { fmt, sign, sPct, cls }) : ""}`;

  // '전체 수익' 박스 5초 길게 누르면 시크릿 토글
  attachLongPress($("#sum-gain"), () => { secretUnlocked = !secretUnlocked; renderTest(); });

  // 한 계좌 섹션의 보유 종목 표
  const renderHoldings = (heldList) => {
    if (!heldList.length) {
      return `<p class="sec-empty">보유 중인 종목이 없습니다</p>`;
    }
    const tbody = heldList.map((h) => {
      const k = cls(h.pnlKrw);
      const tickerCell = h.ticker
        ? `<span class="ticker">${esc(h.ticker)}</span>`
        : `<span class="ticker tk-none">필요 티커 — 미등록</span>`;
      return `
        <tr>
          <td>
            <div class="th-name">${esc(h.name)}</div>
            <div class="th-meta">${tickerCell}</div>
          </td>
          <td class="num">${h.qty.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}</td>
          <td class="num">${fmt(h.avgCostKrw)}</td>
          <td class="num">${fmt(h.priceKrw)}</td>
          <td class="num">${fmt(h.costKrw)}</td>
          <td class="num">${fmt(h.evalKrw)}</td>
          <td class="num pnl ${k}">
            ${sign(h.pnlKrw)}<br><small>${sPct(h.pnlPct)}</small>
          </td>
        </tr>`;
    }).join("");
    return `
      <div class="sheet-wrap">
        <table class="sheet-table holdings-table">
          <thead>
            <tr>
              <th>종목</th>
              <th class="num">수량</th>
              <th class="num">평단(원)</th>
              <th class="num">현재가(원)</th>
              <th class="num">매수원가</th>
              <th class="num">평가액</th>
              <th class="num">평가손익</th>
            </tr>
          </thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
  };

  // ── 계좌별 섹션 ──
  const sectionsHtml = tr.sections.map((s) => `
    <section class="acct-section">
      <header class="acct-head">
        <h3 class="acct-title">${esc(s.label)}</h3>
        <span class="acct-gain ${cls(s.totalGain)}">${sign(s.totalGain)} <small>${sPct(s.totalGainPct)}</small></span>
      </header>
      <p class="acct-meta">
        순입금 ${fmt(s.netCashIn)} · 평가액 ${fmt(s.totalEvalKrw)} ·
        평가 ${sign(s.unrealizedKrw)} · 실현 ${sign(s.realized)} · 분배금 ${fmt(s.dividends)}
      </p>
      ${renderHoldings(s.heldList)}
    </section>`).join("");

  // ── '필요 티커' — 매핑 없어 시세 조회 안 되는 보유 종목 ──
  let needHtml = "";
  if (tr.needTickers.length) {
    const rows = [...tr.needTickers]
      .sort((a, b) => a.accounts[0] === b.accounts[0]
        ? a.name.localeCompare(b.name, "ko") : a.accounts[0].localeCompare(b.accounts[0], "ko"))
      .map((n) => `
      <tr>
        <td class="th-name">${esc(n.name)}</td>
        <td>${n.accounts.map(esc).join(", ")}</td>
        <td class="num">${n.qty.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}</td>
      </tr>`).join("");
    needHtml = `
      <section class="acct-section need-section">
        <header class="acct-head">
          <h3 class="acct-title">⚠️ 필요 티커 (${tr.needTickers.length}종목)</h3>
        </header>
        <p class="acct-meta">아래는 보유 중이지만 시세 매칭이 안 되는 종목입니다. 시트의 <b>'필요 티커'</b> 탭에 <b>종목명 · 티커 · 국가(USD/JPY)</b> 를 채우면 시세·평가·수익률에 반영됩니다. (해외주는 국가가 있어야 평단 환율이 정확)</p>
        <div class="sheet-wrap">
          <table class="sheet-table">
            <thead>
              <tr><th>종목명</th><th>계좌</th><th class="num">보유수량</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ── 시크릿 — 종목당 수익 (평가+실현+배당, 계좌 합산), 5초 길게 눌러 열렸을 때만 ──
  let byStockHtml = "";
  if (secretUnlocked && tr.byStock && tr.byStock.length) {
    const winners = tr.byStock.filter((h) => h.profitKrw != null && h.profitKrw > 0).length;
    const losers = tr.byStock.filter((h) => h.profitKrw != null && h.profitKrw < 0).length;
    // 여기서만 보이는 교정 손익 합계 (병합 교정·공모주 제외 기준)
    const sec = tr.byStock.reduce((a, h) => {
      a.unreal += h.unrealKrw || 0; a.realized += h.realizedKrw || 0;
      a.div += h.dividendsKrw || 0; a.total += h.profitKrw || 0;
      return a;
    }, { unreal: 0, realized: 0, div: 0, total: 0 });
    const rows = tr.byStock.map((h) => {
      const acctTxt = h.accounts.length ? h.accounts.join(", ") : "";
      const tag = h.sold ? "매도완료" : !h.held ? "" : (h.realizedKrw != null ? "일부매도" : "보유");
      return `
        <tr>
          <td>
            <div class="th-name">${esc(h.name)}${tag ? ` <span class="th-tag">${tag}</span>` : ""}</div>
            <div class="th-meta">${h.ticker
              ? `<span class="ticker">${esc(h.ticker)}</span>` : `<span class="ticker tk-none">티커 없음</span>`}${acctTxt
              ? ` <span class="th-acct">${esc(acctTxt)}</span>` : ""}</div>
          </td>
          <td class="num pnl ${cls(h.unrealKrw)}">${sign(h.unrealKrw)}</td>
          <td class="num pnl ${cls(h.realizedKrw)}">${sign(h.realizedKrw)}</td>
          <td class="num">${h.dividendsKrw != null ? `<span class="up">${fmt(h.dividendsKrw)}</span>` : "—"}</td>
          <td class="num pnl ${cls(h.profitKrw)}"><b>${sign(h.profitKrw)}</b></td>
        </tr>`;
    }).join("");
    byStockHtml = `
      <section class="acct-section bystock-section">
        <header class="acct-head">
          <h3 class="acct-title">🔒 종목당 수익 (${tr.byStock.length}종목)</h3>
          <span class="acct-gain"><small>📈 ${winners} · 📉 ${losers}</small></span>
        </header>
        <p class="acct-meta">계좌(종합·ISA) 합산. <b>수익금 = 평가손익 + 실현손익 + 배당금</b>, 수익금순 정렬. 판 종목·티커 없는 종목도 실현손익으로 포함됩니다. (매수원가 없는 공모주 매도는 제외)</p>
        <div class="secret-card">
          <span class="sc-label">🔒 여기서만 보이는 손익<br><small>병합 교정·공모주 제외 기준</small></span>
          <span class="sc-total ${cls(sec.total)}">${sign(sec.total)}</span>
          <span class="sc-break">평가 ${sign(sec.unreal)} · 실현 ${sign(sec.realized)} · 배당 ${fmt(sec.div)}</span>
        </div>
        <div class="sheet-wrap">
          <table class="sheet-table holdings-table">
            <thead>
              <tr>
                <th>종목</th>
                <th class="num">평가손익</th>
                <th class="num">실현손익</th>
                <th class="num">배당금</th>
                <th class="num">수익금</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  grid.innerHTML = sectionsHtml + needHtml + byStockHtml;
}

/* ---------- 메인 ---------- */
async function load() {
  const status = $("#status");
  status.textContent = "불러오는 중…";

  try {
    const [portfolio, data, cheongyakData, sheetsData] = await Promise.all([
      portfolioCache ? Promise.resolve(portfolioCache) : loadJson("portfolio.json"),
      loadJson("data.json"),
      loadJson("cheongyak.json").catch((e) => ({ __error: String(e.message || e) })),
      loadJson("sheets.json").catch((e) => ({ __error: String(e.message || e) })),
    ]);
    portfolioCache = portfolio;
    cheongyak = cheongyakData;
    sheets = sheetsData;
    try {
      testReport = sheets && !sheets.__error
        ? buildTestReport(sheets, portfolio, data) : null;
    } catch (e) {
      console.warn("test report 계산 실패:", e);
      testReport = null;
    }
    document.body.dataset.scheme = portfolio.colorScheme || "kr";
    groupNotes = portfolio.groupNotes && typeof portfolio.groupNotes === "object"
      ? portfolio.groupNotes : {};

    entries = [];
    watchEntries = [];
    sectorGroups = [];
    const groups = [];

    // 관심그룹 — 직접 고른 관심 종목 (보유 수량·평단 없이 시세만)
    // 주식·코인은 일봉(전일 대비), 나머지(통화·지수 등)는 주봉(주간 대비)로 표시.
    for (const w of portfolio.watchlist || []) {
      const kind = w.kind || "기타";
      const weekly = !WATCH_DAILY_KINDS.includes(kind);
      const q = weekly ? data.weekly?.[w.ticker] : data.quotes?.[w.ticker];
      if (!q || q.error || typeof q.price !== "number") {
        watchEntries.push({ kind, cardHtml: renderError(w, q?.error || "데이터 없음") });
        continue;
      }
      watchEntries.push({ kind, cardHtml: renderWatchCard(w, quoteOf(q, w.mul || 1), weekly) });
    }

    // 섹터 — 코인 섹션 아래 섹터 영역에 들어가는 미니 카드 (섹터별 그룹)
    for (const sec of portfolio.sectors || []) {
      const seen = new Set();
      let cardsHtml = "";
      let count = 0;
      for (const it of sec.items || []) {
        if (!it.ticker || seen.has(it.ticker)) continue; // 같은 섹터 내 중복 티커는 한 번만
        seen.add(it.ticker);
        count++;
        const q = data.weekly?.[it.ticker];   // 섹터는 주봉 시세 사용
        cardsHtml +=
          !q || q.error || typeof q.price !== "number"
            ? renderMiniError(it, q?.error || "데이터 없음")
            : renderMiniCard(it, quoteOf(q));
      }
      if (count) sectorGroups.push({ name: sec.name || "(이름 없음)", cardsHtml, count });
    }

    // 보유 종목 — group 별 탭으로 분리, 통화별 자산 요약 집계
    for (const h of portfolio.holdings || []) {
      const group = h.group || DEFAULT_GROUP;
      if (!groups.includes(group)) groups.push(group);

      const q = data.quotes?.[h.ticker];
      if (!q || q.error || typeof q.price !== "number") {
        entries.push({
          group,
          cardHtml: renderError(h, q?.error || "데이터 없음"),
          summaryRow: null,
        });
        continue;
      }
      const c = computeQuote(h, q);
      entries.push({
        group,
        cardHtml: renderCard(h, c),
        summaryRow: { currency: c.currency, value: c.value, cost: c.cost, pnl: c.pnl },
      });
    }

    // 관심그룹 → 보유 그룹 탭들 → 청약 일정 탭 → 테스트(구글시트) 탭 순서로 배치.
    tabOrder = [WATCH_TAB, ...groups, CHEONGYAK_TAB, TEST_TAB];
    if (!tabOrder.includes(currentTab)) currentTab = WATCH_TAB;

    renderTabs();
    // URL 해시(#탭이름)로 특정 탭을 열 수 있음 — 북마크/링크 공유용
    const hashTab = decodeURIComponent(location.hash.slice(1) || "");
    if (hashTab && tabOrder.includes(hashTab)) currentTab = hashTab;

    const upd = data.updatedAt
      ? new Date(data.updatedAt).toLocaleString("ko-KR")
      : "알 수 없음";
    stockStatusText = `시세 기준 시각: ${upd}  (GitHub Actions가 주기적으로 갱신)`;

    selectTab(currentTab);
  } catch (e) {
    $("#tabs").innerHTML = "";
    $("#summary").innerHTML = "";
    $("#grid").innerHTML = `
      <article class="card card-error">
        <p class="err-msg">데이터를 불러오지 못했습니다<br>
          <small>${e.message || e}</small><br>
          <small>GitHub Actions가 아직 한 번도 실행되지 않았을 수 있습니다.</small>
        </p>
      </article>`;
    status.textContent = "불러오기 실패";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  load();

  const toTop = document.getElementById("to-top");
  if (toTop) {
    const onScroll = () => toTop.classList.toggle("show", window.scrollY > 240);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    toTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
});
