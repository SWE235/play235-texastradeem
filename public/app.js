
// Texas Trade'Em · v4.6.1
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1jJ5ZG1t5O792V74nk0j8pHBEUvz4MiaAIW13TiNLQn8/export?format=csv&gid=228801203";

const WEEKLY_PROXY_ENDPOINT = "/weekly";

const START_BALANCE = 235;
const STAKE_R1 = 20;
const STAKE_R2 = 30;
const STAKE_R3 = 50;
const SESSION_DURATION_SEC = 5 * 60;

const state = {
  headers: [],
  cards: [],
  mode: "YTD",
  deckIndex: 0,
  round: 1,
  gameOver: false,
  session: {
    remaining: SESSION_DURATION_SEC,
    timerId: null,
    subscribed: false,
    expiry: null,
    locked: false,
  },
  players: [
    { id: "bb", name: "You", color: "bb", hand: [], score: null, balance: START_BALANCE,
      active: true, r1Resolved:false, r1Lost:false, r2Resolved:false, r2Lost:false, hitLockedR1:false, hitLockedR2:false },
    { id: "ai", name: "Dealer", color: "ai", hand: [], score: null, balance: START_BALANCE,
      active: true, r1Resolved:false, r1Lost:false, r2Resolved:false, r2Lost:false, hitLockedR1:false, hitLockedR2:false },
    { id: "hf", name: "Hedge Fund", color: "hf", hand: [], score: null, balance: START_BALANCE,
      active: true, r1Resolved:false, r1Lost:false, r2Resolved:false, r2Lost:false, hitLockedR1:false, hitLockedR2:false },
  ],
  weeklyCache: {},
};

let currentPopupCard = null;
let currentWeeklySeries = null;

/* Local storage */

function loadBalances() {
  try {
    const raw = localStorage.getItem("texas_tradem_balances");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.players.forEach((p) => {
      if (parsed[p.id] != null) p.balance = parsed[p.id];
    });
  } catch {}
}

function saveBalances() {
  try {
    const obj = {};
    state.players.forEach((p) => (obj[p.id] = p.balance));
    localStorage.setItem("texas_tradem_balances", JSON.stringify(obj));
  } catch {}
}

/* CSV */

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (cells[i] || "").trim()));
    return obj;
  });
  return { headers, rows };
}

function detectColumnKeys(headers, row) {
  const keys = Object.keys(row);
  let tickerKey = keys.find((k) => /ticker|symbol/i.test(k)) || keys[0];
  let suitKey = keys.find((k) => /suit/i.test(k));
  let rankKey = keys.find((k) => /rank|card/i.test(k));
  let ytdKey = keys.find((k) => /ytd/i.test(k));
  let weeklyKey = keys.find((k) => /week|1w|wtd/i.test(k));
  let priceKey = keys.find((k) => /price|last|close/i.test(k));
  let flagKey = headers.find((h) => h.toLowerCase() === "flag");
  let mcapKey = keys.find((k) => /mkt|market.?cap|mcap/i.test(k));

  if (!weeklyKey && headers[15]) weeklyKey = headers[15];
  if (!ytdKey && headers[16]) ytdKey = headers[16];
  if (!priceKey && headers[4]) priceKey = headers[4];
  if (!mcapKey && headers[10]) mcapKey = headers[10];

  return { tickerKey, suitKey, rankKey, ytdKey, weeklyKey, priceKey, flagKey, mcapKey };
}

function normalizeSuit(raw) {
  if (!raw) return "♠";
  const s = String(raw).trim().toUpperCase();
  if (s === "♠" || s.startsWith("S")) return "♠";
  if (s === "♥" || s.startsWith("H")) return "♥";
  if (s === "♦" || s.startsWith("D")) return "♦";
  if (s === "♣" || s.startsWith("C")) return "♣";
  return "♠";
}

