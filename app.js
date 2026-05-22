// ============================================================
//  내 주식 대시보드 — 동작 로직
//
//  portfolio.json (종목 설정) + data.json (GitHub Actions가 받아둔 시세)
//  를 읽어 화면을 그립니다. 둘 다 같은 출처라 CORS 가 없습니다.
//
//  종목에 "group" 값을 주면 그룹별 탭으로 분리됩니다. (예: "월배당")
// ============================================================

const $ = (sel) => document.querySelector(sel);

const DEFAULT_GROUP = "일반";   // group 이 없는 종목이 들어갈 기본 그룹
const ALL_TAB = "전체";          // 모든 종목을 보여주는 탭

let portfolioCache = null;
let entries = [];      // [{ group, cardHtml, summaryRow|null }]
let tabOrder = [];     // [ALL_TAB, ...그룹들]
let currentTab = ALL_TAB;

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

/* ---------- 손익 계산 ---------- */
function computeQuote(holding, q) {
  const price = q.price;
  const prevClose = typeof q.prevClose === "number" ? q.prevClose : price;
  const change = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;

  const value = price * holding.quantity;
  const cost = holding.buyPrice * holding.quantity;
  const pnl = value - cost;
  const pnlPct = holding.buyPrice ? (price / holding.buyPrice - 1) * 100 : 0;

  return {
    price,
    currency: q.currency || "USD",
    closes: Array.isArray(q.closes) ? q.closes : [],
    change, changePct, value, cost, pnl, pnlPct,
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
    name === ALL_TAB
      ? entries.length
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

  const shown =
    name === ALL_TAB ? entries : entries.filter((e) => e.group === name);

  $("#grid").innerHTML = shown.length
    ? shown.map((e) => e.cardHtml).join("")
    : '<p class="empty-msg">이 탭에 표시할 종목이 없습니다.</p>';

  $("#summary").innerHTML = renderSummary(
    shown.map((e) => e.summaryRow).filter(Boolean)
  );
}

/* ---------- 메인 ---------- */
async function load() {
  const btn = $("#refresh");
  const status = $("#status");

  btn.disabled = true;
  btn.classList.add("loading");
  status.textContent = "불러오는 중…";

  try {
    const [portfolio, data] = await Promise.all([
      portfolioCache ? Promise.resolve(portfolioCache) : loadJson("portfolio.json"),
      loadJson("data.json"),
    ]);
    portfolioCache = portfolio;
    document.body.dataset.scheme = portfolio.colorScheme || "kr";

    entries = [];
    const groups = [];

    for (const h of portfolio.holdings) {
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

    // 그룹이 2개 이상일 때만 탭을 보여줍니다.
    tabOrder = [ALL_TAB, ...groups];
    if (!tabOrder.includes(currentTab)) currentTab = ALL_TAB;

    if (groups.length > 1) {
      renderTabs();
      // URL 해시(#그룹명)로 특정 탭을 열 수 있음 — 북마크/링크 공유용
      const hashTab = decodeURIComponent(location.hash.slice(1) || "");
      if (hashTab && tabOrder.includes(hashTab)) currentTab = hashTab;
    } else {
      $("#tabs").innerHTML = "";
      currentTab = ALL_TAB;
    }
    selectTab(currentTab);

    const upd = data.updatedAt
      ? new Date(data.updatedAt).toLocaleString("ko-KR")
      : "알 수 없음";
    status.textContent = `시세 기준 시각: ${upd}  (GitHub Actions가 주기적으로 갱신)`;
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
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#refresh").addEventListener("click", load);
  load();
});
