import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// BTC OPTIONS FLOW & WHALE DASHBOARD
// ============================================================

const DERIBIT_API = "https://www.deribit.com/api/v2/public";

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

function interpretTrade(type, strike, direction, amount, btcPrice) {
  if (!btcPrice) return "No price data";
  const otmPct = Math.abs(strike - btcPrice) / btcPrice * 100;

  if (type === "P") {
    if (direction === "buy") {
      if (strike < btcPrice && otmPct < 10)
        return `Near-money put buy — hedging a long. Floor at $${strike.toLocaleString()}.`;
      if (strike < btcPrice)
        return `Deep OTM put buy — tail risk protection or bearish bet below $${strike.toLocaleString()}.`;
      return `ITM/ATM put buy — aggressive bearish or delta-neutral hedge.`;
    }
    if (strike < btcPrice)
      return `Put sell at $${strike.toLocaleString()} — bullish. Collecting premium, expects price holds above.`;
    return `ITM put sell — closing protection or bullish stance.`;
  }
  if (direction === "buy") {
    if (strike > btcPrice && otmPct < 10)
      return `Near-money call buy — bullish. Targeting move above $${strike.toLocaleString()}.`;
    if (strike > btcPrice)
      return `Deep OTM call buy — lottery ticket or short hedge above $${strike.toLocaleString()}.`;
    return `ITM/ATM call buy — strong bullish conviction.`;
  }
  if (strike > btcPrice)
    return `Call sell at $${strike.toLocaleString()} — capping upside. Covered call or bearish lean.`;
  return `ITM call sell — closing bullish position or taking profit.`;
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
  const interp = interpretTrade(parsed.type, parsed.strike, trade.direction, amount, btcPrice);

  let sizeLabel = "";
  let sizeBg = "transparent";
  if (amount >= 100) { sizeLabel = "WHALE"; sizeBg = C.purpleDim; }
  else if (amount >= 25) { sizeLabel = "LARGE"; sizeBg = C.accent + "22"; }
  else if (amount >= 5) { sizeLabel = "NOTABLE"; sizeBg = C.textMuted + "44"; }

  const distPct = btcPrice > 0 ? ((parsed.strike - btcPrice) / btcPrice * 100).toFixed(1) : "—";
  const ts = new Date(trade.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "70px 52px 50px 85px 65px 72px 62px 55px 1fr",
      alignItems: "center",
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
      <span style={{ color: C.textDim, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
    const dist = ((strike - btcPrice) / btcPrice * 100).toFixed(1);
    insights.push({
      type: "info",
      title: `Concentrated Puts at $${strike.toLocaleString()}`,
      text: `${topPutStrike[1].toFixed(1)} BTC in puts at the $${strike.toLocaleString()} strike (${dist}% from spot). This level is being used as a hedging floor or downside target by large players. Cross-reference with your liquidation heatmap — if this aligns with a liquidity cluster, conviction increases.`,
    });
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
      const dist = Math.abs(p.strike - btcPrice) / btcPrice;
      return dist < 0.05 && t.amount >= 5;
    });

    const totalNearPutVol = nearMoneyPutBuys.reduce((sum, t) => sum + t.amount, 0);
    if (totalNearPutVol > 10) {
      insights.push({
        type: "warning",
        title: "Active Hedging Near Spot",
        text: `${totalNearPutVol.toFixed(1)} BTC in near-the-money put buying (within 5% of spot). This is the hedging signal you asked about — someone with significant long exposure is buying protection at current levels. Corroborate with footprint: if NL is declining while this is happening, smart money is actively de-risking.`,
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

  return (
    <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
      <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 16, fontFamily: "'JetBrains Mono', monospace" }}>
        🧠 Market Interpretation
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {insights.map((ins, i) => (
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
      </div>
    </div>
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
        rawTrades.forEach((t) => {
          const p = parseInstrument(t.instrument_name);
          if (p?.type === "P") puts += t.amount;
          else if (p?.type === "C") calls += t.amount;
        });
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
          <StrikeHeatmap trades={trades} btcPrice={btcPrice} type="P" />
          <StrikeHeatmap trades={trades} btcPrice={btcPrice} type="C" />
          <ExpiryBreakdown trades={trades} btcPrice={btcPrice} />
        </div>

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
          <div style={{
            display: "grid",
            gridTemplateColumns: "70px 52px 50px 85px 65px 72px 62px 55px 1fr",
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
