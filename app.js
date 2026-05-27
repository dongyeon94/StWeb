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

// 관심그룹 안에서 종목을 묶는 분류 — 이 순서대로 섹션·바로가기가 표시됩니다.
const WATCH_KINDS = ["통화", "지수", "주식", "코인"];
const SECTOR_SECTION = "섹터";   // 관심그룹 맨 아래에 들어가는 섹터 분류 표

let portfolioCache = null;
let entries = [];      // 보유 종목 [{ group, cardHtml, summaryRow|null }]
let watchEntries = []; // 관심 종목 [{ kind, cardHtml }]
let sectorGroups = []; // 섹터별 미니 카드 [{ name, cardsHtml, count }]
let tabOrder = [];     // [WATCH_TAB, ...그룹들, CHEONGYAK_TAB]
let currentTab = WATCH_TAB;
let cheongyak = null;       // cheongyak.json 내용 (또는 { __error })
let stockStatusText = "";   // 주식 탭에서 보여줄 상태줄 텍스트
let groupNotes = {};        // { 그룹명: "탭 상단에 띄울 메모 (인라인 **bold** 지원)" }

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

function renderWatchCard(item, c) {
  const arrow = c.change > 0 ? "▲" : c.change < 0 ? "▼" : "■";
  const kind = item.kind;
  const changeStr =
    (c.change > 0 ? "+" : "") + fmtWatchPrice(c.change, kind, c.currency);
  return `
  <article class="card">
    <div class="card-head">
      <div>
        <h2>${esc(item.name)}</h2>
        <span class="ticker">${esc(item.ticker)}</span>
      </div>
      <div class="price">
        ${fmtWatchPrice(c.price, kind, c.currency)}
        <span class="change ${dirClass(c.change)}">${arrow} ${fmtPct(c.changePct)}</span>
      </div>
    </div>
    ${sparkline(c.closes)}
    <dl class="stats">
      <div><dt>전일 종가</dt><dd>${fmtWatchPrice(c.prevClose, kind, c.currency)}</dd></div>
      <div><dt>전일 대비</dt>
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
      : "https://www.applyhome.co.kr")
  );
}

const ymd = (s) => (s ? esc(s).slice(2).replace(/-/g, ".") : "—"); // 2026-05-20 → 26.05.20
const md  = (s) => (s ? esc(s).slice(5).replace(/-/g, ".") : "");   // 2026-05-20 → 05.20

const STATUS_KEY = { 접수중: "open", 예정: "soon", 공고중: "posted", 마감: "closed" };
const KIND_KEY   = { 분양: "sale", 임대: "rent", 무순위: "extra" };
const SRC_KEY    = { LH: "lh", 청약홈: "home" };

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

  if (!notices.length) {
    summary.innerHTML = "";
    grid.innerHTML = !c.updatedAt
      ? noticeMsg(
          "청약 일정이 아직 수집되지 않았습니다",
          "GitHub Actions의 '청약 일정 받기' 단계가 실행되면 표시됩니다."
        )
      : noKey
      ? noticeMsg(
          "청약 API 인증키가 설정되지 않았습니다",
          "data.go.kr 인증키를 저장소 Secret(DATA_GO_KR_KEY)에 등록하세요. README 참고."
        )
      : noticeMsg("표시할 청약 공고가 없습니다", "");
    return;
  }

  // 상태별 요약 (마감 카운트는 안내용으로만 노출, 카드는 숨김)
  const tally = { 접수중: 0, 예정: 0, 공고중: 0, 마감: 0 };
  notices.forEach((n) => {
    tally[cheongyakStatus(n)]++;
  });
  const activeNotices = notices.filter((n) => cheongyakStatus(n) !== "마감");

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

  // 일부 출처만 실패한 경우 경고 한 줄
  const failed = c.sources
    ? Object.entries(c.sources).filter(
        ([, s]) => !s.ok && !/인증키/.test(s.error || "")
      )
    : [];
  const warn = failed.length
    ? `<p class="empty-msg">⚠ ${failed
        .map(([k, s]) => `${esc(k)} 불러오기 실패 (${esc(s.error || "")})`)
        .join(" · ")}</p>`
    : "";

  grid.innerHTML = activeNotices.length
    ? warn + activeNotices.map(renderNoticeCard).join("")
    : warn + noticeMsg("표시할 청약 공고가 없습니다", tally.마감 ? `마감된 공고 ${tally.마감}건만 있어 모두 숨김` : "");
}

/* ---------- 메인 ---------- */
async function load() {
  const status = $("#status");
  status.textContent = "불러오는 중…";

  try {
    const [portfolio, data, cheongyakData] = await Promise.all([
      portfolioCache ? Promise.resolve(portfolioCache) : loadJson("portfolio.json"),
      loadJson("data.json"),
      loadJson("cheongyak.json").catch((e) => ({ __error: String(e.message || e) })),
    ]);
    portfolioCache = portfolio;
    cheongyak = cheongyakData;
    document.body.dataset.scheme = portfolio.colorScheme || "kr";
    groupNotes = portfolio.groupNotes && typeof portfolio.groupNotes === "object"
      ? portfolio.groupNotes : {};

    entries = [];
    watchEntries = [];
    sectorGroups = [];
    const groups = [];

    // 관심그룹 — 직접 고른 관심 종목 (보유 수량·평단 없이 시세만)
    for (const w of portfolio.watchlist || []) {
      const kind = w.kind || "기타";
      const q = data.quotes?.[w.ticker];
      if (!q || q.error || typeof q.price !== "number") {
        watchEntries.push({ kind, cardHtml: renderError(w, q?.error || "데이터 없음") });
        continue;
      }
      watchEntries.push({ kind, cardHtml: renderWatchCard(w, quoteOf(q, w.mul || 1)) });
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

    // 관심그룹 → 보유 그룹 탭들 → 청약 일정 탭 순서로 배치합니다.
    tabOrder = [WATCH_TAB, ...groups, CHEONGYAK_TAB];
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