function mapRowsToCards(headers, rows) {
  if (!rows.length) return [];
  const trimmed = rows.slice(0, 52);
  const keys = detectColumnKeys(headers, trimmed[0]);
  return trimmed.map((row, idx) => {
    const ticker = row[keys.tickerKey] || "";
    if (!ticker) return null;
    const rank = row[keys.rankKey] || "";
    const suit = normalizeSuit(row[keys.suitKey] || "");
    const ytdRaw = keys.ytdKey ? row[keys.ytdKey] : "";
    const weeklyRaw = keys.weeklyKey ? row[keys.weeklyKey] : "";
    const priceRaw = keys.priceKey ? row[keys.priceKey] : "";
    const flagRaw = keys.flagKey ? row[keys.flagKey] : "";
    const mcapRaw = keys.mcapKey ? row[keys.mcapKey] : "";

    const ytd = parseFloat((ytdRaw || "").replace("%", ""));
    const weekly = parseFloat((weeklyRaw || "").replace("%", ""));
    const price = parseFloat((priceRaw || "").replace(/[^0-9.-]/g, ""));
    const hasFlag = !!flagRaw;
    let marketCapB = null;
    if (mcapRaw) {
      const num = parseFloat(String(mcapRaw).replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(num)) marketCapB = num >= 1e9 ? num / 1e9 : num;
    }

    return {
      id: idx,
      ticker,
      rank,
      suit,
      ytd: Number.isFinite(ytd) ? ytd : null,
      weekly: Number.isFinite(weekly) ? weekly : null,
      price: Number.isFinite(price) ? price : null,
      hasFlag,
      flagLabel: flagRaw || "",
      marketCapB,
    };
  }).filter(Boolean);
}

/* Utils */

function formatPctSigned(v) {
  if (v == null || Number.isNaN(v)) return "–";
  const sign = v > 0 ? "+" : "";
  return sign + v.toFixed(1) + "%";
}

function formatPrice(v) {
  if (v == null || Number.isNaN(v)) return "–";
  return "$" + v.toFixed(2);
}

function cardValue(card, mode) {
  const v = mode === "WEEKLY" ? card.weekly : card.ytd;
  return v ?? 0;
}

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function suitClassFor(card) {
  return card.suit === "♥" || card.suit === "♦" ? "suit-red" : "suit-white";
}

function describePhitball(card) {
  const b = card.marketCapB;
  if (!b || !Number.isFinite(b)) return "–";
  if (b < 1) return "< $1B (BillZone)";
  if (b < 5) return "$1–5B (Bill-side zone)";
  if (b < 10) return "$5–10B (Bill-side zone)";
  if (b < 30) return "$10–30B (midfield Bill-side)";
  if (b < 50) return "$30–50B (midfield)";
  if (b < 100) return "$50–100B (midfield)";
  if (b < 150) return "$100–150B (T-side approach)";
  if (b < 235) return "$150–235B (T-side approach)";
  if (b < 325) return "$235–325B (T-side)";
  if (b < 450) return "$325–450B (T-side)";
  if (b < 1000) return "$450B–$1T (red zone T-side)";
  return "$1T+ (end zone T-side)";
}

/* Render */

function renderWelcomeDeck() {
  const container = document.getElementById("welcome-deck");
  if (!container) return;
  container.innerHTML = "";
  state.cards.forEach((card) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "welcome-card";
    const v = state.mode === "WEEKLY" ? card.weekly : card.ytd;
    const display = v == null || Number.isNaN(v) ? null : Math.abs(v);
    const valueClass = display == null ? "" : v >= 0 ? "value-pos" : "value-neg";
    const valueText =
      display == null ? "–" : display.toFixed(1).replace(/-0\.0/, "0.0") + "%";
    const suitClass = suitClassFor(card);

    el.innerHTML =
      '<div class="welcome-card-header">' +
      '<span class="welcome-card-suit ' + suitClass + '">' + card.suit + "</span>" +
      '<span class="welcome-card-rank">' + (card.rank || "") + "</span>" +
      "</div>" +
      '<div class="welcome-card-body">' +
      '<div class="welcome-card-ticker">' + card.ticker + "</div>" +
      '<div class="welcome-card-value">' +
      '<span class="value-pct ' + valueClass + '">' + valueText + "</span>" +
      '<span class="card-flag' + (card.hasFlag ? " active" : "") + '"></span>' +
      "</div></div>";

    el.addEventListener("click", () => openCardPopup(card));
    container.appendChild(el);
  });
}

