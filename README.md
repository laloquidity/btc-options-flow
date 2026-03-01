# ₿ BTC Options Flow — Institutional-Grade Options Intelligence Terminal

A real-time BTC options flow dashboard that pulls directly from Deribit's public API and transforms raw trade data into actionable institutional intelligence. No paid data feeds. No API keys. Real-time IV context. Multi-leg detection. Flow toxicity scoring. Whale tracking with composite-scored prioritization.

**Built for traders who read flow, not just watch it.**

---

## Architecture

```
Deribit Public API (15s polling)
    ├── get_last_trades_by_currency       → live trade feed
    ├── get_book_summary_by_currency      → IV map + ATM percentile
    └── get_index_price                   → BTC spot reference
            │
            ▼
┌──────────────────────────────────────────────────┐
│                Dashboard.jsx                     │
│  ┌────────────┐  ┌─────────────┐  ┌───────────┐ │
│  │ IV Pipeline │  │ interpretTrade │  │ Multi-Leg │ │
│  │ buildIVMap  │  │   v2 Engine    │  │ Grouping  │ │
│  │ ATM pctl   │  │ 9 variables    │  │ ±2s/±20%  │ │
│  └─────┬──────┘  └──────┬────────┘  └─────┬─────┘ │
│        └────────────────┼──────────────────┘       │
│                         ▼                          │
│  ┌──────────────────────────────────────────────┐  │
│  │              UI Components                    │ │
│  │  TradeRow · StrikeHeatmap · MarketInterp     │ │
│  │  ExpiryBreakdown · SavedTradesPanel          │ │
│  └──────────────────────────────────────────────┘  │
│                         ▼                          │
│  ┌──────────────────────────────────────────────┐  │
│  │        Supabase + localStorage               │ │
│  │        Persistent whale trade storage         │ │
│  └──────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## Core Engine: Interpretation Pipeline

### IV Data Pipeline

Every 15-second refresh pulls the full Deribit book summary, building a per-instrument IV map containing mark IV, bid/ask IV, open interest, and mid-price. A rolling ATM IV percentile is computed over the session (~200 samples across 50 minutes), enabling relative vol regime classification.

### `interpretTrade` v2

Every trade is interpreted through a 9-variable model returning a structured object:

```
{ summary, detail, tags, sentiment }
```

| Variable | What it contributes |
|----------|-------------------|
| Type (P/C) | Directional context |
| Strike | Moneyness zone (6 levels: deep ITM → deep OTM) |
| Direction | Buyer vs. seller intent |
| Size | Tier classification (5 → 200+ BTC) |
| BTC Price | Distance-from-spot percentage |
| Expiry / DTE | Time horizon bucket (5 levels) |
| Mark IV | Instrument-level vol context |
| IV Percentile | Session-relative regime (cheap / mid / expensive) |
| Mid Price | Premium commitment in BTC and USD |

Sentiment is classified as `bullish`, `bearish`, `neutral`, or `vol_trade` (ATM straddle components in extreme IV regimes).

### Multi-Leg Structure Detection

Trades within ±2 seconds and ±20% size are automatically grouped:

| Structure | Criteria |
|-----------|----------|
| Vertical Spread | Same type, opposite direction, same expiry |
| Straddle | P+C, same direction, same strike (±2%), same expiry |
| Strangle | P+C, same direction, different strikes, same expiry |
| Risk Reversal | P+C, opposite direction, same expiry |
| Calendar | Same type, same direction, different expiry |

Grouped trades render with structure labels and thesis-level interpretations.

---

## Dashboard Components

### 🧠 Market Interpretation Panel

Five analytical layers, updated every refresh:

- **Delta-weighted P/C ratio** — ATM trades weighted 1.0x, deep OTM 0.1x. Eliminates noise from distant strikes.
- **Direction-aware strike concentration** — Buy vs. sell split at the most active put strike with net flow read.
- **Term structure** — Flow distribution by DTE bucket with tactical/structural interpretation.
- **ATM IV context** — Current ATM IV with session percentile and regime classification.
- **Flow Toxicity Score** — Horizontal gauge (-1.0 bullish ↔ +1.0 bearish) measuring net taker directional bias.

### 📊 Directional Strike Heatmaps

Stacked green/red buy/sell bar segments per strike with:
- Net direction badges (`BUY ↑` / `SELL ↓` / `MIXED`)
- Signed net volume
- Buy and sell volume labels within each bar

### 📅 Expiry Breakdown

- **DTE column** color-coded by urgency
- **Classification badges**: `WKLY` · `MTHLY` · `QTRLY` · `LEAPS`
- **Term structure summary**: automated read of flow concentration patterns

### 📡 Live Trade Feed

Compact click-to-expand rows with:
- Sentiment-colored summary tag line (`OTM PUT BUY | -8% | Hedge | IV 52 (35th)`)
- IV column per trade
- Expandable detail: full interpretation + mark IV, bid/ask IV, OI, mid-price
- Multi-leg structure badges for detected spreads/straddles/etc.

### 🐋 Persistent Whale Tracker

Auto-saves trades exceeding $500K notional or 50 BTC. All interpretations receive full IV context.

| Tier | Threshold | Tag |
|------|-----------|-----|
| 🔱 MASSIVE | $10M+ | Gold badge |
| ⚡ MAJOR | $1M+ | Orange badge |
| 🐋 WHALE | ≥50 BTC | Purple badge |
| 📊 Notable | $500K+ | Blue badge |

**🔥 Expiring This Week** — standalone alert section for high-notional positions expiring within 7 days.

#### Composite Weighted Sort

The "Weighted" sort mode scores every trade as a continuous floating-point value:

| Factor | Weight | Method |
|--------|--------|--------|
| Notional | 40% | `log₁₀` scale — no cliff effects |
| DTE Urgency | 25% | Exponential decay, 7-day half-life |
| Spot Proximity | 15% | ATM > NTM > OTM > Deep OTM |
| Adversity | 10% | Positions moving against you rank higher |
| Recency | 10% | 48-hour half-life decay |

ITM positions within 3 DTE trigger maximum urgency. Expired trades sink to bottom.

---

## Serverless Backend (Optional)

Vercel serverless functions + Supabase for persistent whale trade storage across sessions:

| Endpoint | Purpose |
|----------|---------|
| `api/trades.js` | GET/POST saved trades via Supabase |
| `api/cron/poll-trades.js` | Scheduled polling to auto-capture whales |

Supabase schema in `supabase-setup.sql`. Configure via `.env` (see `.env.example`).

---

## Quick Start

```bash
git clone https://github.com/laloquidity/btc-options-flow.git
cd btc-options-flow/app
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Live data starts flowing immediately — no API keys needed.

