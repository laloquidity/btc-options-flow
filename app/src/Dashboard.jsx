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

async function fetchOptionsTrades(hoursAgo = 4) {
  const cutoff = Date.now() - (hoursAgo * 3600 * 1000);
  // Don't pass start_timestamp — Deribit returns the oldest N trades from that
  // point, not the newest. Without it, we get the truly latest 1000 trades.
  const result = await fetchDeribit("get_last_trades_by_currency", {
    currency: "BTC",
    kind: "option",
    count: "1000",
    sorting: "desc",
  });
  const trades = result?.trades || [];
  // Client-side filter by time window
  return trades.filter(t => t.timestamp >= cutoff);
}

async function fetchBookSummary() {
  const result = await fetchDeribit("get_book_summary_by_currency", {
    currency: "BTC",
    kind: "option",
  });
  return result || [];
}

// Build IV lookup map from book summary data
function buildIVMap(bookSummary) {
  const map = {};
  if (!bookSummary || !Array.isArray(bookSummary)) return map;
  bookSummary.forEach((item) => {
    if (item.instrument_name && item.mark_iv != null) {
      map[item.instrument_name] = {
        markIV: item.mark_iv,
        bidIV: item.bid_iv || 0,
        askIV: item.ask_iv || 0,
        oi: item.open_interest || 0,
        midPrice: item.mid_price || 0,
        markPrice: item.mark_price || 0,
        underlyingPrice: item.underlying_price || 0,
      };
    }
  });
  return map;
}

// Get IV data for a specific trade's instrument
function getIVForTrade(instrumentName, ivMap) {
  if (!ivMap || !instrumentName) return null;
  const exact = ivMap[instrumentName];
  if (exact) return exact;
  return null;
}

// Extract ATM IV from IV map (closest-to-spot strike, nearest liquid expiry)
function extractATMIV(ivMap, btcPrice) {
  if (!ivMap || !btcPrice) return null;
  let bestMatch = null;
  let bestScore = Infinity;
  Object.entries(ivMap).forEach(([name, data]) => {
    const parsed = parseInstrument(name);
    if (!parsed || data.markIV <= 0 || data.oi < 10) return;
    const dte = parseDTE(parsed.expiry);
    if (dte === null || dte <= 0 || dte > 30) return; // focus on near-term
    const strikeDist = Math.abs(parsed.strike - btcPrice) / btcPrice;
    if (strikeDist > 0.05) return; // within 5% of spot
    // Score: prefer closest strike and shortest DTE
    const score = strikeDist * 100 + dte * 0.1;
    if (score < bestScore) {
      bestScore = score;
      bestMatch = data.markIV;
    }
  });
  return bestMatch;
}

// Compute percentile of current value within a history array
function computePercentile(current, history) {
  if (!history || history.length < 2) return null;
  const below = history.filter((v) => v < current).length;
  return Math.round((below / history.length) * 100);
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
  const diffMs = exp - now;
  if (diffMs <= 0) return 0; // Already expired
  return Math.ceil(diffMs / 86400000); // Any remaining time = at least 1 DTE
}

function interpretTrade(type, strike, direction, amount, btcPrice, expiry, opts = {}) {
  if (!btcPrice) return { summary: "No price data", detail: "No price data", tags: {}, sentiment: "neutral" };

  const { markIV, ivPercentile, premiumBTC, midPrice } = opts;
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

  // ── Moneyness display label ──
  const moneynessLabels = {
    deep_itm: "DEEP ITM", itm: "ITM", atm: "ATM",
    otm: "OTM", far_otm: "FAR OTM", deep_otm: "DEEP OTM",
  };
  const moneynessLabel = moneynessLabels[moneyness] || moneyness.toUpperCase();

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

  // ── IV context (new) ──
  let ivTag = "";
  let ivContext = "";
  if (markIV != null && markIV > 0) {
    if (ivPercentile != null) {
      if (ivPercentile < 20) {
        ivTag = `IV ${markIV.toFixed(0)}% (${ivPercentile}th)`;
        ivContext = `IV historically cheap (${ivPercentile}th pctl) — getting good value on premium.`;
      } else if (ivPercentile > 80) {
        ivTag = `IV ${markIV.toFixed(0)}% (${ivPercentile}th)`;
        ivContext = `IV elevated (${ivPercentile}th pctl) — premium is expensive, signals urgency or crowded positioning.`;
      } else {
        ivTag = `IV ${markIV.toFixed(0)}% (${ivPercentile}th)`;
        ivContext = `IV at ${markIV.toFixed(0)}% (${ivPercentile}th pctl).`;
      }
    } else {
      ivTag = `IV ${markIV.toFixed(0)}%`;
      ivContext = `IV: ${markIV.toFixed(0)}%.`;
    }
  }

  // ── Premium context (new) ──
  let premTag = "";
  let premContext = "";
  const effectivePremBTC = premiumBTC || (midPrice ? midPrice * amount : 0);
  if (effectivePremBTC > 0 && btcPrice > 0) {
    const premUSD = effectivePremBTC * btcPrice;
    if (premUSD >= 500_000) {
      premTag = `$${(premUSD / 1e6).toFixed(1)}M prem`;
      premContext = `$${(premUSD / 1e6).toFixed(1)}M premium on the line — high-conviction.`;
    } else if (premUSD >= 50_000) {
      premTag = `$${(premUSD / 1e3).toFixed(0)}K prem`;
      premContext = `$${(premUSD / 1e3).toFixed(0)}K premium committed — meaningful capital.`;
    } else if (premUSD >= 5_000) {
      premTag = `$${(premUSD / 1e3).toFixed(0)}K prem`;
      premContext = `~$${(premUSD / 1e3).toFixed(0)}K premium at risk.`;
    }
  }

  // ── Build interpretation (full detail) ──
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
      main = `Selling far OTM puts at ${sk} (${absDist.toFixed(0)}% below spot). Pure premium collection — harvesting theta on a strike that requires a major crash to reach. ${amount >= 25 ? "At this size, systematic premium selling or yield generation. Not a directional bet — this is an income strategy." : "Low-probability assignment; collecting premium on a crash-level strike."}`;
    } else if (moneyness === "otm") {
      main = `Put sell at ${sk}, ${absDist.toFixed(0)}% below spot. Premium harvesting — paid to agree to buy BTC at ${sk} if it drops. ${dteTag === "weekly" || dteTag === "expiring" ? "Near expiry makes rapid theta decay favorable for the seller. Income trade, not directional." : `Mildly bullish-neutral: profits as long as BTC stays above ${sk}.`}`;
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

  // Append IV context
  if (ivContext) main += ` ${ivContext}`;

  // Append premium context
  if (premContext) main += ` ${premContext}`;

  // ── Determine sentiment ──
  let sentiment = "neutral";
  if (isPut && isBuy) sentiment = "bearish";
  else if (isPut && !isBuy) sentiment = "bullish";
  else if (!isPut && isBuy) sentiment = "bullish";
  else if (!isPut && !isBuy) sentiment = "bearish";
  // Vol-trade detection: ATM straddle-component or extreme IV context
  if (moneyness === "atm" && ivPercentile != null && (ivPercentile < 15 || ivPercentile > 85)) {
    sentiment = "vol_trade";
  }

  // ── Build compact summary ──
  const typeLabel = isPut ? "PUT" : "CALL";
  const dirLabel = isBuy ? "BUY" : "SELL";
  const distLabel = dist >= 0 ? `+${absDist.toFixed(0)}%` : `-${absDist.toFixed(0)}%`;
  const shortThesis = moneyness === "atm" ? (isBuy ? "Directional" : "Vol sell")
    : (moneyness.includes("otm") ? (isBuy ? (isPut ? "Hedge" : "Upside bet") : "Premium harvest")
      : (isBuy ? "Delta play" : "Closing/unwinding"));
  const summaryParts = [`${moneynessLabel} ${typeLabel} ${dirLabel}`, distLabel, shortThesis];
  if (ivTag) summaryParts.push(ivTag);
  if (premTag) summaryParts.push(premTag);
  const summary = summaryParts.join(" | ");

  return {
    summary,
    detail: main,
    tags: { moneyness, dteTag, sizeQ, ivTag, premTag, moneynessLabel },
    sentiment,
  };
}

