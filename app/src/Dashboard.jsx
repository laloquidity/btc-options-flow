import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// PERSISTENT TRADE STORAGE (localStorage + Supabase API)
// ============================================================

const STORAGE_KEY = "btc_flow_saved_trades";
const SAVE_THRESHOLD_USD = 500_000;
const SAVE_THRESHOLD_BTC = 50; // whale-level

// --- localStorage layer (offline fallback) ---

function loadSavedTrades() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistTrades(trades) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  } catch (e) {
    console.warn("localStorage write failed:", e);
  }
}

// --- Supabase API layer (persistent, gapless) ---

const API_BASE = import.meta.env.VITE_API_BASE || "";

async function loadTradesFromAPI(limit = 500) {
  try {
    const res = await fetch(`${API_BASE}/api/trades?limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.trades || [];
  } catch (err) {
    console.warn("API fetch failed, using localStorage only:", err);
    return [];
  }
}

async function saveTradeToAPI(entry) {
  try {
    await fetch(`${API_BASE}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    // fire-and-forget — localStorage is the fallback
  }
}

// Merge localStorage + API trades, dedup by trade_id
function mergeTrades(localTrades, apiTrades) {
  const seen = new Set();
  const merged = [];
  // Prefer API data (more complete from cron), then local
  for (const t of [...apiTrades, ...localTrades]) {
    const id = t.trade_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(t);
  }
  return merged;
}

// --- Combined save (dual-write) ---

function saveTrade(trade, btcPrice) {
  const saved = loadSavedTrades();
  // deduplicate by trade_id
  if (saved.some((s) => s.trade_id === trade.trade_id)) return false;
  const notionalUsd = trade.amount * btcPrice;
  const entry = {
    ...trade,
    btcPriceAtSave: btcPrice,
    notionalUsd,
    savedAt: Date.now(),
  };
  saved.unshift(entry); // newest first
  // cap at 500 to avoid localStorage bloat
  if (saved.length > 500) saved.length = 500;
  persistTrades(saved);
  // Also push to API (fire-and-forget)
  saveTradeToAPI(entry);
  return true;
}

function shouldSaveTrade(trade, btcPrice) {
  const notionalUsd = trade.amount * btcPrice;
  return notionalUsd >= SAVE_THRESHOLD_USD || trade.amount >= SAVE_THRESHOLD_BTC;
}

// ============================================================
// BTC OPTIONS FLOW & WHALE DASHBOARD
// ============================================================

const DERIBIT_API = "https://www.deribit.com/api/v2/public";

const MAJOR_THRESHOLD_USD = 1_000_000;
const MASSIVE_THRESHOLD_USD = 10_000_000;

// Dark terminal color palette
const C = {
  bg: "#0a0b0e",
  bgCard: "#111318",
  bgCardHover: "#161922",
  border: "#1e2130",
  borderActive: "#2a3050",
  text: "#c8cdd8",
  textDim: "#5a6178",
  textMuted: "#3a4058",
  accent: "#4a9eff",
  green: "#22c55e",
  greenDim: "#16a34a22",
  red: "#ef4444",
  redDim: "#ef444422",
  yellow: "#eab308",
  yellowDim: "#eab30822",
  purple: "#a855f7",
  purpleDim: "#a855f722",
  cyan: "#06b6d4",
  gold: "#f59e0b",
  goldDim: "#f59e0b18",
  goldBorder: "#f59e0b44",
  orange: "#f97316",
  orangeDim: "#f9731618",
  orangeBorder: "#f9731644",
};

// ============================================================
// API LAYER
// ============================================================

async function fetchDeribit(endpoint, params = {}) {
  const url = new URL(`${DERIBIT_API}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error(`Deribit API error (${endpoint}):`, err);
    return null;
  }
}

async function fetchBTCPrice() {
  const result = await fetchDeribit("get_index_price", { index_name: "btc_usd" });
  return result?.index_price || 0;
}

async function fetchOptionsTrades(count = 200) {
  const result = await fetchDeribit("get_last_trades_by_currency", {
    currency: "BTC",
    kind: "option",
    count: count.toString(),
    sorting: "desc",
  });
  return result?.trades || [];
}

async function fetchBookSummary() {
  const result = await fetchDeribit("get_book_summary_by_currency", {
    currency: "BTC",
    kind: "option",
  });
  return result || [];
}

function parseInstrument(name) {
  const parts = name.split("-");
  if (parts.length < 4) return null;
  return {
    asset: parts[0],
    expiry: parts[1],
    strike: parseFloat(parts[2]),
    type: parts[3], // P or C
  };
}

function parseDTE(expiryStr) {
  if (!expiryStr) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const day = parseInt(expiryStr.slice(0, 2));
  const mon = months[expiryStr.slice(2, 5)];
  const yr = 2000 + parseInt(expiryStr.slice(5));
  if (isNaN(day) || mon === undefined || isNaN(yr)) return null;
  const exp = new Date(yr, mon, day, 8, 0); // Deribit settles 08:00 UTC
  const now = new Date();
  return Math.max(0, Math.round((exp - now) / 86400000));
}

function interpretTrade(type, strike, direction, amount, btcPrice, expiry) {
  if (!btcPrice) return "No price data";

  const isPut = type === "P";
  const isBuy = direction === "buy";
  const dist = (strike - btcPrice) / btcPrice * 100; // positive = above spot
  const absDist = Math.abs(dist);
  const dte = parseDTE(expiry);
  const sk = `$${strike.toLocaleString()}`;

  // ── Moneyness zones ──
  let moneyness;
  if (isPut) {
    if (dist > 5) moneyness = "deep_itm";
    else if (dist > 1) moneyness = "itm";
    else if (dist >= -3) moneyness = "atm";
    else if (dist >= -10) moneyness = "otm";
    else if (dist >= -20) moneyness = "far_otm";
    else moneyness = "deep_otm";
  } else {
    if (dist < -5) moneyness = "deep_itm";
    else if (dist < -1) moneyness = "itm";
    else if (dist <= 3) moneyness = "atm";
    else if (dist <= 10) moneyness = "otm";
    else if (dist <= 20) moneyness = "far_otm";
    else moneyness = "deep_otm";
  }

  // ── DTE context ──
  let dteTag = "";
  let dteContext = "";
  if (dte !== null) {
    if (dte <= 2) { dteTag = "expiring"; dteContext = "expires within hours — pure gamma play"; }
    else if (dte <= 7) { dteTag = "weekly"; dteContext = `${dte}d out — short-term tactical`; }
    else if (dte <= 30) { dteTag = "near"; dteContext = `${dte}d out`; }
    else if (dte <= 90) { dteTag = "medium"; dteContext = `${dte}d out — strategic timeframe`; }
    else { dteTag = "leaps"; dteContext = `${dte}d out — long-dated structural view`; }
  }

  // ── Size qualifier ──
  let sizeQ = "";
  if (amount >= 200) sizeQ = "Market-moving size";
  else if (amount >= 50) sizeQ = "Institutional block";
  else if (amount >= 25) sizeQ = "Large positioning";
  else if (amount >= 5) sizeQ = "Meaningful size";

  // ── Build interpretation ──
  let main = "";

  if (isPut && isBuy) {
    // PUT BUY
    if (moneyness === "deep_otm" || moneyness === "far_otm") {
      if (dteTag === "expiring" || dteTag === "weekly") {
        main = `Deep OTM put buy at ${sk} (${absDist.toFixed(0)}% below spot), ${dteContext}. Binary bet on a crash — this only pays if BTC falls hard and fast. Low probability, asymmetric payoff.`;
      } else if (dteTag === "leaps") {
        main = `Far OTM put at ${sk}, ${dteContext}. Tail-risk insurance — someone is paying premium to protect against a major drawdown below ${sk} over the coming months. Likely hedging a large spot or perps position.`;
      } else {
        main = `OTM put buy at ${sk} (${absDist.toFixed(0)}% below spot). Downside protection targeting a floor at ${sk}. ${amount >= 25 ? "At this size, likely a portfolio hedge rather than a directional bet." : "Could be hedging or speculating on a downside move."}`;
      }
    } else if (moneyness === "otm") {
      main = `Put buy ${absDist.toFixed(0)}% below spot at ${sk}. Classic hedge — establishing a downside floor. ${amount >= 50 ? "Institutional-sized protection; someone with real exposure is buying insurance here." : `Targeting protection at ${sk} if spot breaks current support.`}`;
    } else if (moneyness === "atm") {
      main = `ATM put buy at ${sk} — high-conviction downside play. Paying full premium for near-the-money protection. ${amount >= 25 ? "This size at-the-money is expensive; signals urgency or strong directional view." : "Expects a move lower from current levels."}`;
    } else {
      main = `ITM put buy at ${sk} — paying intrinsic value for delta exposure. ${moneyness === "deep_itm" ? "Acting as a synthetic short with limited downside risk. Sophisticated directional positioning." : "Aggressive bearish stance — wants immediate negative delta."}`;
    }
  } else if (isPut && !isBuy) {
    // PUT SELL
    if (moneyness === "deep_otm" || moneyness === "far_otm") {
      main = `Selling far OTM puts at ${sk} (${absDist.toFixed(0)}% below spot). Collecting premium on a crash-level strike — willing to buy BTC at ${sk} if assigned. ${amount >= 25 ? "At this size, a confident structural bull or systematic premium seller." : "Bullish lean — betting this level won't be reached."}`;
    } else if (moneyness === "otm") {
      main = `Put sell at ${sk}, ${absDist.toFixed(0)}% below spot. Premium harvesting — getting paid to agree to buy BTC at ${sk}. ${dteTag === "weekly" || dteTag === "expiring" ? "Near expiry makes rapid theta decay favorable for the seller." : `Bullish-neutral view: profits as long as BTC stays above ${sk}.`}`;
    } else if (moneyness === "atm") {
      main = `Selling ATM puts at ${sk} — maximum premium collection near the money. This is a vol-selling strategy, bullish-neutral view. ${amount >= 50 ? "Institutional vol sale — likely running a systematic short-vol book or cash-secured put strategy." : "Expects BTC to hold current levels or move higher."}`;
    } else {
      main = `Selling ITM puts at ${sk}. ${moneyness === "deep_itm" ? "Likely closing an existing long put rather than initiating — closing out previous protection." : "Could be unwinding a hedge (closing a put position) or expressing a strong bullish view at this level."}`;
    }
  } else if (!isPut && isBuy) {
    // CALL BUY
    if (moneyness === "deep_otm" || moneyness === "far_otm") {
      if (dteTag === "expiring" || dteTag === "weekly") {
        main = `Deep OTM call at ${sk} (${absDist.toFixed(0)}% above spot), ${dteContext}. Cheap gamma lottery — needs an explosive upside move to pay off. Very low cost, very low probability.`;
      } else if (dteTag === "leaps") {
        main = `Far OTM call at ${sk}, ${dteContext}. Long-term bullish thesis — betting BTC reaches ${sk} over the coming months. Cheap entry for a structural upside view.`;
      } else {
        main = `OTM call buy ${absDist.toFixed(0)}% above spot at ${sk}. Speculating on a leg higher. ${amount >= 25 ? "Size here suggests conviction in a specific upside catalyst or breakout level." : "Asymmetric upside bet — limited downside to premium paid."}`;
      }
    } else if (moneyness === "otm") {
      main = `Call buy at ${sk}, ${absDist.toFixed(0)}% above spot. Bullish positioning targeting a move to ${sk}+. ${dteTag === "medium" || dteTag === "leaps" ? "Longer timeframe gives this trade room to work — not a short-term punt." : "Near-term directional bet on upside."}`;
    } else if (moneyness === "atm") {
      main = `ATM call buy at ${sk} — maximum gamma, high-conviction bullish. Paying top premium for immediate upside exposure. ${amount >= 50 ? "Institutional call buyer near the money — this is a strong directional signal." : "Expects an imminent move higher from current levels."}`;
    } else {
      main = `ITM call buy at ${sk} — paying intrinsic value for leveraged long exposure. ${moneyness === "deep_itm" ? "Deep ITM acts like a synthetic long with limited loss. Delta-one substitute." : "Aggressive long entry — wants immediate positive delta with less time-decay risk than ATM."}`;
    }
  } else {
    // CALL SELL
    if (moneyness === "deep_otm" || moneyness === "far_otm") {
      main = `Selling far OTM calls at ${sk} (${absDist.toFixed(0)}% above spot). Earning premium on an upside level unlikely to be hit. ${amount >= 25 ? "Systematic income strategy — likely a covered call against a spot position." : `Betting BTC stays below ${sk} through expiry.`}`;
    } else if (moneyness === "otm") {
      main = `Call sell at ${sk}, ${absDist.toFixed(0)}% above spot. Capping upside — either a covered call against a long position or a bearish lean. ${amount >= 50 ? "At this size, most likely covered — writing calls against a BTC holding to generate income." : `Collecting premium, expects BTC stays below ${sk}.`}`;
    } else if (moneyness === "atm") {
      main = `Selling ATM calls at ${sk} — bearish or vol-selling play. Maximum premium near the money, but high risk if spot rallies. ${amount >= 25 ? "Likely part of a structured position (straddle, strangle, or covered call)." : "Directionally neutral-to-bearish at current levels."}`;
    } else {
      main = `Selling ITM calls at ${sk}. ${moneyness === "deep_itm" ? "Likely closing an existing long call position — taking profit on a previous bullish trade." : `Either closing a position or expressing strong conviction that BTC won't stay above ${sk}.`}`;
    }
  }

  // Append size qualifier if significant
  if (sizeQ && amount >= 25) {
    main += ` ${sizeQ} (${amount.toFixed(0)} BTC).`;
  }

  return main;
}

// ============================================================
// COMPONENTS
// ============================================================

function LoadingDots() {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const i = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 400);
    return () => clearInterval(i);
  }, []);
  return <span style={{ color: C.textDim, fontFamily: "monospace" }}>loading{dots}</span>;
}

function StatCard({ label, value, sub, color, icon }) {
  return (
    <div style={{
      background: C.bgCard,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "16px 20px",
      flex: 1,
      minWidth: 180,
      transition: "border-color 0.2s",
    }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = C.borderActive)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
    >
      <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" }}>
        {icon && <span style={{ marginRight: 6 }}>{icon}</span>}{label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || C.text, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: C.textDim, marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>{sub}</div>}
    </div>
  );
}

function SentimentBar({ putVol, callVol }) {
  const total = putVol + callVol;
  if (total === 0) return null;
  const putPct = (putVol / total) * 100;
  const callPct = (callVol / total) * 100;
  const ratio = callVol > 0 ? (putVol / callVol).toFixed(2) : "∞";

  let sentiment, sentColor;
  if (ratio > 1.5) { sentiment = "HEAVILY HEDGED"; sentColor = C.red; }
  else if (ratio > 1.0) { sentiment = "CAUTIOUS"; sentColor = C.yellow; }
  else if (ratio > 0.7) { sentiment = "BALANCED"; sentColor = C.textDim; }
  else { sentiment = "BULLISH FLOW"; sentColor = C.green; }

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, fontFamily: "'JetBrains Mono', monospace" }}>
          Put / Call Flow
        </div>
        <div style={{
          fontSize: 11,
          color: sentColor,
          fontWeight: 700,
          padding: "3px 10px",
          borderRadius: 4,
          background: sentColor + "18",
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: 0.8,
        }}>
          {sentiment}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: C.red, fontFamily: "'JetBrains Mono', monospace", minWidth: 80 }}>
          PUT {putPct.toFixed(0)}%
        </span>
        <div style={{ flex: 1, height: 8, background: C.border, borderRadius: 4, overflow: "hidden", display: "flex" }}>
          <div style={{ width: `${putPct}%`, background: C.red, borderRadius: "4px 0 0 4px", transition: "width 0.5s" }} />
          <div style={{ width: `${callPct}%`, background: C.green, borderRadius: "0 4px 4px 0", transition: "width 0.5s" }} />
        </div>
        <span style={{ fontSize: 13, color: C.green, fontFamily: "'JetBrains Mono', monospace", minWidth: 80, textAlign: "right" }}>
          {callPct.toFixed(0)}% CALL
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.textDim, fontFamily: "'JetBrains Mono', monospace", textAlign: "center" }}>
        P/C Ratio: <span style={{ color: C.text, fontWeight: 600 }}>{ratio}</span> · Puts: {putVol.toFixed(1)} BTC · Calls: {callVol.toFixed(1)} BTC
      </div>
    </div>
  );
}

function TradeRow({ trade, btcPrice, index }) {
  const parsed = parseInstrument(trade.instrument_name);
  if (!parsed) return null;

  const isPut = parsed.type === "P";
  const isBuy = trade.direction === "buy";
  const amount = trade.amount;
  const interp = interpretTrade(parsed.type, parsed.strike, trade.direction, amount, btcPrice, parsed.expiry);

  let sizeLabel = "";
  let sizeBg = "transparent";
  if (amount >= 100) { sizeLabel = "WHALE"; sizeBg = C.purpleDim; }
  else if (amount >= 25) { sizeLabel = "LARGE"; sizeBg = C.accent + "22"; }
  else if (amount >= 5) { sizeLabel = "NOTABLE"; sizeBg = C.textMuted + "44"; }

  const distPct = btcPrice > 0 ? ((parsed.strike - btcPrice) / btcPrice * 100).toFixed(1) : "—";
  const ts = new Date(trade.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="trade-row" style={{
      display: "grid",
      gridTemplateColumns: "70px 52px 50px 85px 65px 72px 62px 55px minmax(200px, 1fr)",
      alignItems: "start",
      padding: "10px 16px",
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      background: index % 2 === 0 ? "transparent" : C.bgCard + "60",
      borderBottom: `1px solid ${C.border}44`,
      gap: 8,
      transition: "background 0.15s",
      cursor: "default",
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.bgCardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = index % 2 === 0 ? "transparent" : C.bgCard + "60")}
    >
      <span style={{ color: C.textDim }}>{ts}</span>
      <span style={{
        color: isPut ? C.red : C.green,
        fontWeight: 700,
        padding: "2px 6px",
        borderRadius: 3,
        background: isPut ? C.redDim : C.greenDim,
        textAlign: "center",
        fontSize: 11,
      }}>
        {isPut ? "PUT" : "CALL"}
      </span>
      <span style={{
        color: isBuy ? C.green : C.red,
        fontSize: 11,
        textAlign: "center",
      }}>
        {isBuy ? "BUY" : "SELL"}
      </span>
      <span style={{ color: C.text, fontWeight: 600 }}>${parsed.strike.toLocaleString()}</span>
      <span style={{ color: parseFloat(distPct) > 0 ? C.green : parseFloat(distPct) < 0 ? C.red : C.textDim }}>
        {distPct > 0 ? "+" : ""}{distPct}%
      </span>
      <span style={{ color: C.text, fontWeight: 600 }}>{amount.toFixed(1)}</span>
      <span style={{ color: C.textDim }}>{parsed.expiry}</span>
      {sizeLabel ? (
        <span style={{
          fontSize: 9,
          fontWeight: 700,
          color: sizeLabel === "WHALE" ? C.purple : sizeLabel === "LARGE" ? C.accent : C.textDim,
          background: sizeBg,
          padding: "2px 6px",
          borderRadius: 3,
          textAlign: "center",
          letterSpacing: 0.8,
        }}>{sizeLabel}</span>
      ) : <span />}
      <span style={{ color: C.textDim, fontSize: 11, lineHeight: 1.5 }}>
        {interp}
      </span>
    </div>
  );
}

function StrikeHeatmap({ trades, btcPrice, type }) {
  const strikeMap = {};
  trades.forEach((t) => {
    const parsed = parseInstrument(t.instrument_name);
    if (!parsed || parsed.type !== type) return;
    const key = parsed.strike;
    if (!strikeMap[key]) strikeMap[key] = { buy: 0, sell: 0, total: 0 };
    strikeMap[key][t.direction] += t.amount;
    strikeMap[key].total += t.amount;
  });

  const sorted = Object.entries(strikeMap)
    .map(([strike, data]) => ({ strike: parseFloat(strike), ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  const maxVol = Math.max(...sorted.map((s) => s.total), 1);
  const isPut = type === "P";
  const color = isPut ? C.red : C.green;
  const dimColor = isPut ? C.redDim : C.greenDim;

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
      <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 16, fontFamily: "'JetBrains Mono', monospace" }}>
        {isPut ? "🔴" : "🟢"} Top {type === "P" ? "Put" : "Call"} Strikes by Volume
      </div>
      {sorted.length === 0 ? (
        <div style={{ color: C.textMuted, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>No data yet</div>
      ) : (
        sorted.map((s) => {
          const pct = btcPrice > 0 ? ((s.strike - btcPrice) / btcPrice * 100).toFixed(1) : "—";
          const barWidth = (s.total / maxVol) * 100;
          return (
            <div key={s.strike} style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 10, fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ fontSize: 12, color: C.text, fontWeight: 600, minWidth: 75, textAlign: "right" }}>
                ${s.strike.toLocaleString()}
              </span>
              <span style={{
                fontSize: 10,
                color: parseFloat(pct) > 0 ? C.green : parseFloat(pct) < 0 ? C.red : C.textDim,
                minWidth: 52,
                textAlign: "right",
              }}>
                {pct > 0 ? "+" : ""}{pct}%
              </span>
              <div style={{ flex: 1, height: 18, background: C.border + "60", borderRadius: 3, overflow: "hidden", position: "relative" }}>
                <div style={{
                  width: `${barWidth}%`,
                  height: "100%",
                  background: `linear-gradient(90deg, ${dimColor}, ${color}44)`,
                  borderRadius: 3,
                  transition: "width 0.4s",
                }} />
                <span style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 10,
                  color: C.textDim,
                }}>{s.total.toFixed(1)} BTC</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function ExpiryBreakdown({ trades, btcPrice }) {
  const expiryMap = {};
  trades.forEach((t) => {
    const parsed = parseInstrument(t.instrument_name);
    if (!parsed) return;
    const key = parsed.expiry;
    if (!expiryMap[key]) expiryMap[key] = { puts: 0, calls: 0, total: 0, putBuy: 0, callBuy: 0 };
    if (parsed.type === "P") {
      expiryMap[key].puts += t.amount;
      if (t.direction === "buy") expiryMap[key].putBuy += t.amount;
    } else {
      expiryMap[key].calls += t.amount;
      if (t.direction === "buy") expiryMap[key].callBuy += t.amount;
    }
    expiryMap[key].total += t.amount;
  });

  const sorted = Object.entries(expiryMap)
    .map(([expiry, data]) => ({ expiry, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
      <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 16, fontFamily: "'JetBrains Mono', monospace" }}>
        📅 Volume by Expiry
      </div>
      {sorted.map((e) => {
        const pcr = e.calls > 0 ? (e.puts / e.calls).toFixed(2) : "∞";
        return (
          <div key={e.expiry} style={{
            display: "grid",
            gridTemplateColumns: "80px 1fr 1fr 60px",
            gap: 12,
            padding: "8px 0",
            borderBottom: `1px solid ${C.border}33`,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            alignItems: "center",
          }}>
            <span style={{ color: C.text, fontWeight: 600 }}>{e.expiry}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: C.red, fontSize: 11 }}>P</span>
              <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  width: `${e.total > 0 ? (e.puts / e.total) * 100 : 0}%`,
                  height: "100%",
                  background: C.red,
                  borderRadius: 3,
                }} />
              </div>
              <span style={{ color: C.textDim, fontSize: 11, minWidth: 55 }}>{e.puts.toFixed(1)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: C.green, fontSize: 11 }}>C</span>
              <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  width: `${e.total > 0 ? (e.calls / e.total) * 100 : 0}%`,
                  height: "100%",
                  background: C.green,
                  borderRadius: 3,
                }} />
              </div>
              <span style={{ color: C.textDim, fontSize: 11, minWidth: 55 }}>{e.calls.toFixed(1)}</span>
            </div>
            <span style={{ color: pcr > 1.5 ? C.red : pcr > 1 ? C.yellow : C.textDim, textAlign: "right", fontSize: 11 }}>
              {pcr}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MarketInterpretation({ trades, btcPrice, putVol, callVol }) {
  const insights = [];

  // P/C ratio analysis
  const pcr = callVol > 0 ? putVol / callVol : 0;
  if (pcr > 1.5) {
    insights.push({
      type: "bearish",
      title: "Heavy Put Activity",
      text: `P/C ratio at ${pcr.toFixed(2)} — well above neutral. Market is aggressively hedging downside or positioning bearish. Look for concentrated put strikes below as potential target levels.`,
    });
  } else if (pcr < 0.5) {
    insights.push({
      type: "bullish",
      title: "Call-Dominated Flow",
      text: `P/C ratio at ${pcr.toFixed(2)} — calls dominating. Bullish positioning or upside hedging by shorts. If accompanied by spot buying (positive CVD), this is a strong bullish signal.`,
    });
  }

  // Large put concentration
  const putStrikes = {};
  let totalLargePutVol = 0;
  trades.forEach((t) => {
    const p = parseInstrument(t.instrument_name);
    if (!p || p.type !== "P") return;
    if (t.amount >= 5) {
      putStrikes[p.strike] = (putStrikes[p.strike] || 0) + t.amount;
      totalLargePutVol += t.amount;
    }
  });

  const topPutStrike = Object.entries(putStrikes).sort((a, b) => b[1] - a[1])[0];
  if (topPutStrike && topPutStrike[1] > 20 && btcPrice > 0) {
    const strike = parseFloat(topPutStrike[0]);
    const distPct = ((strike - btcPrice) / btcPrice * 100);
    const distLabel = `${Math.abs(distPct).toFixed(1)}% ${distPct >= 0 ? "above" : "below"} spot`;
    const isITM = strike >= btcPrice; // Put is ITM when strike >= spot
    const vol = topPutStrike[1].toFixed(1);

    let putInsight;
    if (isITM && distPct > 5) {
      putInsight = {
        type: "bearish",
        title: `Concentrated ITM Puts at $${strike.toLocaleString()}`,
        text: `${vol} BTC in deep ITM puts at $${strike.toLocaleString()} (${distLabel}). These puts already have significant intrinsic value. Heavy ITM put volume signals active bearish positioning or institutions locking in downside gains. Smart money may be expecting continued weakness below current levels.`,
      };
    } else if (isITM) {
      putInsight = {
        type: "warning",
        title: `Concentrated Puts Near/Above Spot at $${strike.toLocaleString()}`,
        text: `${vol} BTC in puts at $${strike.toLocaleString()} (${distLabel}). These are at-the-money or slightly ITM — maximum gamma and premium. This is aggressive downside positioning, not a distant hedge. Traders here are actively betting on or protecting against a move lower from current levels.`,
      };
    } else if (Math.abs(distPct) < 10) {
      putInsight = {
        type: "info",
        title: `Concentrated Puts at $${strike.toLocaleString()}`,
        text: `${vol} BTC in puts at $${strike.toLocaleString()} (${distLabel}). This is a key hedging floor — large players are establishing downside protection here. If spot approaches this level, expect put delta hedging to accelerate selling pressure. Cross-reference with your liquidation heatmap.`,
      };
    } else {
      putInsight = {
        type: "info",
        title: `Far OTM Puts Concentrated at $${strike.toLocaleString()}`,
        text: `${vol} BTC in puts at $${strike.toLocaleString()} (${distLabel}). Tail-risk insurance at a distant strike — large players are protecting against a black-swan crash scenario. Low probability of hitting, but the volume suggests real concern about extreme downside risk.`,
      };
    }
    insights.push(putInsight);
  }

  // Whale activity
  const whaleTrades = trades.filter((t) => t.amount >= 50);
  if (whaleTrades.length > 0) {
    const whalePuts = whaleTrades.filter((t) => parseInstrument(t.instrument_name)?.type === "P");
    const whaleCalls = whaleTrades.filter((t) => parseInstrument(t.instrument_name)?.type === "C");
    insights.push({
      type: whalePuts.length > whaleCalls.length ? "bearish" : "bullish",
      title: `${whaleTrades.length} Whale Trade${whaleTrades.length > 1 ? "s" : ""} Detected`,
      text: `${whalePuts.length} whale puts vs ${whaleCalls.length} whale calls. ${whalePuts.length > whaleCalls.length
        ? "Large players are buying downside protection — they either hold longs they want to hedge or are making directional bearish bets."
        : "Large players are positioning for upside — either covering shorts via calls or making directional bullish bets."}`,
    });
  }

  // Near-money put buying (hedging signal)
  if (btcPrice > 0) {
    const nearMoneyPutBuys = trades.filter((t) => {
      const p = parseInstrument(t.instrument_name);
      if (!p || p.type !== "P" || t.direction !== "buy") return false;
      const strikeDistPct = (p.strike - btcPrice) / btcPrice;
      // Only count puts at or below spot (OTM/ATM puts) — ITM put buys are a different signal
      return strikeDistPct <= 0.02 && Math.abs(strikeDistPct) < 0.05 && t.amount >= 5;
    });

    const totalNearPutVol = nearMoneyPutBuys.reduce((sum, t) => sum + t.amount, 0);
    if (totalNearPutVol > 10) {
      insights.push({
        type: "warning",
        title: "Active Hedging Near Spot",
        text: `${totalNearPutVol.toFixed(1)} BTC in near-the-money put buying (within 5% of spot, at or below current price). Large players are buying downside protection at current levels — this is classic institutional hedging. Expect increased implied vol at these strikes and potential delta-hedge selling if spot dips further.`,
      });
    }
  }

  if (insights.length === 0) {
    insights.push({
      type: "neutral",
      title: "No Strong Signals",
      text: "Options flow is balanced with no outsized positioning. Market is in a wait-and-see mode. Monitor for changes in P/C ratio or sudden large trades.",
    });
  }

  const typeColors = {
    bearish: C.red,
    bullish: C.green,
    warning: C.yellow,
    info: C.cyan,
    neutral: C.textDim,
  };

  const typeIcons = {
    bearish: "🔴",
    bullish: "🟢",
    warning: "⚠️",
    info: "💡",
    neutral: "⚪",
  };

  const [showAll, setShowAll] = useState(false);
  const visibleInsights = showAll ? insights : insights.slice(0, 2);
  const hasMore = insights.length > 2;

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
      <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 16, fontFamily: "'JetBrains Mono', monospace" }}>
        🧠 Market Interpretation
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {visibleInsights.map((ins, i) => (
          <div key={i} style={{
            padding: "14px 16px",
            borderRadius: 6,
            borderLeft: `3px solid ${typeColors[ins.type]}`,
            background: typeColors[ins.type] + "08",
          }}>
            <div style={{
              fontSize: 13,
              fontWeight: 700,
              color: typeColors[ins.type],
              marginBottom: 6,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {typeIcons[ins.type]} {ins.title}
            </div>
            <div style={{
              fontSize: 12,
              color: C.text,
              lineHeight: 1.6,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {ins.text}
            </div>
          </div>
        ))}
        {hasMore && (
          <button
            onClick={() => setShowAll(!showAll)}
            style={{
              background: "none", border: `1px solid ${C.border}`, color: C.accent,
              padding: "6px 14px", borderRadius: 4, cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              alignSelf: "center", transition: "all 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.background = C.accent + "11"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = "none"; }}
          >
            {showAll ? "Show less" : `Show ${insights.length - 2} more`}
          </button>
        )}
      </div>
    </div>
  );
}

function SavedTradesPanel({ btcPrice }) {
  const [savedTrades, setSavedTrades] = useState(() => loadSavedTrades());
  const [expanded, setExpanded] = useState(true);
  const [sortMode, setSortMode] = useState("weighted"); // "weighted" | "size" | "recent"

  // Load from Supabase API on mount, merge with localStorage
  useEffect(() => {
    let cancelled = false;
    loadTradesFromAPI().then(apiTrades => {
      if (cancelled || !apiTrades.length) return;
      setSavedTrades(prev => {
        const merged = mergeTrades(prev, apiTrades);
        persistTrades(merged); // sync to localStorage too
        return merged;
      });
    });
    return () => { cancelled = true; };
  }, []);

  // Refresh: merge localStorage + API periodically
  useEffect(() => {
    const i = setInterval(() => {
      const local = loadSavedTrades();
      setSavedTrades(local);
    }, 5000);
    // Also sync from API every 30s to pick up cron-captured trades
    const apiSync = setInterval(() => {
      loadTradesFromAPI().then(apiTrades => {
        if (!apiTrades.length) return;
        setSavedTrades(prev => {
          const merged = mergeTrades(prev, apiTrades);
          persistTrades(merged);
          return merged;
        });
      });
    }, 30000);
    return () => { clearInterval(i); clearInterval(apiSync); };
  }, []);

  const handleClear = () => {
    if (window.confirm(`Clear all ${savedTrades.length} saved trades?`)) {
      persistTrades([]);
      setSavedTrades([]);
    }
  };

  const whaleCount = savedTrades.filter((t) => t.amount >= 50).length;
  const majorCount = savedTrades.filter((t) => { const n = t.notionalUsd || 0; return n >= MAJOR_THRESHOLD_USD && n < MASSIVE_THRESHOLD_USD; }).length;
  const massiveCount = savedTrades.filter((t) => (t.notionalUsd || 0) >= MASSIVE_THRESHOLD_USD).length;
  const totalNotional = savedTrades.reduce((sum, t) => sum + (t.notionalUsd || 0), 0);

  // Helper: get DTE for a trade
  const getDTE = (trade) => {
    const p = parseInstrument(trade.instrument_name);
    if (!p) return null;
    return parseDTE(p.expiry);
  };

  // Sort based on selected mode
  const sortedTrades = [...savedTrades].sort((a, b) => {
    const aN = a.notionalUsd || 0;
    const bN = b.notionalUsd || 0;
    const aT = a.timestamp || 0;
    const bT = b.timestamp || 0;

    if (sortMode === "size") {
      return bN - aN || bT - aT;
    }
    if (sortMode === "recent") {
      return bT - aT;
    }
    // Weighted: expiry-aware sorting
    // Priority: (1) Active trades over expired, (2) Tier, (3) DTE urgency, (4) Recency
    const aDTE = getDTE(a);
    const bDTE = getDTE(b);
    const aExpired = aDTE !== null && aDTE <= 0;
    const bExpired = bDTE !== null && bDTE <= 0;

    // Expired trades always sort below active ones
    if (aExpired !== bExpired) return aExpired ? 1 : -1;

    // Tier assignment
    const aTier = aN >= MASSIVE_THRESHOLD_USD ? 3 : aN >= MAJOR_THRESHOLD_USD ? 2 : aN >= 500_000 ? 1 : 0;
    const bTier = bN >= MASSIVE_THRESHOLD_USD ? 3 : bN >= MAJOR_THRESHOLD_USD ? 2 : bN >= 500_000 ? 1 : 0;

    // Different tiers → higher tier wins
    if (aTier !== bTier) return bTier - aTier;

    // Same tier — if both active, boost near-term (lower DTE = more urgent)
    if (!aExpired && !bExpired && aDTE !== null && bDTE !== null) {
      // Near-term (≤7 DTE) trades get priority within same tier
      const aNearTerm = aDTE <= 7 ? 1 : 0;
      const bNearTerm = bDTE <= 7 ? 1 : 0;
      if (aNearTerm !== bNearTerm) return bNearTerm - aNearTerm;
      // Both near-term or both not → most urgent (lowest DTE) first
      if (aDTE !== bDTE) return aDTE - bDTE;
    }

    // Final tiebreaker: most recent first
    return bT - aT;
  });

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
      {/* Header — always visible */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="whale-toolbar"
        style={{
          padding: "14px 20px",
          borderBottom: expanded ? `1px solid ${C.border}` : "none",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.bgCardHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, fontFamily: "'JetBrains Mono', monospace" }}>
            💾 Saved Whale Trades
          </span>
          <span style={{
            fontSize: 10, color: C.purple, fontWeight: 700, padding: "2px 8px",
            background: C.purpleDim, borderRadius: 4, fontFamily: "'JetBrains Mono', monospace",
          }}>
            {savedTrades.length} saved
          </span>
          {massiveCount > 0 && (
            <span style={{
              fontSize: 10, color: C.gold, fontWeight: 700, padding: "2px 8px",
              background: C.goldDim, borderRadius: 4, fontFamily: "'JetBrains Mono', monospace",
              border: `1px solid ${C.goldBorder}`,
            }}>
              {massiveCount} 🔱 $10M+
            </span>
          )}
          {majorCount > 0 && (
            <span style={{
              fontSize: 10, color: C.orange, fontWeight: 700, padding: "2px 8px",
              background: C.orangeDim, borderRadius: 4, fontFamily: "'JetBrains Mono', monospace",
              border: `1px solid ${C.orangeBorder}`,
            }}>
              {majorCount} ⚡ $1M+
            </span>
          )}
          {whaleCount > 0 && (
            <span style={{
              fontSize: 10, color: C.yellow, fontWeight: 700, padding: "2px 8px",
              background: C.yellowDim, borderRadius: 4, fontFamily: "'JetBrains Mono', monospace",
            }}>
              {whaleCount} 🐋
            </span>
          )}
          <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
            ${totalNotional >= 1e6 ? (totalNotional / 1e6).toFixed(1) + "M" : (totalNotional / 1e3).toFixed(0) + "K"} total notional
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {expanded && (
            <div style={{ display: "flex", gap: 2 }}>
              {["weighted", "size", "recent"].map((mode) => (
                <button
                  key={mode}
                  onClick={(e) => { e.stopPropagation(); setSortMode(mode); }}
                  style={{
                    background: sortMode === mode ? C.accent + "22" : "none",
                    border: `1px solid ${sortMode === mode ? C.accent : C.border}`,
                    color: sortMode === mode ? C.accent : C.textMuted,
                    padding: "2px 8px", borderRadius: 3, cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                    textTransform: "uppercase", letterSpacing: 0.5,
                    transition: "all 0.15s",
                  }}
                >
                  {mode === "weighted" ? "⚖ WEIGHTED" : mode === "size" ? "💰 SIZE" : "🕐 RECENT"}
                </button>
              ))}
            </div>
          )}
          <span style={{ color: C.textDim, fontSize: 12, transition: "transform 0.2s", transform: expanded ? "rotate(180deg)" : "rotate(0)" }}>
            ▼
          </span>
        </div>
      </div>

      {/* Expanded table */}
      {expanded && (
        <>
          {/* 🔥 EXPIRING SOON — pinned alert for near-term whale bets */}
          {(() => {
            const expiringSoon = sortedTrades.filter(t => {
              const dte = getDTE(t);
              const n = t.notionalUsd || 0;
              return dte !== null && dte > 0 && dte <= 7 && n >= MAJOR_THRESHOLD_USD;
            }).sort((a, b) => (b.notionalUsd || 0) - (a.notionalUsd || 0));

            if (expiringSoon.length === 0) return null;

            const massiveTrades = expiringSoon.filter(t => (t.notionalUsd || 0) >= MASSIVE_THRESHOLD_USD);
            const majorTrades = expiringSoon.filter(t => {
              const n = t.notionalUsd || 0;
              return n >= MAJOR_THRESHOLD_USD && n < MASSIVE_THRESHOLD_USD;
            });
            const majorTotal = majorTrades.reduce((s, t) => s + (t.notionalUsd || 0), 0);
            const majorPuts = majorTrades.filter(t => { const p = parseInstrument(t.instrument_name); return p?.type === "P"; }).length;
            const majorCalls = majorTrades.length - majorPuts;

            return (
              <div style={{
                margin: "8px 12px", padding: "12px 16px",
                background: `linear-gradient(135deg, ${C.red}12, ${C.gold}08)`,
                border: `1px solid ${C.red}44`, borderRadius: 6,
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: C.red, textTransform: "uppercase",
                  letterSpacing: 1.2, marginBottom: 8,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  🔥 Expiring This Week — {expiringSoon.length} active whale {expiringSoon.length === 1 ? "bet" : "bets"}
                </div>
                {/* MASSIVE trades shown individually */}
                {massiveTrades.map((t, i) => {
                  const p = parseInstrument(t.instrument_name);
                  const dte = getDTE(t);
                  const n = t.notionalUsd || 0;
                  const isPut = p?.type === "P";
                  const spotMove = btcPrice && t.btcPriceAtSave
                    ? ((btcPrice - t.btcPriceAtSave) / t.btcPriceAtSave * 100).toFixed(1)
                    : null;
                  const isBuy = t.direction === "buy";
                  const favorable = isPut
                    ? (isBuy ? parseFloat(spotMove) < 0 : parseFloat(spotMove) > 0)
                    : (isBuy ? parseFloat(spotMove) > 0 : parseFloat(spotMove) < 0);
                  return (
                    <div key={t.trade_id || i} style={{
                      display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px",
                      padding: "8px 0", fontSize: 12,
                      borderTop: i > 0 ? `1px solid ${C.border}44` : "none",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}>
                      <span style={{
                        color: "#fff", background: C.red, padding: "2px 8px", borderRadius: 3,
                        fontWeight: 700, fontSize: 10,
                      }}>
                        {dte}d left
                      </span>
                      <span style={{
                        color: isPut ? C.red : C.green, fontWeight: 700,
                        padding: "2px 6px", borderRadius: 3,
                        background: isPut ? C.redDim : C.greenDim,
                        fontSize: 11,
                      }}>
                        {isPut ? "PUT" : "CALL"}
                      </span>
                      <span style={{ color: C.text, fontWeight: 600 }}>
                        ${p?.strike.toLocaleString()}
                      </span>
                      <span style={{ color: C.text, fontWeight: 600 }}>
                        {t.amount.toFixed(1)} BTC
                      </span>
                      <span style={{ color: C.gold, fontWeight: 700 }}>
                        ${n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : (n / 1e3).toFixed(0) + "K"}
                      </span>
                      <span style={{ color: C.gold, fontSize: 9, fontWeight: 700, padding: "2px 6px", background: C.goldDim, borderRadius: 3, border: `1px solid ${C.goldBorder}` }}>
                        🔱 MASSIVE
                      </span>
                      {spotMove && (
                        <span style={{ color: favorable ? C.green : C.red, fontSize: 10, fontWeight: 600 }}>
                          Spot {parseFloat(spotMove) > 0 ? "+" : ""}{spotMove}% since entry {favorable ? "✓" : "✗"}
                        </span>
                      )}
                    </div>
                  );
                })}
                {/* MAJOR trades aggregated into summary */}
                {majorTrades.length > 0 && (
                  <div style={{
                    padding: "8px 0", fontSize: 11,
                    borderTop: massiveTrades.length > 0 ? `1px solid ${C.border}44` : "none",
                    fontFamily: "'JetBrains Mono', monospace",
                    color: C.textDim,
                    display: "flex", flexWrap: "wrap", gap: "6px 10px", alignItems: "center",
                  }}>
                    <span style={{ color: C.orange, fontWeight: 700 }}>
                      + {majorTrades.length} MAJOR {majorTrades.length === 1 ? "trade" : "trades"}
                    </span>
                    <span style={{ color: C.orange, fontWeight: 600, fontSize: 11 }}>
                      ${majorTotal >= 1e6 ? (majorTotal / 1e6).toFixed(1) + "M" : (majorTotal / 1e3).toFixed(0) + "K"} total
                    </span>
                    {(majorPuts > 0 || majorCalls > 0) && (
                      <span style={{ color: C.textMuted, fontSize: 10 }}>
                        ({majorPuts > 0 ? `${majorPuts}P` : ""}{majorPuts > 0 && majorCalls > 0 ? " / " : ""}{majorCalls > 0 ? `${majorCalls}C` : ""})
                      </span>
                    )}
                    <span style={{ color: C.textMuted, fontSize: 10 }}>
                      expiring ≤7d
                    </span>
                  </div>
                )}
              </div>
            );
          })()}
          <div className="whale-header" style={{
            display: "grid",
            gridTemplateColumns: "130px 52px 50px 85px 65px 72px 72px 90px 75px minmax(200px, 1fr)",
            padding: "8px 16px", fontSize: 10, color: C.textMuted,
            textTransform: "uppercase", letterSpacing: 1,
            borderBottom: `1px solid ${C.border}`, gap: 8,
          }}>
            <span>Date</span><span>Type</span><span>Side</span><span>Strike</span>
            <span>Dist</span><span>Size</span><span>Expiry</span><span>Notional</span><span>Tag</span>
            <span>Interpretation</span>
          </div>
          <div style={{ position: "relative" }}>
            <div style={{ maxHeight: 400, overflowY: "auto" }}>
              {savedTrades.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                  No trades saved yet. Trades over $500K notional or ≥50 BTC are auto-saved.
                </div>
              ) : (
                (() => {
                  // Pre-compute strike-level aggregation
                  const strikeAgg = {};
                  savedTrades.forEach(tr => {
                    const p = parseInstrument(tr.instrument_name);
                    if (!p) return;
                    const key = `${p.strike}_${p.type}`;
                    if (!strikeAgg[key]) strikeAgg[key] = { count: 0, totalNotional: 0, expiries: new Set(), tradeIds: new Set() };
                    strikeAgg[key].count++;
                    strikeAgg[key].totalNotional += (tr.notionalUsd || 0);
                    if (p.expiry) strikeAgg[key].expiries.add(p.expiry);
                    strikeAgg[key].tradeIds.add(tr.trade_id || tr.instrument_name + tr.timestamp);
                  });

                  // Pre-compute direction clustering (nearby strikes, same type + direction)
                  // Groups trades within ~15% of each other into "corridors"
                  const directionClusters = {};
                  savedTrades.forEach(tr => {
                    const p = parseInstrument(tr.instrument_name);
                    if (!p) return;
                    const clusterKey = `${p.type}_${tr.direction}`;
                    if (!directionClusters[clusterKey]) directionClusters[clusterKey] = [];
                    directionClusters[clusterKey].push({
                      strike: p.strike, notional: tr.notionalUsd || 0,
                      trade_id: tr.trade_id,
                    });
                  });
                  // Build corridor map: for each trade, find if it belongs to a multi-strike cluster
                  const corridorMap = {};
                  Object.entries(directionClusters).forEach(([key, trades]) => {
                    if (trades.length < 3) return; // need 3+ trades to form a corridor
                    const strikes = [...new Set(trades.map(t => t.strike))].sort((a, b) => a - b);
                    if (strikes.length < 2) return; // need at least 2 distinct strikes
                    // Check if strikes are within ~15% range of the median
                    const median = strikes[Math.floor(strikes.length / 2)];
                    const inRange = strikes.filter(s => Math.abs(s - median) / median <= 0.15);
                    if (inRange.length < 2) return;
                    const corridorTrades = trades.filter(t => inRange.includes(t.strike));
                    const totalNotional = corridorTrades.reduce((s, t) => s + t.notional, 0);
                    if (totalNotional < 5e6) return; // Only flag corridors with $5M+ total
                    const corridorInfo = {
                      lowStrike: Math.min(...inRange),
                      highStrike: Math.max(...inRange),
                      strikeCount: inRange.length,
                      totalNotional,
                      tradeCount: corridorTrades.length,
                    };
                    corridorTrades.forEach(t => {
                      corridorMap[t.trade_id] = corridorInfo;
                    });
                  });

                  return sortedTrades.map((t, i) => {
                    const parsed = parseInstrument(t.instrument_name);
                    if (!parsed) return null;
                    const isPut = parsed.type === "P";
                    const isBuy = t.direction === "buy";
                    const spotAtTime = t.btcPriceAtSave || btcPrice;
                    const distPct = spotAtTime > 0 ? ((parsed.strike - spotAtTime) / spotAtTime * 100).toFixed(1) : "—";
                    const interp = interpretTrade(parsed.type, parsed.strike, t.direction, t.amount, spotAtTime, parsed.expiry);

                    // Strike-level context
                    const aggKey = `${parsed.strike}_${parsed.type}`;
                    const agg = strikeAgg[aggKey];
                    let strikeContext = "";
                    let aggInterp = "";
                    if (agg && agg.count >= 2) {
                      const totalStr = agg.totalNotional >= 1e6 ? `$${(agg.totalNotional / 1e6).toFixed(2)}M` : `$${(agg.totalNotional / 1e3).toFixed(0)}K`;
                      const expiryCount = agg.expiries.size;
                      const typeLabel = isPut ? "put" : "call";
                      const expiryNote = expiryCount > 1 ? ` across ${expiryCount} expiries` : "";

                      // Generate upgraded interpretation based on concentration level
                      if (agg.totalNotional >= 20e6) {
                        // $20M+ massive accumulation — reframe the entire read
                        if (isPut && isBuy) {
                          aggInterp = `Part of a concentrated ${totalStr} institutional put position at $${parsed.strike.toLocaleString()}${expiryNote} (${agg.count} trades). This level of accumulation signals a deliberate portfolio-level hedge — likely protecting a very large spot or basis position against a move below $${parsed.strike.toLocaleString()}.`;
                        } else if (isPut && !isBuy) {
                          aggInterp = `Selling into a ${totalStr} concentrated put position at $${parsed.strike.toLocaleString()}${expiryNote} (${agg.count} trades). At this scale, likely premium harvesting by a structured products desk or closing out a portion of a massive hedge.`;
                        } else if (!isPut && isBuy) {
                          aggInterp = `Part of a ${totalStr} concentrated call position at $${parsed.strike.toLocaleString()}${expiryNote} (${agg.count} trades). Aggressive institutional accumulation — building a significant upside position at this strike.`;
                        } else {
                          aggInterp = `Selling into a ${totalStr} concentrated call position at $${parsed.strike.toLocaleString()}${expiryNote} (${agg.count} trades). Likely covered call writing or structured income at scale.`;
                        }
                      } else if (agg.totalNotional >= 10e6) {
                        // $10M+ significant positioning
                        const actionNote = isPut ? (isBuy ? "institutional hedging interest" : "premium collection") : (isBuy ? "bullish conviction" : "overwriting/income");
                        aggInterp = `${interp} Part of ${totalStr} in ${typeLabel} flow at this strike${expiryNote} (${agg.count} trades) — ${actionNote} is building at $${parsed.strike.toLocaleString()}.`;
                      } else {
                        // Under $10M — just add a footnote
                        strikeContext = ` 📊 ${agg.count} ${typeLabel} trades totaling ${totalStr} at $${parsed.strike.toLocaleString()}${expiryNote}.`;
                      }
                    }

                    // Direction corridor context
                    let corridorContext = "";
                    const corridor = corridorMap[t.trade_id];
                    if (corridor && corridor.strikeCount >= 2) {
                      const totalStr = corridor.totalNotional >= 1e6
                        ? `$${(corridor.totalNotional / 1e6).toFixed(1)}M`
                        : `$${(corridor.totalNotional / 1e3).toFixed(0)}K`;
                      const typeLabel = isPut ? "put" : "call";
                      const actionLabel = isPut
                        ? (isBuy ? "downside protection" : "put selling")
                        : (isBuy ? "upside positioning" : "call overwriting");
                      corridorContext = `🔗 ${totalStr} ${typeLabel} corridor from $${corridor.lowStrike.toLocaleString()}–$${corridor.highStrike.toLocaleString()} (${corridor.strikeCount} strikes, ${corridor.tradeCount} trades) — layered ${actionLabel}.`;
                    }

                    // Expired outcome
                    let expiredOutcome = "";
                    const tradeDTE = getDTE(t);
                    if (tradeDTE !== null && tradeDTE <= 0) {
                      const expiredITM = isPut
                        ? btcPrice < parsed.strike
                        : btcPrice > parsed.strike;
                      if (expiredITM) {
                        expiredOutcome = isPut
                          ? `💀 EXPIRED ITM — spot ($${btcPrice.toLocaleString()}) below strike. Position printed.`
                          : `💰 EXPIRED ITM — spot ($${btcPrice.toLocaleString()}) above strike. Position printed.`;
                      } else {
                        expiredOutcome = isPut
                          ? `📋 EXPIRED OTM — spot held above $${parsed.strike.toLocaleString()}. Hedge cost absorbed.`
                          : `📋 EXPIRED OTM — spot stayed below $${parsed.strike.toLocaleString()}. Premium lost.`;
                      }
                    }
                    const notional = t.notionalUsd || t.amount * spotAtTime;
                    const isMassive = notional >= MASSIVE_THRESHOLD_USD;
                    const isMajor = notional >= MAJOR_THRESHOLD_USD && notional < MASSIVE_THRESHOLD_USD;
                    const isHighlighted = isMassive || isMajor;
                    const isWhale = t.amount >= 50;
                    const dateStr = new Date(t.timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
                    const timeStr = new Date(t.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

                    // Tag tier
                    let tagLabel, tagColor, tagBg;
                    if (isMassive) {
                      tagLabel = "🔱 MASSIVE";
                      tagColor = C.gold;
                      tagBg = C.goldDim;
                    } else if (isMajor) {
                      tagLabel = "⚡ MAJOR";
                      tagColor = C.orange;
                      tagBg = C.orangeDim;
                    } else if (isWhale) {
                      tagLabel = "WHALE";
                      tagColor = C.purple;
                      tagBg = C.purpleDim;
                    } else {
                      // Dynamic tag based on actual notional
                      tagLabel = notional >= 500_000 ? ">500K" : notional >= 100_000 ? ">100K" : "SAVED";
                      tagColor = C.accent;
                      tagBg = C.accent + "22";
                    }

                    const highlightColor = isMassive ? C.gold : C.orange;
                    const highlightBorder = isMassive ? C.goldBorder : C.orangeBorder;

                    // Format expiry for display
                    const expiryStr = parsed.expiry || "—";

                    return (
                      <div key={t.trade_id || i} className="whale-row" style={{
                        display: "grid",
                        gridTemplateColumns: "130px 52px 50px 85px 65px 72px 72px 90px 75px minmax(200px, 1fr)",
                        alignItems: "start", padding: "10px 16px", fontSize: 12,
                        fontFamily: "'JetBrains Mono', monospace",
                        background: isHighlighted
                          ? `linear-gradient(90deg, ${highlightColor}08, ${highlightColor}04, transparent)`
                          : i % 2 === 0 ? "transparent" : C.bgCard + "60",
                        borderBottom: `1px solid ${isHighlighted ? highlightBorder : C.border + "44"}`,
                        borderLeft: isHighlighted ? `3px solid ${highlightColor}` : "3px solid transparent",
                        gap: 8,
                      }}>
                        <span style={{ color: isHighlighted ? highlightColor : C.textDim, fontSize: 11, fontWeight: isHighlighted ? 600 : 400 }}>{dateStr} {timeStr}</span>
                        <span style={{
                          color: isPut ? C.red : C.green, fontWeight: 700,
                          padding: "2px 6px", borderRadius: 3,
                          background: isPut ? C.redDim : C.greenDim,
                          textAlign: "center", fontSize: 11,
                        }}>{isPut ? "PUT" : "CALL"}</span>
                        <span style={{ color: isBuy ? C.green : C.red, fontSize: 11, textAlign: "center" }}>
                          {isBuy ? "BUY" : "SELL"}
                        </span>
                        <span style={{ color: C.text, fontWeight: 600 }}>${parsed.strike.toLocaleString()}</span>
                        <span style={{ color: parseFloat(distPct) > 0 ? C.green : parseFloat(distPct) < 0 ? C.red : C.textDim }}>
                          {distPct > 0 ? "+" : ""}{distPct}%
                        </span>
                        <span style={{ color: isHighlighted ? highlightColor : C.text, fontWeight: 600 }}><span className="mobile-label">Size </span>{t.amount.toFixed(1)}<span className="mobile-label"> BTC</span></span>
                        <span style={{ color: C.textDim, fontSize: 10 }}><span className="mobile-label">Exp </span>{expiryStr}</span>
                        <span style={{ color: isHighlighted ? highlightColor : C.yellow, fontWeight: 700, fontSize: isHighlighted ? 12 : 11 }}>
                          ${notional >= 1e6 ? (notional / 1e6).toFixed(2) + "M" : (notional / 1e3).toFixed(0) + "K"}
                        </span>
                        <span style={{
                          fontSize: 9, fontWeight: 700,
                          color: tagColor,
                          background: tagBg,
                          padding: "2px 6px", borderRadius: 3, textAlign: "center",
                          letterSpacing: 0.8,
                          border: isHighlighted ? `1px solid ${highlightBorder}` : "none",
                        }}>{tagLabel}</span>
                        <span className="whale-interp" style={{ color: isHighlighted ? C.text : C.textDim, fontSize: 11, lineHeight: 1.5, fontWeight: isHighlighted ? 500 : 400 }}>
                          {aggInterp || interp}
                          {strikeContext && (
                            <span style={{ display: "block", marginTop: 4, color: C.accent, fontSize: 10, fontWeight: 600 }}>
                              {strikeContext}
                            </span>
                          )}
                          {corridorContext && (
                            <span style={{ display: "block", marginTop: 4, color: C.purple, fontSize: 10, fontWeight: 600 }}>
                              {corridorContext}
                            </span>
                          )}
                          {expiredOutcome && (
                            <span style={{ display: "block", marginTop: 4, color: C.textMuted, fontSize: 10, fontWeight: 600, fontStyle: "italic" }}>
                              {expiredOutcome}
                            </span>
                          )}
                          {(() => {
                            const dte = getDTE(t);
                            const spotMove = btcPrice && t.btcPriceAtSave
                              ? ((btcPrice - t.btcPriceAtSave) / t.btcPriceAtSave * 100).toFixed(1)
                              : null;
                            const favorable = isPut
                              ? (isBuy ? parseFloat(spotMove) < 0 : parseFloat(spotMove) > 0)
                              : (isBuy ? parseFloat(spotMove) > 0 : parseFloat(spotMove) < 0);
                            const expired = dte !== null && dte <= 0;
                            if (!spotMove && dte === null) return null;
                            return (
                              <span style={{ display: "block", marginTop: 4, fontSize: 10, fontWeight: 600, color: C.textMuted }}>
                                {spotMove && (
                                  <span style={{ color: favorable ? C.green : C.red, marginRight: 12 }}>
                                    📈 Spot {parseFloat(spotMove) > 0 ? "+" : ""}{spotMove}% since entry {favorable ? "✓" : "✗"}
                                  </span>
                                )}
                                {dte !== null && (
                                  <span style={{ color: expired ? C.red + "88" : dte <= 7 ? C.red : C.textMuted }}>
                                    {expired ? "⏰ Expired" : `⏱ ${dte}d to expiry`}
                                  </span>
                                )}
                              </span>
                            );
                          })()}
                        </span>
                      </div>
                    );
                  });
                })()
              )}
            </div>
            {/* Bottom fade gradient for scroll indicator */}
            {sortedTrades.length > 3 && (
              <div style={{
                position: "absolute", bottom: 0, left: 0, right: 0, height: 40,
                background: `linear-gradient(transparent, ${C.bg})`,
                pointerEvents: "none", borderRadius: "0 0 8px 8px",
              }} />
            )}
          </div>
        </>
      )
      }
    </div >
  );
}

function ConnectionStatus({ status, lastUpdate }) {
  const colors = { connected: C.green, error: C.red, loading: C.yellow };
  const labels = { connected: "LIVE", error: "ERROR", loading: "CONNECTING" };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: colors[status] || C.textDim,
        boxShadow: status === "connected" ? `0 0 8px ${C.green}66` : "none",
        animation: status === "connected" ? "pulse 2s infinite" : "none",
      }} />
      <span style={{
        fontSize: 10,
        color: colors[status] || C.textDim,
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: 1,
        fontWeight: 600,
      }}>
        {labels[status] || "UNKNOWN"}
      </span>
      {lastUpdate && (
        <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
          · {lastUpdate}
        </span>
      )}
    </div>
  );
}

// ============================================================
// MAIN DASHBOARD
// ============================================================

export default function BTCFlowDashboard() {
  const [btcPrice, setBtcPrice] = useState(0);
  const [trades, setTrades] = useState([]);
  const [putVol, setPutVol] = useState(0);
  const [callVol, setCallVol] = useState(0);
  const [status, setStatus] = useState("loading");
  const [lastUpdate, setLastUpdate] = useState("");
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all"); // all, puts, calls, large
  const [refreshCount, setRefreshCount] = useState(0);
  const intervalRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const [price, rawTrades] = await Promise.all([
        fetchBTCPrice(),
        fetchOptionsTrades(200),
      ]);

      if (price) setBtcPrice(price);
      if (rawTrades && rawTrades.length > 0) {
        setTrades(rawTrades);

        let puts = 0, calls = 0;
        let newSaves = 0;
        rawTrades.forEach((t) => {
          const p = parseInstrument(t.instrument_name);
          if (p?.type === "P") puts += t.amount;
          else if (p?.type === "C") calls += t.amount;
          // Auto-save large trades
          if (price > 0 && shouldSaveTrade(t, price)) {
            if (saveTrade(t, price)) newSaves++;
          }
        });
        if (newSaves > 0) console.log(`[BTC Flow] Auto-saved ${newSaves} whale/large trades`);
        setPutVol(puts);
        setCallVol(calls);
        setStatus("connected");
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
      }
    } catch (err) {
      setStatus("error");
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(() => {
      fetchData();
      setRefreshCount((c) => c + 1);
    }, 15000);
    return () => clearInterval(intervalRef.current);
  }, [fetchData]);

  const filteredTrades = trades.filter((t) => {
    const p = parseInstrument(t.instrument_name);
    if (!p) return false;
    if (filter === "puts") return p.type === "P";
    if (filter === "calls") return p.type === "C";
    if (filter === "large") return t.amount >= 25;
    return true;
  });

  const largeTrades = trades.filter((t) => t.amount >= 5).length;
  const whaleTrades = trades.filter((t) => t.amount >= 50).length;

  return (
    <div style={{
      background: C.bg,
      minHeight: "100vh",
      color: C.text,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: ${C.borderActive}; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {/* Header */}
      <div style={{
        padding: "16px 28px",
        borderBottom: `1px solid ${C.border}`,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: C.bgCard,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.5 }}>
            <span style={{ color: C.accent }}>₿</span> BTC FLOW
          </div>
          <div style={{
            fontSize: 10,
            color: C.textDim,
            padding: "3px 8px",
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            letterSpacing: 0.8,
          }}>
            OPTIONS · ON-CHAIN · WHALE
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <ConnectionStatus status={status} lastUpdate={lastUpdate} />
          <button
            onClick={() => fetchData()}
            style={{
              background: "none",
              border: `1px solid ${C.border}`,
              color: C.textDim,
              padding: "4px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => { e.target.style.borderColor = C.accent; e.target.style.color = C.accent; }}
            onMouseLeave={(e) => { e.target.style.borderColor = C.border; e.target.style.color = C.textDim; }}
          >
            REFRESH
          </button>
        </div>
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 1440, margin: "0 auto" }}>
        {/* Stats Row */}
        <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <StatCard
            icon="₿"
            label="BTC Price"
            value={btcPrice > 0 ? `$${btcPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : <LoadingDots />}
            color={C.text}
          />
          <StatCard
            icon="📊"
            label="P/C Ratio"
            value={callVol > 0 ? (putVol / callVol).toFixed(2) : "—"}
            color={callVol > 0 && putVol / callVol > 1.5 ? C.red : callVol > 0 && putVol / callVol < 0.7 ? C.green : C.yellow}
            sub={`${putVol.toFixed(0)} P / ${callVol.toFixed(0)} C`}
          />
          <StatCard
            icon="📡"
            label="Trades Tracked"
            value={trades.length}
            color={C.accent}
            sub={`${largeTrades} notable · ${whaleTrades} whale`}
          />
          <StatCard
            icon="🔴"
            label="Put Volume"
            value={`${putVol.toFixed(1)} BTC`}
            color={C.red}
          />
          <StatCard
            icon="🟢"
            label="Call Volume"
            value={`${callVol.toFixed(1)} BTC`}
            color={C.green}
          />
        </div>

        {/* Sentiment Bar */}
        <div style={{ marginBottom: 20 }}>
          <SentimentBar putVol={putVol} callVol={callVol} />
        </div>

        {/* Market Interpretation */}
        <div style={{ marginBottom: 20 }}>
          <MarketInterpretation trades={trades} btcPrice={btcPrice} putVol={putVol} callVol={callVol} />
        </div>

        {/* Strike Heatmaps + Expiry */}
        <div className="panels-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
          <StrikeHeatmap trades={trades} btcPrice={btcPrice} type="P" />
          <StrikeHeatmap trades={trades} btcPrice={btcPrice} type="C" />
          <ExpiryBreakdown trades={trades} btcPrice={btcPrice} />
        </div>

        {/* Saved Whale Trades */}
        <SavedTradesPanel btcPrice={btcPrice} />

        {/* Trade Feed */}
        <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{
            padding: "14px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2 }}>
              Recent Options Trades
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {["all", "puts", "calls", "large"].map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  style={{
                    background: filter === f ? C.accent + "22" : "transparent",
                    border: `1px solid ${filter === f ? C.accent : C.border}`,
                    color: filter === f ? C.accent : C.textDim,
                    padding: "3px 10px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.8,
                    transition: "all 0.2s",
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Table Header */}
          <div className="trades-header" style={{
            display: "grid",
            gridTemplateColumns: "70px 52px 50px 85px 65px 72px 62px 55px minmax(200px, 1fr)",
            padding: "8px 16px",
            fontSize: 10,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: 1,
            borderBottom: `1px solid ${C.border}`,
            gap: 8,
          }}>
            <span>Time</span>
            <span>Type</span>
            <span>Side</span>
            <span>Strike</span>
            <span>Dist</span>
            <span>Size</span>
            <span>Expiry</span>
            <span>Tag</span>
            <span>Interpretation</span>
          </div>

          {/* Trade Rows */}
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {filteredTrades.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>
                {status === "loading" ? <LoadingDots /> : "No trades matching filter"}
              </div>
            ) : (
              filteredTrades.map((t, i) => (
                <TradeRow key={t.trade_id || i} trade={t} btcPrice={btcPrice} index={i} />
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 20,
          padding: "16px 0",
          borderTop: `1px solid ${C.border}`,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: C.textMuted,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          <span>Data: Deribit Public API · Auto-refresh 15s · Refreshed {refreshCount}x</span>
          <span>BTC Options Flow Dashboard · Built for tape reading</span>
        </div>
      </div>
    </div>
  );
}