function renderHands() {
  const bbHandEl = document.getElementById("hand-bb");
  const aiHandEl = document.getElementById("hand-ai");
  const hfHandEl = document.getElementById("hand-hf");
  if (!bbHandEl || !aiHandEl || !hfHandEl) return;
  bbHandEl.innerHTML = "";
  aiHandEl.innerHTML = "";
  hfHandEl.innerHTML = "";

  const pairs = [
    [state.players.find((p) => p.id === "bb"), bbHandEl],
    [state.players.find((p) => p.id === "ai"), aiHandEl],
    [state.players.find((p) => p.id === "hf"), hfHandEl],
  ];

  pairs.forEach(([player, host]) => {
    player.hand.forEach((card) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "card-small";
      const v = cardValue(card, state.mode);
      const display = v == null || Number.isNaN(v) ? null : Math.abs(v);
      const valueClass = display == null ? "" : v >= 0 ? "value-pos" : "value-neg";
      const valueText =
        display == null ? "–" : display.toFixed(1).replace(/-0\.0/, "0.0") + "%";
      const suitClass = suitClassFor(card);

      el.innerHTML =
        '<div class="card-small-header">' +
        '<span class="card-small-suit ' + suitClass + '">' + card.suit + "</span>" +
        '<span class="card-small-rank">' + (card.rank || "") + "</span>" +
        "</div>" +
        '<div class="card-small-ticker">' + card.ticker + "</div>" +
        '<div class="card-small-value">' +
        '<span class="value-pct ' + valueClass + '">' + valueText + "</span>" +
        '<span class="card-flag' + (card.hasFlag ? " active" : "") + '"></span>' +
        "</div>";

      el.addEventListener("click", () => openCardPopup(card));
      host.appendChild(el);
    });
  });

  const countBB = document.getElementById("count-bb");
  const countAI = document.getElementById("count-ai");
  const countHF = document.getElementById("count-hf");
  if (countBB) countBB.textContent = String(pairs[0][0].hand.length);
  if (countAI) countAI.textContent = String(pairs[1][0].hand.length);
  if (countHF) countHF.textContent = String(pairs[2][0].hand.length);
}

function renderScoresAndBalances() {
  const bbScoreLine = document.getElementById("scoreline-bb");
  const aiScoreLine = document.getElementById("scoreline-ai");
  const hfScoreLine = document.getElementById("scoreline-hf");
  const bbBalEl = document.getElementById("balance-bb");
  const aiBalEl = document.getElementById("balance-ai");
  const hfBalEl = document.getElementById("balance-hf");

  state.players.forEach((p) => {
    p.score = p.hand.reduce((acc, card) => acc + cardValue(card, state.mode), 0);
  });
  const [bb, ai, hf] = [
    state.players.find((p) => p.id === "bb"),
    state.players.find((p) => p.id === "ai"),
    state.players.find((p) => p.id === "hf"),
  ];

  const lineFor = (p) => {
    const r1 = p.r1Lost ? "L" : (p.r1Resolved || state.round > 1) ? "W" : "—";
    const r2 = p.r2Lost ? "L" : (p.r2Resolved || state.round > 2) ? "W" : "—";
    return `R1: ${r1}  R2: ${r2}  Cards: ${p.hand.length}  Return: ${formatPctSigned(p.score)}`;
  };

  if (bbScoreLine) bbScoreLine.textContent = lineFor(bb);
  if (aiScoreLine) aiScoreLine.textContent = lineFor(ai);
  if (hfScoreLine) hfScoreLine.textContent = lineFor(hf);

  if (bbBalEl) bbBalEl.textContent = "$" + bb.balance;
  if (aiBalEl) aiBalEl.textContent = "$" + ai.balance;
  if (hfBalEl) hfBalEl.textContent = "$" + hf.balance;
}

function renderRoundLabel() {
  const label = document.getElementById("round-label");
  const advanceBtn = document.getElementById("advance-round-btn");
  if (!label || !advanceBtn) return;
  if (state.round === 1) { label.textContent = "Round 1 of 3"; advanceBtn.textContent = "Next round"; }
  else if (state.round === 2) { label.textContent = "Round 2 of 3"; advanceBtn.textContent = "Next round"; }
  else { label.textContent = "Round 3 of 3"; advanceBtn.textContent = "Settle game"; }
}

/* Weekly via function */

