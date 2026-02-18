# BTC Options Flow & Whale Tracking — Complete Setup Guide

## Overview

This system has two components:

1. **Dashboard** — A React app that runs in your browser showing live Deribit options flow, strike heatmaps, put/call ratios, and automated market interpretation
2. **Telegram Bot** — A Python script that runs on your machine (or VPS) and sends you alerts for large options trades, whale on-chain movements, and P/C ratio shifts

Both pull from free public APIs. No paid keys required.

---

## Part 1: Telegram Bot Setup

### Step 1: Create Your Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. BotFather will ask for a name — type anything like `BTC Flow Alerts`
4. BotFather will ask for a username — type something unique like `mycryptoflow_bot` (must end in `bot`)
5. BotFather will respond with your **bot token** — it looks like `7123456789:AAH1bGciOiJIUzI1NiIsInR5cCI6...`
6. **Copy this token and save it somewhere**

### Step 2: Get Your Chat ID

1. In Telegram, search for **@userinfobot**
2. Send it any message (like "hi")
3. It will reply with your user info including your **ID** — a number like `123456789`
4. **Copy this number**

### Step 3: Install Python Dependencies

Open your terminal and run:

```bash
# Make sure you have Python 3.10+
python3 --version

# Install required packages
pip3 install python-telegram-bot aiohttp websockets
```

If you're on Mac and get permission errors:

```bash
pip3 install --user python-telegram-bot aiohttp websockets
```

### Step 4: Configure the Bot

1. Download `bot.py` from the files provided
2. Open it in any text editor (VS Code, Sublime, nano, etc.)
3. Find the CONFIG section at the top (around line 18)
4. Replace the two placeholder values:

```python
CONFIG = {
    "TELEGRAM_BOT_TOKEN": "7123456789:AAH1bGciOiJIUzI1NiIsInR5cCI6...",  # Your token from BotFather
    "TELEGRAM_CHAT_ID": "123456789",  # Your ID from userinfobot
    ...
}
```

### Step 5: (Optional) Tune Alert Thresholds

In the same CONFIG section, adjust these based on how noisy you want alerts:

```python
# Options — how big a trade before you get pinged
"OPTIONS_MIN_TRADE_SIZE_BTC": 5.0,    # Minimum to alert (lower = more alerts)
"OPTIONS_LARGE_TRADE_BTC": 25.0,      # "Large" label
"OPTIONS_WHALE_TRADE_BTC": 100.0,     # "Whale" label

# On-chain — how many BTC moving before you get pinged
"ONCHAIN_MIN_BTC": 100,               # Minimum to track
"ONCHAIN_LARGE_BTC": 500,             # "Large" label
"ONCHAIN_WHALE_BTC": 1000,            # "Whale" label

# Timing
"OPTIONS_POLL_INTERVAL_SEC": 10,      # Check Deribit every 10 sec
"ONCHAIN_POLL_INTERVAL_SEC": 30,      # Check mempool every 30 sec
"PUT_CALL_ALERT_THRESHOLD": 1.5,      # Alert when P/C ratio exceeds this
"HEARTBEAT_INTERVAL_SEC": 3600,       # Hourly summary
```

My recommendations for your style of trading:

- Keep `OPTIONS_MIN_TRADE_SIZE_BTC` at **10** to reduce noise (you care about institutional flow, not retail)
- Set `OPTIONS_WHALE_TRADE_BTC` to **50** to catch more whale activity
- Keep `PUT_CALL_ALERT_THRESHOLD` at **1.5** — that's when hedging gets serious
- Set `HEARTBEAT_INTERVAL_SEC` to **1800** (30 min) during active trading sessions, **3600** when away

### Step 6: Run the Bot

```bash
cd /path/to/deribit_whale_bot
python3 bot.py
```

You should immediately get a Telegram message saying "BTC Flow Monitor Online" with your configuration. If you don't:

- Double-check your bot token (no extra spaces)
- Make sure you messaged your bot at least once on Telegram (open the bot and press Start)
- Check your chat ID is correct

### Step 7: Keep It Running

The bot needs to stay running to send alerts. Options:

