// ============================================================
//  내 주식 대시보드 — 동작 로직
//
//  portfolio.json (종목 설정) + data.json (GitHub Actions가 받아둔 시세)
//  를 읽어 화면을 그립니다. 둘 다 같은 출처라 CORS 가 없습니다.
// ============================================================

const $ = (sel) => document.querySelector(sel);

let portfolioCache = null;

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

    const cards = [];
    const rows = [];

    for (const h of portfolio.holdings) {
      const q = data.quotes?.[h.ticker];
      if (!q || q.error || typeof q.price !== "number") {
        cards.push(renderError(h, q?.error || "데이터 없음"));
        continue;
      }
      const c = computeQuote(h, q);
      cards.push(renderCard(h, c));
      rows.push({ currency: c.currency, value: c.value, cost: c.cost, pnl: c.pnl });
    }

    $("#grid").innerHTML = cards.join("");
    $("#summary").innerHTML = renderSummary(rows);

    const upd = data.updatedAt
      ? new Date(data.updatedAt).toLocaleString("ko-KR")
      : "알 수 없음";
    status.textContent = `시세 기준 시각: ${upd}  (GitHub Actions가 주기적으로 갱신)`;
  } catch (e) {
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