For persistent whale storage, deploy to Vercel and configure Supabase (see `.env.example`).

---

## Project Structure

```
btc-options-flow/
├── app/                              # React application
│   ├── src/
│   │   ├── Dashboard.jsx             # Core: all logic + UI (~2300 lines)
│   │   ├── App.jsx                   # App wrapper
│   │   ├── main.jsx                  # Entry point
│   │   └── index.css                 # Reset + animations
│   ├── package.json
│   └── vite.config.js
├── api/                              # Vercel serverless functions
│   ├── trades.js                     # Supabase trade CRUD
│   └── cron/
│       └── poll-trades.js            # Scheduled whale capture
├── bot.py                            # Telegram alerting bot (optional)
├── supabase-setup.sql                # DB schema
├── vercel.json                       # Vercel config
├── .env.example                      # Environment template
└── README.md
```

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React + Vite | Single-component architecture |
| Data | Deribit Public API | No auth, 15s polling |
| Storage | Supabase + localStorage | Dual persistence |
| Hosting | Vercel | Serverless functions + static |
| Styling | Inline styles | Zero CSS deps, dark terminal aesthetic |

## Data Sources

All data comes from **free, public APIs**:

| Source | Data | Refresh |
|--------|------|---------|
| [Deribit](https://docs.deribit.com/) | Trades, book summaries, index price, IV | 15s |
| [mempool.space](https://mempool.space/) | On-chain transactions (bot only) | Configurable |

---

## Telegram Bot (Optional)

Python bot for real-time alerts: large options trades, on-chain whale movements, P/C shifts.

```bash
# Configure bot.py with your bot token and chat ID
python bot.py
```

See [BTC_Flow_System_Setup_Guide.md](BTC_Flow_System_Setup_Guide.md) for details.

---

## License

MIT