async function fetchWeeklyFromProxy(ticker) {
  try {
    const res = await fetch(WEEKLY_PROXY_ENDPOINT + "?symbol=" + encodeURIComponent(ticker));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.error) return null;
    const { changes, weeks } = json;
    if (!Array.isArray(changes) || !changes.length) return null;
    return { changes, weeks: Array.isArray(weeks) ? weeks : null };
  } catch {
    return null;
  }
}

async function getWeeklySeries(ticker) {
  const cached = state.weeklyCache[ticker];
  if (cached && cached.changes && cached.changes.length) return cached;
  const series = await fetchWeeklyFromProxy(ticker);
  if (series) {
    state.weeklyCache[ticker] = { ...series, lastUpdated: new Date().toISOString() };
    return state.weeklyCache[ticker];
  }
  return null;
}

function renderWeeklyBars(series, fallbackCard) {
  const barsHost = document.getElementById("popup-bars");
  const weeksHost = document.getElementById("popup-weeks");
  if (!barsHost || !weeksHost) return;
  barsHost.innerHTML = "";
  weeksHost.textContent = "";
  if (!series || !series.changes || !series.changes.length) {
    buildPlaceholderBars(fallbackCard);
    weeksHost.textContent = "Oldest ◀  Newest ▶";
    return;
  }
  const changes = series.changes;
  const weeks = series.weeks;
  const maxAbs = Math.max(...changes.map((c) => Math.abs(c))) || 1;
  changes.forEach((c) => {
    const bar = document.createElement("div");
    bar.className = "bar";
    const intensity = Math.min(1, Math.abs(c) / maxAbs);
    bar.style.opacity = 0.4 + 0.6 * intensity;
    bar.classList.add(c >= 0 ? "active-pos" : "active-neg");
    bar.textContent = Math.abs(c).toFixed(1);
    barsHost.appendChild(bar);
  });
  if (weeks && weeks.length >= 2) {
    weeksHost.textContent = "Oldest: Wk" + weeks[0] + " · Newest: Wk" + weeks[weeks.length - 1];
  } else {
    weeksHost.textContent = "Oldest ◀  Newest ▶";
  }
}

function buildPlaceholderBars(card) {
  const barsHost = document.getElementById("popup-bars");
  if (!barsHost) return;
  barsHost.innerHTML = "";
  const baseVal = cardValue(card, "YTD");
  const steps = 10;
  const activeCount = Math.min(steps, Math.round(Math.abs(baseVal || 0) / 5));
  for (let i = 0; i < steps; i++) {
    const bar = document.createElement("div");
    bar.className = "bar";
    if (i < activeCount) {
      bar.classList.add(baseVal >= 0 ? "active-pos" : "active-neg");
      bar.textContent = Math.abs(baseVal / steps).toFixed(1);
    }
    barsHost.appendChild(bar);
  }
}

/* Popup */

async function openCardPopup(card) {
  const backdrop = document.getElementById("card-popup-backdrop");
  if (!backdrop) return;
  currentPopupCard = card;
  currentWeeklySeries = null;
  document.getElementById("popup-card-id").textContent = (card.rank || "") + card.suit;
  document.getElementById("popup-card-ticker").textContent = card.ticker;
  document.getElementById("popup-ytd").textContent = formatPctSigned(card.ytd);
  document.getElementById("popup-weekly").textContent = formatPctSigned(card.weekly);
  document.getElementById("popup-price").textContent = formatPrice(card.price);
  const flagLabelEl = document.getElementById("popup-flag-label");
  if (flagLabelEl) flagLabelEl.textContent = card.hasFlag ? card.flagLabel || "Extra detail" : "—";
  const phitEl = document.getElementById("popup-phit");
  if (phitEl) phitEl.textContent = describePhitball(card);

  const series = await getWeeklySeries(card.ticker);
  currentWeeklySeries = series;
  renderWeeklyBars(series, card);
  backdrop.classList.remove("hidden");
}

function closeCardPopup() {
  const backdrop = document.getElementById("card-popup-backdrop");
  if (backdrop) backdrop.classList.add("hidden");
  currentPopupCard = null;
  currentWeeklySeries = null;
}