// Check if other saved trades suggest a multi-leg structure
function findRelatedLegHint(trade, allTrades, btcPrice) {
  if (!trade || !allTrades || allTrades.length < 2) return null;
  const p = parseInstrument(trade.instrument_name);
  if (!p) return null;

  const SIZE_TOLERANCE = 0.15; // tighter 15% for hints

  const related = allTrades.filter(t => {
    if (t.trade_id === trade.trade_id) return false;
    const tp = parseInstrument(t.instrument_name);
    if (!tp || tp.expiry !== p.expiry) return false;
    // Size must be close
    const sizeRatio = Math.min(t.amount, trade.amount) / Math.max(t.amount, trade.amount);
    if (sizeRatio < (1 - SIZE_TOLERANCE)) return false;
    // Must be complementary (different direction OR different type)
    return (t.direction !== trade.direction || tp.type !== p.type);
  });

  if (related.length === 0) return null;

  // Build hint
  const r = related[0];
  const rp = parseInstrument(r.instrument_name);
  const isPut = rp.type === "P";
  const dirLabel = r.direction === "buy" ? "buy" : "sell";
  const typeLabel = isPut ? "put" : "call";

  // Identify the likely structure
  let structureHint = "";
  if (p.type === rp.type && trade.direction !== r.direction) {
    // Same type, opposite direction = vertical spread
    const isBearish = (p.type === "P" && trade.direction === "buy" && p.strike > rp.strike) ||
      (p.type === "C" && trade.direction === "sell" && p.strike < rp.strike);
    structureHint = isBearish ? "bear spread" : "bull spread";
  } else if (p.type !== rp.type && trade.direction === r.direction) {
    structureHint = p.strike === rp.strike || Math.abs(p.strike - rp.strike) / btcPrice < 0.02
      ? "straddle" : "strangle";
  } else if (p.type !== rp.type && trade.direction !== r.direction) {
    structureHint = "risk reversal";
  }

  return `Note: A matching ${r.amount.toFixed(0)} BTC ${typeLabel} ${dirLabel} exists at $${rp.strike.toLocaleString()} (same expiry)${structureHint ? ` — these may be legs of a ${structureHint}` : ""}. Review both positions together for full context.`;
}

// ============================================================
// MULTI-LEG STRUCTURE DETECTION (Phase 3)
// ============================================================