**Option A: Screen (simple, for your local machine)**

```bash
screen -S btcbot
python3 bot.py
# Press Ctrl+A, then D to detach
# To reattach later: screen -r btcbot
```

**Option B: tmux (alternative to screen)**

```bash
tmux new -s btcbot
python3 bot.py
# Press Ctrl+B, then D to detach
# To reattach: tmux attach -t btcbot
```

**Option C: systemd service (for a VPS — most reliable)**

Create the file `/etc/systemd/system/btcbot.service`:

```ini
[Unit]
Description=BTC Flow Monitor Bot
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/path/to/deribit_whale_bot
ExecStart=/usr/bin/python3 bot.py
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable btcbot
sudo systemctl start btcbot

# Check status
sudo systemctl status btcbot

# View logs
journalctl -u btcbot -f
```

**Option D: Run on a cheap VPS**

If you don't want it on your local machine, a $5/month DigitalOcean or Vultr droplet works. The bot uses minimal resources. SSH in, clone your files, and use the systemd setup above.

---

## Part 2: Dashboard Setup

The dashboard is a React component that runs in your browser. There are several ways to run it.

### Option A: Run via Claude Artifacts (Easiest)

The dashboard.jsx file I provided is already formatted as a Claude artifact. You can:

1. Open the artifact directly in Claude — it will render as an interactive dashboard
2. The dashboard auto-refreshes every 15 seconds from Deribit's public API
3. No setup required

This is the fastest way to use it but relies on Claude's artifact renderer.

### Option B: Standalone React App (Recommended for Daily Use)

#### Prerequisites

```bash
# Install Node.js if you don't have it
# Mac:
brew install node

# Or download from https://nodejs.org (LTS version)

# Verify
node --version  # Should be 18+
npm --version
```

#### Create the App

```bash
# Create new React app
npx create-react-app btc-flow-dashboard
cd btc-flow-dashboard

# Replace the default App.js with the dashboard
```

Open `src/App.js` and replace its entire contents with:

```javascript
import BTCFlowDashboard from './Dashboard';

function App() {
  return <BTCFlowDashboard />;
}

export default App;
```

Copy the `dashboard.jsx` file I provided into `src/Dashboard.jsx`.

Then at the top of `src/Dashboard.jsx`, make sure the import line reads:

```javascript
import { useState, useEffect, useCallback, useRef } from "react";
```

#### Run It

```bash
npm start
```

Your browser will open to `http://localhost:3000` with the live dashboard.

#### Build for Production (Optional)

```bash
npm run build
# Outputs to build/ folder — can be hosted anywhere (Vercel, Netlify, etc.)
```

### Option C: Simple HTML File (No Build Tools)

If you don't want to deal with npm/React setup, create a single HTML file:

```html
<!DOCTYPE html>
<html>
<head>
  <title>BTC Flow Dashboard</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    // Paste the entire contents of dashboard.jsx here
    // Change "export default function BTCFlowDashboard" to just "function BTCFlowDashboard"

    ReactDOM.render(<BTCFlowDashboard />, document.getElementById('root'));
  </script>
</body>
</html>
```

Save it as `dashboard.html` and open it in your browser. No server needed.

---

## Part 3: How to Use This for Trading

### Understanding the Dashboard Panels

#### Stats Row (Top)

- **BTC Price** — Current index price from Deribit
- **P/C Ratio** — Rolling put/call ratio from recent trades. Below 0.7 = bullish flow. Above 1.5 = heavy hedging or bearish flow.
- **Trades Tracked** — Total trades in the current window, with counts of notable (5+ BTC) and whale (50+ BTC) trades
- **Put Volume / Call Volume** — Total BTC notional in puts vs calls

#### Sentiment Bar

Visual representation of put vs call flow. The label auto-categorizes:

- **HEAVILY HEDGED** (P/C > 1.5) — Market is buying downside protection aggressively
- **CAUTIOUS** (P/C 1.0-1.5) — Slightly more puts than calls, moderate hedging
- **BALANCED** (P/C 0.7-1.0) — No strong directional lean in options
- **BULLISH FLOW** (P/C < 0.7) — Calls dominating, market positioning for upside