function handleAskAi() {
  if (!currentPopupCard) return;
  const ticker = currentPopupCard.ticker;
  const ytd = currentPopupCard.ytd;
  const series = currentWeeklySeries;
  const changes = series && series.changes ? series.changes : null;
  const last = changes ? changes[changes.length - 1] : null;
  const prev = changes && changes.length > 1 ? changes[changes.length - 2] : null;
  let pattern = "";
  if (changes) pattern = "Weekly changes (oldest→newest): " + changes.map((c) => c.toFixed(2)).join(", ");
  let continuation = "";
  if (last != null && prev != null) {
    if (last * prev > 0) continuation = "Last week continued the prior week's direction.";
    else continuation = "Last week reversed the prior week's direction.";
  }
  const prompt =
    `Explain last week's price action in ${ticker} using only public information.\n\n` +
    `Year-to-date change: ${ytd != null ? ytd.toFixed(2) + "%" : "n/a"}.\n` +
    (pattern ? pattern + "\n" : "") +
    (last != null ? `Last weekly move: ${last.toFixed(2)}%.\n` : "") +
    (prev != null ? `Previous weekly move: ${prev.toFixed(2)}%.\n` : "") +
    (continuation ? continuation + "\n" : "") +
    `Focus on whether this looks like a continuation or a reversal of trend, and what key themes likely drove it. Then, comment briefly on whether those themes are likely to persist over the next 10 weeks.`;
  const url = "https://chatgpt.com/?q=" + encodeURIComponent(prompt);
  window.open(url, "_blank", "noopener");
}

/* Game */

function resetDeckOrder() {
  state.cards = shuffle(state.cards);
  state.deckIndex = 0;
}

function drawCard() {
  if (!state.cards.length) return null;
  if (state.deckIndex >= state.cards.length) resetDeckOrder();
  const card = state.cards[state.deckIndex];
  state.deckIndex += 1;
  return card;
}

function resetRoundState() {
  state.round = 1;
  state.gameOver = false;
  state.players.forEach((p) => {
    p.active = true;
    p.r1Resolved = p.r1Lost = p.r2Resolved = p.r2Lost = false;
    p.hitLockedR1 = p.hitLockedR2 = false;
  });
  renderRoundLabel();
}

function guardSession() {
  if (state.session.subscribed) return false;
  if (!state.session.locked) return false;
  showSessionPopup();
  return true;
}

function dealNewHand() {
  if (guardSession()) return;
  if (!state.cards.length) return;
  resetDeckOrder();
  state.players.forEach((p) => (p.hand = []));
  for (let r = 0; r < 2; r++) {
    state.players.forEach((p) => {
      const c = drawCard();
      if (c) p.hand.push(c);
    });
  }
  resetRoundState();
  renderHands();
  renderScoresAndBalances();
}

function hitPlayer(playerId) {
  if (guardSession()) return;
  if (state.gameOver) return;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return;
  if (state.round === 1 && player.hitLockedR1) return;
  if (state.round === 2 && (player.hitLockedR2 || player.r2Lost || !player.active)) return;
  if (state.round === 3 || !player.active) return;
  if (player.hand.length >= 5) return;

  const c = drawCard();
  if (!c) return;
  player.hand.push(c);
  player.score = player.hand.reduce((acc, card) => acc + cardValue(card, state.mode), 0);
  const scoreAbs = Math.abs(player.score || 0);

  if (state.round === 1 && scoreAbs > 21) {
    player.hitLockedR1 = true;
    player.r1Lost = true;
  } else if (state.round === 2 && scoreAbs > 25) {
    player.hitLockedR2 = true;
    player.r2Lost = true;
    player.active = false;
  }
  renderHands();
  renderScoresAndBalances();
}

function settleRound1() {
  state.players.forEach((p) => {
    if (!p.r1Resolved) {
      const scoreAbs = Math.abs(p.score || 0);
      if (scoreAbs > 21 || p.r1Lost) {
        p.balance -= STAKE_R1;
        p.r1Lost = true;
      }
      p.r1Resolved = true;
    }
  });
  saveBalances();
}

function settleRound2() {
  state.players.forEach((p) => {
    if (!p.r2Resolved) {
      const scoreAbs = Math.abs(p.score || 0);
      if (scoreAbs > 25 || p.r2Lost) {
        p.balance -= STAKE_R2;
        p.r2Lost = true;
        p.active = false;
      }
      p.r2Resolved = true;
    }
  });
  saveBalances();
}