function groupTradesIntoStructures(trades) {
  if (!trades || trades.length === 0) return [];
  const used = new Set();
  const groups = [];

  // Sort by timestamp for efficient pairing
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(sorted[i].trade_id)) continue;
    const t = sorted[i];
    const p = parseInstrument(t.instrument_name);
    if (!p) {
      groups.push({ type: "single", legs: [t], label: null });
      used.add(t.trade_id);
      continue;
    }

    // Look for matching legs within ±2 seconds
    const candidates = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const t2 = sorted[j];
      if (used.has(t2.trade_id)) continue;
      if (Math.abs(t2.timestamp - t.timestamp) > 2000) break; // beyond 2s window
      const p2 = parseInstrument(t2.instrument_name);
      if (!p2) continue;
      // Size within ±20%
      const sizeRatio = Math.min(t.amount, t2.amount) / Math.max(t.amount, t2.amount);
      if (sizeRatio < 0.8) continue;
      // Must be complementary
      const sameType = p.type === p2.type;
      const sameDir = t.direction === t2.direction;
      const sameExpiry = p.expiry === p2.expiry;
      if (sameType && sameDir && p.strike === p2.strike) continue; // identical, not a structure

      candidates.push({ trade: t2, parsed: p2, sameType, sameDir, sameExpiry });
    }

    if (candidates.length === 0) {
      groups.push({ type: "single", legs: [t], label: null });
      used.add(t.trade_id);
      continue;
    }

    // Pick best match
    const best = candidates[0];
    const bp = best.parsed;
    used.add(t.trade_id);
    used.add(best.trade.trade_id);

    let structType = "single";
    let label = "";
    const sk1 = `$${Math.min(p.strike, bp.strike).toLocaleString()}`;
    const sk2 = `$${Math.max(p.strike, bp.strike).toLocaleString()}`;

    if (best.sameType && !best.sameDir && best.sameExpiry) {
      // Same type, opposite direction, same expiry = vertical spread
      const isBullSpread = (p.type === "C" && t.direction === "buy" && p.strike < bp.strike) ||
        (p.type === "P" && t.direction === "sell" && p.strike < bp.strike);
      structType = "spread";
      label = `${isBullSpread ? "BULL" : "BEAR"} ${p.type === "P" ? "PUT" : "CALL"} SPREAD ${sk1}/${sk2}`;
    } else if (!best.sameType && best.sameDir && best.sameExpiry) {
      // Different type, same direction, same expiry
      const strikeDist = Math.abs(p.strike - bp.strike) / Math.max(p.strike, bp.strike);
      if (strikeDist < 0.02) {
        structType = "straddle";
        label = `STRADDLE ${sk1}`;
      } else {
        structType = "strangle";
        label = `STRANGLE ${sk1}/${sk2}`;
      }
    } else if (!best.sameType && !best.sameDir && best.sameExpiry) {
      structType = "risk_reversal";
      const putLeg = p.type === "P" ? { p, t } : { p: bp, t: best.trade };
      const callLeg = p.type === "C" ? { p, t } : { p: bp, t: best.trade };
      label = `RISK REV ${callLeg.t.direction === "buy" ? "Buy" : "Sell"} $${callLeg.p.strike.toLocaleString()}C / ${putLeg.t.direction === "buy" ? "Buy" : "Sell"} $${putLeg.p.strike.toLocaleString()}P`;
    } else if (best.sameType && best.sameDir && !best.sameExpiry) {
      structType = "calendar";
      label = `CALENDAR ${p.type === "P" ? "PUT" : "CALL"} $${p.strike.toLocaleString()} ${p.expiry}/${bp.expiry}`;
    }

    if (structType !== "single") {
      groups.push({ type: structType, legs: [t, best.trade], label });
    } else {
      groups.push({ type: "single", legs: [t], label: null });
      groups.push({ type: "single", legs: [best.trade], label: null });
    }
  }

  return groups;
}

function interpretStructure(group) {
  if (group.type === "single" || !group.legs || group.legs.length < 2) return null;
  const [l1, l2] = group.legs;
  const combinedSize = (l1.amount + l2.amount) / 2;
  const sizeStr = `${combinedSize.toFixed(1)} BTC`;

  switch (group.type) {
    case "spread": {
      const isBull = group.label.startsWith("BULL");
      return `${group.label} — ${sizeStr}. ${isBull
        ? "Limited-risk directional bet; profits if spot moves above upper strike."
        : "Limited-risk directional bet; profits if spot drops below lower strike."}`;
    }
    case "straddle":
      return `${group.label} — ${sizeStr}. Betting on a large move in either direction. Not directionally biased — pure vol play.`;
    case "strangle":
      return `${group.label} — ${sizeStr}. Similar to straddle but cheaper; profits on a big move in either direction.`;
    case "risk_reversal":
      return `${group.label} — ${sizeStr}. Synthetic directional position — strong conviction trade with zero or near-zero net premium.`;
    case "calendar":
      return `${group.label} — ${sizeStr}. Term-structure trade — betting on time-decay differential between near and far expiries.`;
    default:
      return null;
  }
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, fontFamily: "'JetBrains Mono', monospace" }}>
            Put / Call Flow
          </span>
          <span style={{ fontSize: 9, color: C.accent, fontFamily: "'JetBrains Mono', monospace", padding: "2px 8px", background: C.accent + "18", borderRadius: 3, border: `1px solid ${C.accent}44`, fontWeight: 600, letterSpacing: 0.5 }}>
            1H
          </span>
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