#### Market Interpretation Panel

This is the most important panel. It automatically analyzes the flow and tells you what it means in plain English. It looks for:

- Heavy put activity and what it signals
- Concentrated puts at specific strikes (hedging floors)
- Whale trades and their directional lean
- Near-the-money put buying (active hedging signal)

Read this panel FIRST when you sit down. It gives you the context before you look at your footprint charts.

#### Strike Heatmaps

Shows where put and call volume is concentrated by strike price, with distance from spot. When you see heavy put volume at a specific strike:

- That strike is being used as a hedging floor by large players
- Cross-reference it with your Hyblock liquidation heatmap
- If the same level shows up in both, that's high-conviction support/target

#### Expiry Breakdown

Shows which expiries are most active. Near-term expiries with heavy put volume = urgent hedging. Longer-dated put buying = structural positioning for a move that hasn't happened yet.

#### Trade Feed

Scrollable list of recent options trades with:

- Type (put/call), direction (buy/sell), strike, size
- Distance from current price
- Size tags (NOTABLE, LARGE, WHALE)
- Automatic interpretation of each trade

Filter by puts only, calls only, or large trades only to focus on what matters.

### Understanding Telegram Alerts

The bot sends several types of alerts:

#### Trade Alerts

```
🚨 WHALE BTC OPTIONS TRADE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 PUT | Strike: $68,000
📅 Expiry: 14FEB26
📦 Size: 150.0 BTC ($10,500,000)
💰 Price: 0.0234 BTC | IV: 65.2%
↕️ -3.2% from spot
🔄 Direction: BUY

💡 Near-the-money put buying — likely hedging a long position. 
Protective floor at $68,000.
```

When you see this: Someone with a large long position just bought downside protection at $68,000. Check your footprint — if NL (net longs) is declining on the same timeframe, they're actively de-risking. If NL is flat and they're buying puts, they're keeping the position but hedging it — they expect volatility but aren't sure of direction.

#### P/C Ratio Alerts

```
⚠️ PUT/CALL RATIO ALERT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Ratio: 2.15 (threshold: 1.5)
🔴 Puts: 342.5 BTC
🟢 Calls: 159.2 BTC
⏱️ Window: 60min

💡 Elevated put activity — market is hedging or positioning 
for downside.
```

When you see this: The options market is significantly more put-heavy than normal. This is a macro signal — it doesn't mean price drops immediately, but it tells you smart money is paying for protection. Combine with CVD: if CVD is also negative, the options flow confirms the spot/futures selling. If CVD is positive but puts are heavy, someone is bullish on price but hedging against a tail event.

#### On-Chain Alerts

```
🚨 WHALE TX
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 Amount: 1,250.00 BTC ($87,500,000)
📍 Status: ⏳ Mempool
📥 Unknown Wallet → Binance
🔗 View TX

💡 Deposit to Binance. 1,250 BTC moving to exchange — potential 
sell pressure incoming. Watch for increased ask-side liquidity 
on Binance order books.
```

When you see this: 1,250 BTC just moved to Binance. That's potential sell pressure. Check your footprint's bid/ask ratio — if asks start stacking up on Binance shortly after, this coin is likely being positioned for sale. If it's a withdrawal FROM an exchange, that's generally bullish (reducing sell-side supply).

#### Hourly Summaries

Periodic overview of the options flow state — P/C ratio, top put strikes, and overall market sentiment assessment.

### The Trading Workflow: Combining Everything

Here's how to use this system with your existing tools (footprint, CVD, heatmap):

#### Before Trading — Check the Dashboard

1. Open the dashboard
2. Read the Market Interpretation panel first
3. Note the P/C ratio and sentiment
4. Check which strikes have concentrated put activity
5. Cross-reference those strikes with your Hyblock heatmap

This gives you the "smart money positioning" layer before you even look at a candle.

#### During Trading — Monitor Telegram

1. Keep Telegram open on your phone or second screen
2. When a whale trade alert fires, note the strike and direction
3. If you see concentrated put buying at a level near your footprint's current price action, that's a confirmation signal
4. If P/C ratio spikes while you're watching distribution on the footprint, conviction increases