function settleRound3() {
  const active = state.players.filter((p) => p.active && p.hand.length);
  if (!active.length) {
    state.gameOver = true;
    saveBalances();
    return;
  }
  let maxScore = -Infinity;
  active.forEach((p) => { if (p.score > maxScore) maxScore = p.score; });
  active.forEach((p) => {
    if (p.score === maxScore) p.balance += STAKE_R3;
    else p.balance -= STAKE_R3;
  });
  state.gameOver = true;
  saveBalances();
}

function advanceRound() {
  if (guardSession()) return;
  if (state.round === 1) { settleRound1(); state.round = 2; }
  else if (state.round === 2) { settleRound2(); state.round = 3; }
  else if (state.round === 3) { settleRound3(); }
  renderScoresAndBalances();
  renderRoundLabel();
}

/* Mode */

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-toggle .mode-btn").forEach((btn) => {
    if (btn.dataset.mode === mode) btn.classList.add("active");
    else btn.classList.remove("active");
  });
  renderWelcomeDeck();
  renderHands();
  renderScoresAndBalances();
}

/* Header actions, session */

function setupHeaderActions() {
  const musicBtn = document.getElementById("music-btn");
  if (musicBtn) {
    musicBtn.addEventListener("click", () => {
      window.open("https://soundcloud.com/theluniz/i-got-5-on-it-1", "_blank", "noopener");
      musicBtn.classList.toggle("active");
    });
  }
  const sponsorBtn = document.getElementById("sponsor-btn");
  const sponsorBackdrop = document.getElementById("sponsor-backdrop");
  const sponsorClose = document.getElementById("sponsor-close");
  const sponsorEmailBtn = document.getElementById("sponsor-email-btn");
  if (sponsorBtn && sponsorBackdrop) sponsorBtn.addEventListener("click", () => sponsorBackdrop.classList.remove("hidden"));
  if (sponsorClose && sponsorBackdrop) sponsorClose.addEventListener("click", () => sponsorBackdrop.classList.add("hidden"));
  if (sponsorBackdrop) sponsorBackdrop.addEventListener("click", (e) => { if (e.target === sponsorBackdrop) sponsorBackdrop.classList.add("hidden"); });
  if (sponsorEmailBtn) sponsorEmailBtn.addEventListener("click", () => {
    location.href = "mailto:andy@SWE235.com?subject=" +
      encodeURIComponent("I want to sponsor Play235.com") +
      "&body=" + encodeURIComponent("I'd like to discuss a weekly sponsorship of the Texas Trade'Em game on Play235.com.");
  });

  const rulesBtn = document.getElementById("rules-btn");
  const rulesBackdrop = document.getElementById("rules-backdrop");
  const rulesClose = document.getElementById("rules-close");
  if (rulesBtn && rulesBackdrop) rulesBtn.addEventListener("click", () => rulesBackdrop.classList.remove("hidden"));
  if (rulesClose && rulesBackdrop) rulesClose.addEventListener("click", () => rulesBackdrop.classList.add("hidden"));
  if (rulesBackdrop) rulesBackdrop.addEventListener("click", (e) => { if (e.target === rulesBackdrop) rulesBackdrop.classList.add("hidden"); });
}

/* Session timer */

function updateSessionStatus() {
  const statusEl = document.getElementById("session-status");
  if (!statusEl) return;
  if (state.session.subscribed && state.session.expiry) {
    const d = new Date(state.session.expiry);
    const label = String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0");
    statusEl.textContent = "Subscription active · thru " + label;
  } else {
    const m = String(Math.floor(state.session.remaining / 60)).padStart(2, "0");
    const s = String(state.session.remaining % 60).padStart(2, "0");
    statusEl.innerHTML = 'Free session · <span id="session-timer">' + m + ":" + s + "</span>";
  }
}

function showSessionPopup() {
  const backdrop = document.getElementById("session-popup-backdrop");
  if (backdrop) backdrop.classList.remove("hidden");
}

function hideSessionPopup() {
  const backdrop = document.getElementById("session-popup-backdrop");
  if (backdrop) backdrop.classList.add("hidden");
}