function TradeRow({ trade, btcPrice, index, ivMap, ivPercentile, structureLabel, isExpanded, onToggle }) {
  const parsed = parseInstrument(trade.instrument_name);
  if (!parsed) return null;

  const isPut = parsed.type === "P";
  const isBuy = trade.direction === "buy";
  const amount = trade.amount;
  const ivData = getIVForTrade(trade.instrument_name, ivMap);
  const interp = interpretTrade(parsed.type, parsed.strike, trade.direction, amount, btcPrice, parsed.expiry, {
    markIV: ivData?.markIV,
    ivPercentile,
    midPrice: ivData?.midPrice,
  });

  let sizeLabel = "";
  let sizeBg = "transparent";
  if (amount >= 100) { sizeLabel = "WHALE"; sizeBg = C.purpleDim; }
  else if (amount >= 25) { sizeLabel = "LARGE"; sizeBg = C.accent + "22"; }
  else if (amount >= 5) { sizeLabel = "NOTABLE"; sizeBg = C.textMuted + "44"; }

  const distPct = btcPrice > 0 ? ((parsed.strike - btcPrice) / btcPrice * 100).toFixed(1) : "—";
  const ts = new Date(trade.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const ivDisplay = ivData?.markIV ? `${ivData.markIV.toFixed(0)}%` : "—";
  const sentimentColors = { bearish: C.red, bullish: C.green, neutral: C.textDim, vol_trade: C.purple };

  return (
    <div>
      <div className="trade-row" style={{
        display: "grid",
        gridTemplateColumns: "70px 52px 50px 85px 55px 72px 62px 45px 50px minmax(180px, 1fr)",
        alignItems: "center",
        padding: "10px 16px",
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        background: isExpanded ? C.bgCardHover : (index % 2 === 0 ? "transparent" : C.bgCard + "60"),
        borderBottom: `1px solid ${C.border}44`,
        gap: 8,
        transition: "background 0.15s",
        cursor: "pointer",
      }}
        onClick={onToggle}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.bgCardHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = isExpanded ? C.bgCardHover : (index % 2 === 0 ? "transparent" : C.bgCard + "60"))}
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
        <span style={{ color: C.accent, fontSize: 10, padding: "2px 6px", background: C.accent + "15", borderRadius: 3, border: `1px solid ${C.accent}33`, fontWeight: 600 }}>{parsed.expiry}</span>
        <span style={{ color: ivData?.markIV ? C.cyan : C.textMuted, fontSize: 10 }}>{ivDisplay}</span>
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
        <span className="trade-interp" style={{ color: C.textDim, fontSize: 11, lineHeight: 1.5, display: "flex", alignItems: "center", gap: 6 }}>
          {structureLabel && (
            <span style={{
              fontSize: 9, fontWeight: 700, color: C.purple,
              padding: "2px 5px", borderRadius: 3,
              background: C.purpleDim, border: `1px solid ${C.purple}44`,
              whiteSpace: "nowrap",
            }}>{structureLabel}</span>
          )}
          <span style={{ color: sentimentColors[interp.sentiment] || C.textDim }}>{interp.summary}</span>
        </span>
      </div>
      {isExpanded && (
        <div style={{
          padding: "12px 16px 12px 86px",
          background: C.bgCard,
          borderBottom: `1px solid ${C.border}44`,
          fontSize: 11,
          lineHeight: 1.6,
          fontFamily: "'JetBrains Mono', monospace",
          animation: "fadeIn 0.15s ease-out",
        }}>
          <div style={{ color: C.text, marginBottom: 8 }}>{interp.detail}</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: C.textDim, fontSize: 10 }}>
            {ivData?.markIV != null && (
              <span>Mark IV: <span style={{ color: C.cyan }}>{ivData.markIV.toFixed(1)}%</span></span>
            )}
            {ivData?.bidIV > 0 && ivData?.askIV > 0 && (
              <span>Bid/Ask IV: <span style={{ color: C.textDim }}>{ivData.bidIV.toFixed(1)}% / {ivData.askIV.toFixed(1)}%</span></span>
            )}
            {ivData?.oi > 0 && (
              <span>OI: <span style={{ color: C.textDim }}>{ivData.oi.toLocaleString()}</span></span>
            )}
            {ivData?.midPrice > 0 && (
              <span>Mid: <span style={{ color: C.yellow }}>{ivData.midPrice.toFixed(4)} BTC</span> (${(ivData.midPrice * btcPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })})</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StrikeHeatmap({ trades, btcPrice, type, ivMap }) {
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
          const buyWidth = (s.buy / maxVol) * 100;
          const sellWidth = (s.sell / maxVol) * 100;
          const net = s.buy - s.sell;
          const buyDominant = s.buy > s.sell * 1.6;
          const sellDominant = s.sell > s.buy * 1.6;
          const netBadge = buyDominant ? "BUY ↑" : sellDominant ? "SELL ↓" : "MIXED";
          const netColor = buyDominant ? C.green : sellDominant ? C.red : C.yellow;
          return (
            <div key={s.strike} style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ fontSize: 12, color: C.text, fontWeight: 600, minWidth: 75, textAlign: "right" }}>
                ${s.strike.toLocaleString()}
              </span>
              <span style={{
                fontSize: 10,
                color: parseFloat(pct) > 0 ? C.green : parseFloat(pct) < 0 ? C.red : C.textDim,
                minWidth: 45, textAlign: "right",
              }}>
                {pct > 0 ? "+" : ""}{pct}%
              </span>
              <div style={{ flex: 1, height: 18, background: C.border + "60", borderRadius: 3, overflow: "hidden", display: "flex", position: "relative" }}>
                <div style={{ width: `${buyWidth}%`, height: "100%", background: C.green + "66", transition: "width 0.4s" }} />
                <div style={{ width: `${sellWidth}%`, height: "100%", background: C.red + "66", transition: "width 0.4s" }} />
                <span style={{
                  position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                  fontSize: 9, color: C.textDim,
                }}>
                  {s.buy.toFixed(1)}B / {s.sell.toFixed(1)}S
                </span>
              </div>
              <span style={{
                fontSize: 8, fontWeight: 700, color: netColor,
                padding: "2px 5px", borderRadius: 3,
                background: netColor + "18", border: `1px solid ${netColor}44`,
                minWidth: 50, textAlign: "center", whiteSpace: "nowrap",
              }}>{netBadge}</span>
              <span style={{ fontSize: 10, color: net > 0 ? C.green : net < 0 ? C.red : C.textDim, minWidth: 45, textAlign: "right" }}>
                {net > 0 ? "+" : ""}{net.toFixed(1)}
              </span>
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
    if (!expiryMap[key]) expiryMap[key] = { puts: 0, calls: 0, total: 0, putBuy: 0, callBuy: 0, expiry: parsed.expiry };
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
    .map(([expiry, data]) => ({ expiry, ...data, dte: parseDTE(expiry) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // Term structure summary
  const totalFlow = sorted.reduce((s, e) => s + e.total, 0);
  const nearTermFlow = sorted.filter(e => e.dte != null && e.dte <= 7).reduce((s, e) => s + e.total, 0);
  const midTermFlow = sorted.filter(e => e.dte != null && e.dte > 7 && e.dte <= 30).reduce((s, e) => s + e.total, 0);
  const longTermFlow = sorted.filter(e => e.dte != null && e.dte > 30).reduce((s, e) => s + e.total, 0);
  const nearPct = totalFlow > 0 ? (nearTermFlow / totalFlow * 100).toFixed(0) : 0;
  const midPct = totalFlow > 0 ? (midTermFlow / totalFlow * 100).toFixed(0) : 0;
  const longPct = totalFlow > 0 ? (longTermFlow / totalFlow * 100).toFixed(0) : 0;
  const termSummary = nearPct > 60 ? `Near-term concentrated (${nearPct}% ≤7d). Gamma-seeking tactical stance.`
    : longPct > 50 ? `Long-dated concentrated (${longPct}% >30d). Structural positioning.`
      : `Balanced: ${nearPct}% ≤7d, ${midPct}% 8-30d, ${longPct}% >30d.`;

  const classifyExpiry = (dte) => {
    if (dte == null || dte <= 0) return { label: "EXP", color: C.textMuted };
    if (dte <= 7) return { label: "WKLY", color: C.red };
    if (dte <= 35) return { label: "MTHLY", color: C.yellow };
    if (dte <= 95) return { label: "QTRLY", color: C.accent };
    return { label: "LEAPS", color: C.cyan };
  };

  const dteColor = (dte) => {
    if (dte == null) return C.textMuted;
    if (dte <= 7) return C.red;
    if (dte <= 30) return C.yellow;
    if (dte <= 90) return C.text;
    return C.cyan;
  };

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
      <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 16, fontFamily: "'JetBrains Mono', monospace" }}>
        📅 Volume by Expiry
      </div>
      {sorted.map((e) => {
        const pcr = e.calls > 0 ? (e.puts / e.calls).toFixed(2) : "∞";
        const cls = classifyExpiry(e.dte);
        return (
          <div key={e.expiry} style={{
            display: "grid",
            gridTemplateColumns: "65px 35px 45px 1fr 1fr 50px",
            gap: 8,
            padding: "8px 0",
            borderBottom: `1px solid ${C.border}33`,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            alignItems: "center",
          }}>
            <span style={{ color: C.text, fontWeight: 600 }}>{e.expiry}</span>
            <span style={{ color: dteColor(e.dte), fontSize: 10, fontWeight: 600 }}>
              {e.dte != null ? `${e.dte}d` : "—"}
            </span>
            <span style={{
              fontSize: 8, fontWeight: 700, color: cls.color,
              padding: "1px 4px", borderRadius: 3,
              background: cls.color + "18", border: `1px solid ${cls.color}44`,
              textAlign: "center",
            }}>{cls.label}</span>
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
              <span style={{ color: C.textDim, fontSize: 10, minWidth: 45 }}>{e.puts.toFixed(1)}</span>
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
              <span style={{ color: C.textDim, fontSize: 10, minWidth: 45 }}>{e.calls.toFixed(1)}</span>
            </div>
            <span style={{ color: pcr > 1.5 ? C.red : pcr > 1 ? C.yellow : C.textDim, textAlign: "right", fontSize: 11 }}>
              {pcr}
            </span>
          </div>
        );
      })}
      {totalFlow > 0 && (
        <div style={{ marginTop: 12, padding: "8px 0", fontSize: 10, color: C.textDim, fontFamily: "'JetBrains Mono', monospace", borderTop: `1px solid ${C.border}33` }}>
          📊 Term structure: {termSummary}
        </div>
      )}
    </div>
  );
}

function MarketInterpretation({ trades, btcPrice, putVol, callVol, ivMap, atmIV, ivPercentile }) {
  const insights = [];

  // ── Delta-weighted P/C ratio ──
  const rawPcr = callVol > 0 ? putVol / callVol : 0;
  let weightedPutVol = 0, weightedCallVol = 0;
  const distWeight = (dist) => dist <= 3 ? 1.0 : dist <= 10 ? 0.5 : dist <= 20 ? 0.2 : 0.1;
  trades.forEach((t) => {
    const p = parseInstrument(t.instrument_name);
    if (!p || !btcPrice) return;
    const dist = Math.abs((p.strike - btcPrice) / btcPrice * 100);
    const w = distWeight(dist) * t.amount;
    if (p.type === "P") weightedPutVol += w;
    else weightedCallVol += w;
  });
  const weightedPcr = weightedCallVol > 0 ? weightedPutVol / weightedCallVol : 0;

  if (rawPcr > 1.5 || weightedPcr > 1.2) {
    const divergence = Math.abs(rawPcr - weightedPcr) > 0.4
      ? ` Raw P/C (${rawPcr.toFixed(2)}) vs weighted (${weightedPcr.toFixed(2)}) diverge — OTM put noise inflating the raw ratio.`
      : "";
    insights.push({
      type: "bearish", title: "Heavy Put Activity",
      text: `Weighted P/C: ${weightedPcr.toFixed(2)} | Raw: ${rawPcr.toFixed(2)}. Aggressively hedging downside.${divergence}`
    });
  } else if (rawPcr < 0.5 || weightedPcr < 0.7) {
    insights.push({
      type: "bullish", title: "Call-Dominated Flow",
      text: `Weighted P/C: ${weightedPcr.toFixed(2)} | Raw: ${rawPcr.toFixed(2)}. Calls dominating near the money.`
    });
  } else {
    insights.push({
      type: "neutral", title: "Balanced Flow",
      text: `Weighted P/C: ${weightedPcr.toFixed(2)} | Raw: ${rawPcr.toFixed(2)}. No strong directional skew.`
    });
  }

  // ── Direction-aware strike concentration ──
  const strikeFlow = {};
  trades.forEach((t) => {
    const p = parseInstrument(t.instrument_name);
    if (!p || p.type !== "P" || t.amount < 5) return;
    if (!strikeFlow[p.strike]) strikeFlow[p.strike] = { buy: 0, sell: 0 };
    strikeFlow[p.strike][t.direction] += t.amount;
  });
  const topPutStrike = Object.entries(strikeFlow)
    .map(([k, v]) => ({ strike: parseFloat(k), ...v, net: v.buy - v.sell, total: v.buy + v.sell }))
    .sort((a, b) => b.total - a.total)[0];
  if (topPutStrike && topPutStrike.total > 15 && btcPrice > 0) {
    const distPct = ((topPutStrike.strike - btcPrice) / btcPrice * 100);
    const netLabel = topPutStrike.net > 0
      ? `Net ${topPutStrike.net.toFixed(1)} BTC new protection added — bearish hedging.`
      : `Net ${Math.abs(topPutStrike.net).toFixed(1)} BTC sold — premium harvesting, bullish-neutral.`;
    insights.push({
      type: topPutStrike.net > 0 ? "warning" : "info",
      title: `Put Concentration $${topPutStrike.strike.toLocaleString()} (${Math.abs(distPct).toFixed(1)}% ${distPct >= 0 ? "above" : "below"})`,
      text: `${topPutStrike.buy.toFixed(1)} bought vs ${topPutStrike.sell.toFixed(1)} sold. ${netLabel}`,
    });
  }

  // ── Term structure insight ──
  let nearVol = 0, weeklyVol = 0, midVol = 0, longVol = 0, totalVol = 0;
  trades.forEach((t) => {
    const p = parseInstrument(t.instrument_name);
    if (!p) return;
    const dte = parseDTE(p.expiry);
    totalVol += t.amount;
    if (dte != null) {
      if (dte <= 2) nearVol += t.amount;
      else if (dte <= 7) weeklyVol += t.amount;
      else if (dte <= 30) midVol += t.amount;
      else longVol += t.amount;
    }
  });
  if (totalVol > 0) {
    const shortPct = ((nearVol + weeklyVol) / totalVol * 100).toFixed(0);
    const longPct = (longVol / totalVol * 100).toFixed(0);
    const termText = shortPct > 60 ? `${shortPct}% ≤7d DTE — gamma-seeking tactical stance.`
      : longPct > 50 ? `${longPct}% 30d+ — structural positioning.`
        : `Balanced: ${shortPct}% ≤7d, ${((midVol) / totalVol * 100).toFixed(0)}% 8-30d, ${longPct}% 30d+.`;
    insights.push({ type: "info", title: "Term Structure", text: termText });
  }

  // ── IV context ──
  if (atmIV != null && atmIV > 0) {
    const ivText = ivPercentile != null
      ? ivPercentile < 25 ? `ATM IV ${atmIV.toFixed(0)}% (${ivPercentile}th pctl) — vol cheap. Buyers getting value.`
        : ivPercentile > 75 ? `ATM IV ${atmIV.toFixed(0)}% (${ivPercentile}th pctl) — premium expensive. Sellers may have edge.`
          : `ATM IV ${atmIV.toFixed(0)}% (${ivPercentile}th pctl) — mid-range.`
      : `ATM IV: ${atmIV.toFixed(0)}%. Calibrating...`;
    insights.push({ type: "info", title: "Implied Volatility", text: ivText });
  }

  // ── Flow Toxicity Score ──
  let tPutBuy = 0, tPutSell = 0, tCallBuy = 0, tCallSell = 0;
  trades.forEach((t) => {
    const p = parseInstrument(t.instrument_name);
    if (!p) return;
    if (p.type === "P") { if (t.direction === "buy") tPutBuy += t.amount; else tPutSell += t.amount; }
    else { if (t.direction === "buy") tCallBuy += t.amount; else tCallSell += t.amount; }
  });
  const toxDenom = tPutBuy + tPutSell + tCallBuy + tCallSell;
  const toxicity = toxDenom > 0 ? ((tPutBuy - tPutSell) - (tCallBuy - tCallSell)) / toxDenom : 0;
  const tox = Math.max(-1, Math.min(1, toxicity));
  const toxLabel = tox > 0.3 ? "Defensive — protection being added"
    : tox > 0.1 ? "Slightly defensive"
      : tox < -0.3 ? "Aggressive — bullish conviction"
        : tox < -0.1 ? "Slightly bullish" : "Neutral";

  // Whale activity
  const whaleTrades = trades.filter((t) => t.amount >= 50);
  if (whaleTrades.length > 0) {
    const wP = whaleTrades.filter((t) => parseInstrument(t.instrument_name)?.type === "P").length;
    const wC = whaleTrades.filter((t) => parseInstrument(t.instrument_name)?.type === "C").length;
    insights.push({
      type: wP > wC ? "bearish" : "bullish",
      title: `${whaleTrades.length} Whale Trade${whaleTrades.length > 1 ? "s" : ""}`,
      text: `${wP} whale puts vs ${wC} whale calls. ${wP > wC ? "Large players hedging downside." : "Large players positioning bullish."}`,
    });
  }

  const typeColors = { bearish: C.red, bullish: C.green, warning: C.yellow, info: C.cyan, neutral: C.textDim };
  const typeIcons = { bearish: "🔴", bullish: "🟢", warning: "⚠️", info: "💡", neutral: "⚪" };
  const [showAll, setShowAll] = useState(false);
  const visibleInsights = showAll ? insights : insights.slice(0, 3);
  const hasMore = insights.length > 3;

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, fontFamily: "'JetBrains Mono', monospace" }}>
          🧠 Market Interpretation
        </span>
        <span style={{ fontSize: 9, color: C.accent, fontFamily: "'JetBrains Mono', monospace", padding: "2px 8px", background: C.accent + "18", borderRadius: 3, border: `1px solid ${C.accent}44`, fontWeight: 600, letterSpacing: 0.5 }}>
          4H
        </span>
      </div>

      {/* Flow Toxicity Gauge */}
      <div style={{ marginBottom: 16, padding: "10px 12px", background: C.border + "22", borderRadius: 6, fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: 1 }}>Flow Toxicity</span>
          <span style={{ fontSize: 11, color: tox > 0.1 ? C.red : tox < -0.1 ? C.green : C.textDim, fontWeight: 600 }}>
            {tox > 0 ? "+" : ""}{tox.toFixed(2)} — {toxLabel}
          </span>
        </div>
        <div style={{ position: "relative", height: 12, background: C.border + "60", borderRadius: 6, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, background: C.textMuted + "66" }} />
          {tox > 0 ? (
            <div style={{
              position: "absolute", left: "50%", top: 0, bottom: 0,
              width: `${tox * 50}%`,
              background: `linear-gradient(90deg, transparent, ${C.red}88)`,
              borderRadius: "0 6px 6px 0", transition: "width 0.4s",
            }} />
          ) : (
            <div style={{
              position: "absolute", right: "50%", top: 0, bottom: 0,
              width: `${Math.abs(tox) * 50}%`,
              background: `linear-gradient(270deg, transparent, ${C.green}88)`,
              borderRadius: "6px 0 0 6px", transition: "width 0.4s",
            }} />
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: 8, color: C.textMuted }}>
          <span>BULLISH</span><span>BEARISH</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {visibleInsights.map((ins, i) => (
          <div key={i} style={{ padding: "14px 16px", borderRadius: 6, borderLeft: `3px solid ${typeColors[ins.type]}`, background: typeColors[ins.type] + "08" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: typeColors[ins.type], marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>
              {typeIcons[ins.type]} {ins.title}
            </div>
            <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6, fontFamily: "'JetBrains Mono', monospace" }}>
              {ins.text}
            </div>
          </div>
        ))}
        {hasMore && (
          <button onClick={() => setShowAll(!showAll)} style={{
            background: "none", border: `1px solid ${C.border}`, color: C.accent,
            padding: "6px 14px", borderRadius: 4, cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
            alignSelf: "center", transition: "all 0.15s",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.background = C.accent + "11"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = "none"; }}
          >
            {showAll ? "Show less" : `Show ${insights.length - 3} more`}
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

  // Sync from API every 30s to pick up cron-captured trades
  useEffect(() => {
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
    return () => { clearInterval(apiSync); };
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
    <>
      {/* 🔥 EXPIRING SOON — standalone section above whale trades */}
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

        return (
          <div className="expiring-soon" style={{
            background: C.bgCard, border: `1px solid ${C.red}44`, borderRadius: 8,
            overflow: "hidden", marginBottom: 12, padding: "14px 18px",
            borderLeft: `3px solid ${C.red}`,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: C.red, textTransform: "uppercase",
              letterSpacing: 1.2, marginBottom: 10,
              fontFamily: "'JetBrains Mono', monospace",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <span>🔥 Expiring This Week</span>
              <span style={{ color: C.textMuted, fontWeight: 400, fontSize: 10, textTransform: "none", letterSpacing: 0 }}>
                {expiringSoon.length} active {expiringSoon.length === 1 ? "bet" : "bets"}
              </span>
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
                  borderTop: i > 0 || true ? `1px solid ${C.border}44` : "none",
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  <span style={{
                    color: "#fff", background: C.red, padding: "2px 8px", borderRadius: 3,
                    fontWeight: 700, fontSize: 10,
                  }}>
                    exp {p?.expiry || `${dte}d`}
                  </span>
                  <span style={{ color: C.textMuted, fontSize: 9 }}>
                    entered {t.timestamp ? new Date(t.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date(t.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—"}
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
                  <span style={{ display: "block", width: "100%", color: C.textDim, fontSize: 10, lineHeight: 1.4, marginTop: 4 }}>
                    {interpretTrade(p?.type, p?.strike, t.direction, t.amount, t.btcPriceAtSave || btcPrice, p?.expiry).detail}
                  </span>
                  {(() => {
                    const hint = findRelatedLegHint(t, sortedTrades, btcPrice);
                    if (!hint) return null;
                    return (
                      <span style={{ display: "block", width: "100%", color: C.yellow, fontSize: 9, lineHeight: 1.4, marginTop: 4, fontStyle: "italic" }}>
                        🔗 {hint}
                      </span>
                    );
                  })()}
                </div>
              );
            })}
            {/* MAJOR trades: strike-level concentrations */}
            {majorTrades.length > 0 && (() => {
              const clusters = {};
              majorTrades.forEach(t => {
                const p = parseInstrument(t.instrument_name);
                if (!p) return;
                const key = `${p.strike}_${p.type}`;
                if (!clusters[key]) clusters[key] = { strike: p.strike, type: p.type, total: 0, count: 0, minDTE: Infinity, expiries: new Set() };
                clusters[key].total += (t.notionalUsd || 0);
                clusters[key].count++;
                if (p.expiry) clusters[key].expiries.add(p.expiry);
                const dte = getDTE(t);
                if (dte !== null && dte < clusters[key].minDTE) clusters[key].minDTE = dte;
              });
              const significant = Object.values(clusters)
                .filter(c => c.total >= 5e6)
                .sort((a, b) => b.total - a.total);
              const significantKeys = new Set(significant.map(c => `${c.strike}_${c.type}`));
              const remaining = majorTrades.filter(t => {
                const p = parseInstrument(t.instrument_name);
                return p && !significantKeys.has(`${p.strike}_${p.type}`);
              });
              const remainingTotal = remaining.reduce((s, t) => s + (t.notionalUsd || 0), 0);

              return (
                <div style={{ borderTop: `1px solid ${C.border}44`, paddingTop: 6 }}>
                  {significant.map((c, i) => {
                    const isPut = c.type === "P";
                    const totalStr = c.total >= 1e6 ? `$${(c.total / 1e6).toFixed(1)}M` : `$${(c.total / 1e3).toFixed(0)}K`;
                    return (
                      <div key={i} style={{
                        display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px",
                        padding: "4px 0", fontSize: 11,
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>
                        <span style={{ color: C.orange, fontWeight: 700, fontSize: 10 }}>📊</span>
                        <span style={{ color: C.orange, fontWeight: 700 }}>{totalStr}</span>
                        <span style={{ color: C.textDim }}>in</span>
                        <span style={{
                          color: isPut ? C.red : C.green, fontWeight: 700,
                          padding: "1px 5px", borderRadius: 3,
                          background: isPut ? C.redDim : C.greenDim,
                          fontSize: 10,
                        }}>{isPut ? "PUTS" : "CALLS"}</span>
                        <span style={{ color: C.text }}>at ${c.strike.toLocaleString()}</span>
                        <span style={{ color: C.textMuted, fontSize: 10 }}>
                          ({c.count} trades, exp {[...c.expiries].join(", ")})
                        </span>
                      </div>
                    );
                  })}
                  {remaining.length > 0 && (
                    <div style={{
                      padding: "4px 0", fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      color: C.textMuted,
                    }}>
                      + {remaining.length} more {remaining.length === 1 ? "trade" : "trades"}
                      {remainingTotal > 0 && ` (${remainingTotal >= 1e6 ? "$" + (remainingTotal / 1e6).toFixed(1) + "M" : "$" + (remainingTotal / 1e3).toFixed(0) + "K"})`}
                      {" "}expiring ≤7d
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        );
      })()}
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
            {/* 🔥 Expiring Soon now rendered as standalone card above */}
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
                      const interpObj = interpretTrade(parsed.type, parsed.strike, t.direction, t.amount, spotAtTime, parsed.expiry);
                      const interp = interpObj.detail;

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
                          <span style={{ color: C.accent, fontSize: 10, padding: "2px 6px", background: C.accent + "15", borderRadius: 3, border: `1px solid ${C.accent}33`, fontWeight: 600 }}><span className="mobile-label">Exp </span>{expiryStr}</span>
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
                              <span className="corridor-context" style={{ display: "block", marginTop: 4, color: C.purple, fontSize: 10, fontWeight: 600 }}>
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
                            {(() => {
                              const hint = findRelatedLegHint(t, savedTrades, btcPrice);
                              if (!hint) return null;
                              return (
                                <span style={{ display: "block", marginTop: 4, color: C.yellow, fontSize: 9, fontWeight: 600, fontStyle: "italic" }}>
                                  🔗 {hint}
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
    </>
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
  const [ivMap, setIvMap] = useState({});
  const [ivPercentile, setIvPercentile] = useState(null);
  const [atmIV, setAtmIV] = useState(null);
  const [expandedTradeId, setExpandedTradeId] = useState(null);
  const intervalRef = useRef(null);
  const ivHistoryRef = useRef([]); // rolling ATM IV history for percentile

  const fetchData = useCallback(async () => {
    try {
      const [price, trades1h, trades4h, bookSummary] = await Promise.all([
        fetchBTCPrice(),
        fetchOptionsTrades(1),   // 1h window for P/C sentiment
        fetchOptionsTrades(4),   // 4h window for interpretation + trade list
        fetchBookSummary(),      // IV data for all instruments
      ]);

      if (price) setBtcPrice(price);

      // Build IV lookup map from book summary
      if (bookSummary && bookSummary.length > 0) {
        const newIvMap = buildIVMap(bookSummary);
        setIvMap(newIvMap);

        // Extract ATM IV and track history for percentile
        const currentATMIV = extractATMIV(newIvMap, price);
        if (currentATMIV !== null) {
          setAtmIV(currentATMIV);
          const hist = ivHistoryRef.current;
          hist.push(currentATMIV);
          if (hist.length > 200) hist.shift(); // cap at 200 entries
          const pctl = computePercentile(currentATMIV, hist);
          setIvPercentile(pctl);
        }
      }

      // 1h data → P/C ratio and sentiment
      if (trades1h && trades1h.length > 0) {
        let puts = 0, calls = 0;
        trades1h.forEach((t) => {
          const p = parseInstrument(t.instrument_name);
          if (p?.type === "P") puts += t.amount;
          else if (p?.type === "C") calls += t.amount;
        });
        setPutVol(puts);
        setCallVol(calls);
      }

      // 4h data → trade list, auto-save, interpretation
      if (trades4h && trades4h.length > 0) {
        setTrades(trades4h);
        let newSaves = 0;
        trades4h.forEach((t) => {
          if (price > 0 && shouldSaveTrade(t, price)) {
            if (saveTrade(t, price)) newSaves++;
          }
        });
        if (newSaves > 0) console.log(`[BTC Flow] Auto-saved ${newSaves} whale/large trades`);
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

    // Browsers throttle setInterval in background tabs — re-fetch immediately
    // when the user returns to the tab so the feed is never stale
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchData();
        setRefreshCount((c) => c + 1);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchData]);

  const filteredTrades = trades.filter((t) => {
    const p = parseInstrument(t.instrument_name);
    if (!p) return false;
    if (filter === "puts") return p.type === "P";
    if (filter === "calls") return p.type === "C";
    if (filter === "large") return t.amount >= 25;
    return true;
  });


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
            DERIBIT OPTIONS TERMINAL
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
            label="P/C Ratio (1h)"
            value={callVol > 0 ? (putVol / callVol).toFixed(2) : "—"}
            color={callVol > 0 && putVol / callVol > 1.5 ? C.red : callVol > 0 && putVol / callVol < 0.7 ? C.green : C.yellow}
            sub={`${putVol.toFixed(0)} P / ${callVol.toFixed(0)} C`}
          />

          <StatCard
            icon="🔴"
            label="Put Volume (1h)"
            value={`${putVol.toFixed(1)} BTC`}
            color={C.red}
          />
          <StatCard
            icon="🟢"
            label="Call Volume (1h)"
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
          <MarketInterpretation trades={trades} btcPrice={btcPrice} putVol={putVol} callVol={callVol} ivMap={ivMap} atmIV={atmIV} ivPercentile={ivPercentile} />
        </div>

        {/* Strike Heatmaps + Expiry */}
        <div className="panels-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
          <StrikeHeatmap trades={trades} btcPrice={btcPrice} type="P" ivMap={ivMap} />
          <StrikeHeatmap trades={trades} btcPrice={btcPrice} type="C" ivMap={ivMap} />
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
            gridTemplateColumns: "70px 52px 50px 85px 55px 72px 62px 45px 50px minmax(180px, 1fr)",
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
            <span>IV</span>
            <span>Tag</span>
            <span>Interpretation</span>
          </div>

          {/* Trade Rows — with multi-leg grouping */}
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {filteredTrades.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>
                {status === "loading" ? <LoadingDots /> : "No trades matching filter"}
              </div>
            ) : (() => {
              const groups = groupTradesIntoStructures(filteredTrades);
              let rowIndex = 0;
              return groups.map((group, gi) => {
                if (group.type !== "single" && group.legs.length >= 2) {
                  // Multi-leg structure
                  const structInterp = interpretStructure(group);
                  return (
                    <div key={`grp-${gi}`}>
                      {structInterp && (
                        <div style={{
                          padding: "6px 16px", fontSize: 10, color: C.purple,
                          background: C.purpleDim, fontWeight: 600,
                          fontFamily: "'JetBrains Mono', monospace",
                          borderBottom: `1px solid ${C.purple}33`,
                        }}>
                          🔗 {structInterp}
                        </div>
                      )}
                      {group.legs.map((leg) => {
                        const idx = rowIndex++;
                        return (
                          <TradeRow
                            key={leg.trade_id || idx}
                            trade={leg}
                            btcPrice={btcPrice}
                            index={idx}
                            ivMap={ivMap}
                            ivPercentile={ivPercentile}
                            structureLabel={group.label}
                            isExpanded={expandedTradeId === leg.trade_id}
                            onToggle={() => setExpandedTradeId(expandedTradeId === leg.trade_id ? null : leg.trade_id)}
                          />
                        );
                      })}
                    </div>
                  );
                }
                // Single trade
                const t = group.legs[0];
                const idx = rowIndex++;
                return (
                  <TradeRow
                    key={t.trade_id || idx}
                    trade={t}
                    btcPrice={btcPrice}
                    index={idx}
                    ivMap={ivMap}
                    ivPercentile={ivPercentile}
                    isExpanded={expandedTradeId === t.trade_id}
                    onToggle={() => setExpandedTradeId(expandedTradeId === t.trade_id ? null : t.trade_id)}
                  />
                );
              });
            })()}
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