#### Making Trade Decisions — The Corroboration Framework

For a SHORT entry, you want to see alignment across:

| Tool | Bearish Signal |
|------|---------------|
| Footprint (NL/NS) | Net longs closing, net shorts building |
| CVD | Negative and declining |
| Heatmap | Liquidity cluster above recently swept |
| Dashboard P/C | Above 1.5, puts dominating |
| Dashboard Strikes | Concentrated puts below current price (hedging floor = expected drop zone) |
| Telegram Whale | Large put buying near the money |
| Telegram On-chain | Large deposits to exchanges |

For a LONG entry, flip everything:

| Tool | Bullish Signal |
|------|---------------|
| Footprint (NL/NS) | Net shorts closing, net longs building |
| CVD | Positive and rising |
| Heatmap | Liquidity cluster below recently swept |
| Dashboard P/C | Below 0.7, calls dominating |
| Dashboard Strikes | Put selling (bullish) or call buying at specific strikes |
| Telegram Whale | Large call buying or put selling |
| Telegram On-chain | Large withdrawals from exchanges |

You don't need ALL signals to align — 4 out of 7 gives you solid conviction. The more that align, the higher your position size.

#### The Specific Question You Asked: "Are the $58K Longs Hedging?"

Now you can answer this. If:

- The bot alerts you to large put buying at strikes between $65K-$68K
- The dashboard shows concentrated put volume at those same strikes
- Your footprint shows NL declining (longs closing)
- On-chain shows BTC moving to exchanges

Then yes — the bottom buyers are actively hedging or exiting. That's the corroboration you wanted.

If instead you see:

- No significant put activity
- Low P/C ratio
- NL stable or increasing
- No exchange deposits

Then the bottom buyers are holding with confidence and not hedging. That changes your short thesis.

---

## Part 4: Troubleshooting

### Bot won't start

```
Error: TELEGRAM_BOT_TOKEN not set
```

You forgot to edit the CONFIG. Open bot.py and set your token and chat ID.

### Bot starts but no Telegram messages

- Open your bot in Telegram and press **Start** (you must message it at least once)
- Make sure the chat ID is YOUR id, not the bot's id
- Check your internet connection

### Dashboard shows "loading..."

- Deribit's API might be temporarily down — refresh after a minute
- Check browser console (F12) for CORS errors
- If running locally, make sure you're accessing via `http://localhost:3000`

### Too many alerts

- Increase `OPTIONS_MIN_TRADE_SIZE_BTC` to 15 or 25
- Increase `ONCHAIN_MIN_BTC` to 500
- Increase `PUT_CALL_ALERT_THRESHOLD` to 2.0

### Too few alerts

- Decrease `OPTIONS_MIN_TRADE_SIZE_BTC` to 2
- Decrease `ONCHAIN_MIN_BTC` to 50
- Decrease `PUT_CALL_ALERT_THRESHOLD` to 1.2

### On-chain alerts are noisy

This is expected without Arkham/Nansen wallet labeling. The bot can only identify known exchange addresses. Unknown-to-unknown transfers will show as "Unknown → Unknown" with limited interpretation. To upgrade this:

1. Get an Arkham Intelligence API key (arkham.com)
2. I can add a module that labels wallets by entity
3. This dramatically reduces noise and increases signal quality

---

## Part 5: Future Upgrades

Things I can build if you want to expand this:

- **Arkham wallet labeling** — Label every on-chain movement by entity (requires Arkham API key, paid)
- **Glassnode metrics** — SOPR, MVRV, exchange netflow overlays (requires Glassnode key, paid)
- **Funding rate monitor** — Track funding across Binance/OKX/Bybit and alert on extremes
- **Open interest heatmap** — Visualize OI changes by strike and expiry on the dashboard
- **Multi-asset** — Extend to ETH, SOL, or other assets
- **Historical analysis** — Store trades in a database and run backtests on options flow signals
- **Discord integration** — If you prefer Discord over Telegram
- **Mobile-optimized dashboard** — Responsive version for phone use

Let me know what would be most useful and I'll build it.