function startSessionTimer() {
  if (state.session.subscribed) { state.session.locked = false; updateSessionStatus(); return; }
  if (state.session.timerId) clearInterval(state.session.timerId);
  state.session.remaining = SESSION_DURATION_SEC;
  state.session.locked = false;
  updateSessionStatus();
  state.session.timerId = setInterval(() => {
    state.session.remaining -= 1;
    if (state.session.remaining <= 0) {
      clearInterval(state.session.timerId);
      state.session.timerId = null;
      state.session.remaining = 0;
      state.session.locked = true;
      updateSessionStatus();
      showSessionPopup();
    } else updateSessionStatus();
  }, 1000);
}

function setupSessionPopup() {
  const closeBtn = document.getElementById("session-close");
  const restartBtn = document.getElementById("session-restart-btn");
  const buyBtn = document.getElementById("session-buy-btn");
  const backdrop = document.getElementById("session-popup-backdrop");
  if (closeBtn) closeBtn.addEventListener("click", hideSessionPopup);
  if (restartBtn) restartBtn.addEventListener("click", () => { hideSessionPopup(); startSessionTimer(); });
  if (buyBtn) buyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const deckLink = document.getElementById("buy-deck-link");
    if (deckLink && deckLink.href) window.open(deckLink.href, "_blank", "noopener");
  });
  if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target === backdrop) hideSessionPopup(); });
}

/* Subscription hook */

function checkSubscriptionFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("sub") === "1") {
      const expiry = new Date(); expiry.setMonth(expiry.getMonth() + 1);
      state.session.subscribed = true;
      state.session.expiry = expiry.toISOString();
      state.session.locked = false;
      localStorage.setItem("texas_tradem_subscription", JSON.stringify({ expiry: state.session.expiry }));
    } else {
      const raw = localStorage.getItem("texas_tradem_subscription");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.expiry) {
          const expiry = new Date(parsed.expiry);
          if (expiry > new Date()) {
            state.session.subscribed = true;
            state.session.expiry = parsed.expiry;
            state.session.locked = false;
          }
        }
      }
    }
  } catch {}
}

/* Events */

function setupEvents() {
  const modeToggleWelcome = document.getElementById("mode-toggle");
  const modeToggleGame = document.getElementById("mode-toggle-game");
  const startBtn = document.getElementById("start-game-btn");
  const startInline = document.getElementById("start-inline");
  const dealBtn = document.getElementById("deal-new-btn");
  const advanceBtn = document.getElementById("advance-round-btn");
  const askAiBtn = document.getElementById("popup-ask-ai");

  const goToGame = () => {
    if (guardSession()) return;
    const welcome = document.getElementById("welcome-screen");
    const game = document.getElementById("game-screen");
    if (welcome && game) {
      welcome.classList.remove("active");
      game.classList.add("active");
      dealNewHand();
    }
  };

  if (modeToggleWelcome) modeToggleWelcome.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn"); if (!btn) return; setMode(btn.dataset.mode);
  });
  if (modeToggleGame) modeToggleGame.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn"); if (!btn) return; setMode(btn.dataset.mode);
  });
  if (startBtn) startBtn.addEventListener("click", goToGame);
  if (startInline) startInline.addEventListener("click", goToGame);
  if (dealBtn) dealBtn.addEventListener("click", () => dealNewHand());
  if (advanceBtn) advanceBtn.addEventListener("click", () => advanceRound());

  document.querySelectorAll(".pill").forEach((pill) => {
    const pid = pill.getAttribute("data-player");
    pill.addEventListener("click", () => hitPlayer(pid));
  });

  const popupBackdrop = document.getElementById("card-popup-backdrop");
  const popupClose = document.getElementById("card-popup-close");
  if (popupBackdrop) popupBackdrop.addEventListener("click", (e) => { if (e.target === popupBackdrop) closeCardPopup(); });
  if (popupClose) popupClose.addEventListener("click", closeCardPopup);
  if (askAiBtn) askAiBtn.addEventListener("click", handleAskAi);
}

/* Load */

async function loadDeck() {
  try {
    const res = await fetch(SHEET_URL);
    const text = await res.text();
    const { headers, rows } = parseCsv(text);
    state.headers = headers;
    state.cards = mapRowsToCards(headers, rows);
  } catch (err) {
    console.error("Deck load failed", err);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  loadBalances();
  checkSubscriptionFromUrl();
  await loadDeck();
  setMode("YTD");
  renderWelcomeDeck();
  setupEvents();
  setupHeaderActions();
  setupSessionPopup();
  startSessionTimer();
  renderRoundLabel();
});
