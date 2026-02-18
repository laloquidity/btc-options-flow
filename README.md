# ₿ BTC Options Flow — Real-Time Whale Tracking Terminal

A real-time BTC options flow dashboard that pulls directly from Deribit's public API. No paid data feeds. No API keys. Just raw institutional flow — parsed, interpreted, and tracked live.

![Dashboard Hero](docs/screenshots/dashboard_hero.jpg)

## Features

### 📊 Live Market Overview
- **Real-time BTC price** from Deribit
- **Put/Call ratio** with volume breakdown
- **Sentiment bar** — visual put/call flow balance
- **Auto-refresh** every 15 seconds

### 🧠 Market Interpretation Engine
Auto-generates actionable insights from the options flow:
- **Concentrated strike detection** — distinguishes ITM puts (bearish positioning) from OTM hedging floors
- **Active hedging signals** — near-the-money put buying filtered to only count OTM/ATM puts
- **Whale activity detection** — flags unusual institutional-size flow
- **Collapsible UI** — shows top 2 insights by default with a "Show more" toggle

### 🎯 Institutional-Grade Trade Interpretations
Every trade gets a multi-clause, plain-English interpretation — the kind of read you'd hear on an institutional desk:

- **6 moneyness zones** — Deep ITM → Deep OTM, each with tailored commentary
- **5 DTE buckets** — Expiring (gamma lottery), weekly, near-term, medium (strategic), LEAPS (structural)
- **4 size tiers** — Meaningful (5+ BTC), large (25+), institutional (50+), market-moving (200+)
- **Context-aware reads** — e.g. "ATM put buy at $66,000 — high-conviction downside play. Paying full premium for near-the-money protection."

### 🔥 Strike Heatmaps & Expiry Breakdown
- **Top put/call strikes by volume** — see where the money is clustering
- **Volume by expiry** — understand the term structure of positioning

### 🐋 Persistent Whale Trade Tracker
Automatically saves and categorizes significant trades ($500K+ notional or ≥50 BTC):

| Tier | Threshold | Tag | Color |
|------|-----------|-----|-------|
| 🔱 MASSIVE | $10M+ notional | `🔱 MASSIVE` | Gold |
| ⚡ MAJOR | $1M+ notional | `⚡ MAJOR` | Orange |
| 🐋 WHALE | ≥50 BTC | `WHALE` | Purple |
| 📊 Notable | $500K+ notional | `>500K` | Blue |

#### Smart Sorting
Three sort modes with one-click toggles:

- **⚖ WEIGHTED** (default) — composite score using `log(notional) × recency_decay`. MASSIVE trades ($10M+) get a 48-hour half-life to stay pinned at the top; normal trades use a 6-hour half-life.
- **💰 SIZE** — pure notional value, largest first
- **🕐 RECENT** — chronological, newest first

![Whale Trades Panel](docs/screenshots/whale_panel.png)

### 📡 Live Trade Feed
- All recent options trades in real-time
- Filter by: All, Puts, Calls, Large
- Every trade gets a contextual interpretation with moneyness, DTE, and size awareness

## Tech Stack

- **React** + **Vite** — fast, modern frontend
- **Deribit Public API** — no authentication required
- **localStorage** — client-side persistence for whale trades
- **Inline styles** — zero CSS dependencies, dark terminal aesthetic

## Quick Start

```bash
# Clone the repo
git clone https://github.com/laloquidity/btc-options-flow.git
cd btc-options-flow/app

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and the dashboard will start pulling live data immediately.

## Project Structure

```
btc-options-flow/
├── app/                          # React application
│   ├── src/
│   │   ├── Dashboard.jsx         # Main dashboard component (all logic + UI)
│   │   ├── App.jsx               # App wrapper
│   │   ├── main.jsx              # Entry point
│   │   └── index.css             # Minimal reset
│   ├── package.json
│   └── vite.config.js
├── bot.py                        # Telegram alerting bot (optional)
├── dashboard.jsx                 # Original standalone component
├── requirements.txt              # Python deps for bot
├── BTC_Flow_System_Setup_Guide.md
└── README.md
```

## Telegram Bot (Optional)

The repo includes a Python Telegram bot (`bot.py`) that sends real-time alerts for:
- Large options trades on Deribit
- On-chain whale BTC movements (via mempool.space)
- P/C ratio shifts

To set it up:
1. Get a bot token from [@BotFather](https://t.me/BotFather)
2. Get your chat ID from [@userinfobot](https://t.me/userinfobot)
3. Edit the `CONFIG` dict in `bot.py`
4. Run: `python bot.py`

See [BTC_Flow_System_Setup_Guide.md](BTC_Flow_System_Setup_Guide.md) for detailed instructions.

## Data Sources

All data comes from **free, public APIs** — no API keys or paid subscriptions needed:

| Source | Data | Rate |
|--------|------|------|
| [Deribit Public API](https://docs.deribit.com/) | Options trades, book summaries, BTC index | 15s refresh |
| [mempool.space](https://mempool.space/) | On-chain transactions (bot only) | Configurable |

## License

MIT
