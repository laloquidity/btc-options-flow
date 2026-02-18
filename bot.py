"""
BTC Options Flow & Whale Tracking Telegram Bot
================================================
Monitors:
1. Deribit BTC options - large trades, put/call shifts, unusual activity
2. On-chain large BTC transactions (mempool.space + blockchain.com)

Free APIs only. No keys required except Telegram bot token.
"""

import asyncio
import aiohttp
import json
import time
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional
from telegram import Bot
from telegram.constants import ParseMode

# ============================================================
# CONFIGURATION - Edit these values
# ============================================================

CONFIG = {
    # Telegram
    "TELEGRAM_BOT_TOKEN": "YOUR_BOT_TOKEN_HERE",  # Get from @BotFather
    "TELEGRAM_CHAT_ID": "YOUR_CHAT_ID_HERE",      # Get from @userinfobot
    
    # Deribit Options Flow
    "OPTIONS_MIN_TRADE_SIZE_BTC": 5.0,        # Min BTC notional to alert on
    "OPTIONS_LARGE_TRADE_BTC": 25.0,          # "Large" trade threshold
    "OPTIONS_WHALE_TRADE_BTC": 100.0,         # "Whale" trade threshold
    "OPTIONS_POLL_INTERVAL_SEC": 10,           # How often to check Deribit
    "PUT_CALL_ALERT_THRESHOLD": 1.5,           # Alert if P/C ratio exceeds this
    "PUT_CALL_WINDOW_MINUTES": 60,             # Rolling window for P/C ratio
    
    # On-Chain Whale Tracking
    "ONCHAIN_MIN_BTC": 100,                    # Min BTC to track
    "ONCHAIN_LARGE_BTC": 500,                  # "Large" threshold
    "ONCHAIN_WHALE_BTC": 1000,                 # "Whale" threshold  
    "ONCHAIN_POLL_INTERVAL_SEC": 30,           # How often to check mempool
    
    # Known Exchange Addresses (partial list - expand as needed)
    "EXCHANGE_ADDRESSES": {
        "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3": "Binance",
        "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6": "Binance",
        "bc1qjasf9z3h7w3jspkhtgatgpyvvzgpa2wwd2lr0": "Binance",
        "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s": "Binance",
        "3Kzh9qAqVWQhEsfQz7zEQL1EuSx5tyNLNS": "Bitfinex",
        "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97": "Bitfinex",
        "3FHNBLobJnbCTFTVakh5TXmEneyf5PT61B": "Bitstamp",
        "3DVJfEsDTPkGDvqPCLC41X85L1B1DQR4GH": "Bitstamp",
        "bc1q7cyrfmck2ffu2ud3rn5l5a8yv6f0chkp0zpemf": "Bybit",
        "1FzWLkAahHooV3kzTgyx6qsXoRDrBsrACw": "Bybit",
        "3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb": "OKX",
        "bc1q2s3rjwvam9dt2ftt4sqxqjf3twav0gdx0k0q2etjz348p3spezmqjh6wra": "OKX",
    },
    
    # General
    "HEARTBEAT_INTERVAL_SEC": 3600,  # Status update every hour
}


# ============================================================
# LOGGING
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("BTCFlowBot")


# ============================================================
# DATA STRUCTURES
# ============================================================

@dataclass
class OptionsState:
    """Tracks rolling options flow state"""
    recent_trades: list = field(default_factory=list)       # (timestamp, type, strike, size_btc, price, iv)
    last_trade_id: Optional[str] = None
    puts_volume_btc: float = 0.0
    calls_volume_btc: float = 0.0
    last_pc_alert_time: float = 0.0
    large_put_strikes: dict = field(default_factory=dict)   # strike -> total_btc
    

@dataclass  
class OnChainState:
    """Tracks seen transactions to avoid duplicates"""
    seen_txids: set = field(default_factory=set)
    max_seen: int = 10000  # Cap memory usage
    

# ============================================================
# TELEGRAM HELPERS
# ============================================================

class TelegramSender:
    def __init__(self, token: str, chat_id: str):
        self.bot = Bot(token=token)
        self.chat_id = chat_id
        self.queue: asyncio.Queue = asyncio.Queue()
        self._rate_limit_delay = 0.5  # Telegram rate limit safety
        
    async def start(self):
        """Process message queue"""
        while True:
            msg = await self.queue.get()
            try:
                await self.bot.send_message(
                    chat_id=self.chat_id,
                    text=msg,
                    parse_mode=ParseMode.HTML,
                    disable_web_page_preview=True
                )
            except Exception as e:
                logger.error(f"Telegram send error: {e}")
            await asyncio.sleep(self._rate_limit_delay)
    
    async def send(self, message: str):
        await self.queue.put(message)


# ============================================================
# DERIBIT OPTIONS FLOW MONITOR
# ============================================================

class DeribitMonitor:
    """
    Monitors Deribit BTC options trades via public API.
    
    Alerts on:
    - Large individual trades
    - Unusual put activity near current price (hedging signal)
    - Put/call ratio shifts
    - Concentrated strike activity
    """
    
    BASE_URL = "https://www.deribit.com/api/v2/public"
    
    def __init__(self, sender: TelegramSender, config: dict):
        self.sender = sender
        self.config = config
        self.state = OptionsState()
        self.btc_price = 0.0
        self.session: Optional[aiohttp.ClientSession] = None
        
    async def start(self):
        self.session = aiohttp.ClientSession()
        logger.info("Deribit monitor started")
        
        while True:
            try:
                await self._poll_cycle()
            except Exception as e:
                logger.error(f"Deribit poll error: {e}")
            await asyncio.sleep(self.config["OPTIONS_POLL_INTERVAL_SEC"])
    
    async def _poll_cycle(self):
        # Get current BTC price
        await self._update_btc_price()
        
        # Get recent trades
        trades = await self._fetch_recent_trades()
        if not trades:
            return
            
        # Process each trade
        for trade in trades:
            await self._process_trade(trade)
        
        # Check rolling P/C ratio
        await self._check_put_call_ratio()
        
        # Check concentrated strike activity
        await self._check_strike_concentration()
        
        # Clean old trades from rolling window
        self._clean_old_trades()
    
    async def _update_btc_price(self):
        url = f"{self.BASE_URL}/get_index_price"
        params = {"index_name": "btc_usd"}
        async with self.session.get(url, params=params) as resp:
            if resp.status == 200:
                data = await resp.json()
                self.btc_price = data.get("result", {}).get("index_price", 0)
    
    async def _fetch_recent_trades(self) -> list:
        url = f"{self.BASE_URL}/get_last_trades_by_currency"
        params = {
            "currency": "BTC",
            "kind": "option",
            "count": 100,
            "sorting": "desc"
        }
        
        async with self.session.get(url, params=params) as resp:
            if resp.status != 200:
                return []
            data = await resp.json()
            trades = data.get("result", {}).get("trades", [])
        
        # Filter to only new trades
        if self.state.last_trade_id:
            new_trades = []
            for t in trades:
                if t["trade_id"] == self.state.last_trade_id:
                    break
                new_trades.append(t)
            trades = new_trades
        
        if trades:
            self.state.last_trade_id = trades[0]["trade_id"]
        
        return trades
    
    async def _process_trade(self, trade: dict):
        """Process a single options trade"""
        instrument = trade.get("instrument_name", "")
        amount = trade.get("amount", 0)  # in BTC
        price = trade.get("price", 0)
        direction = trade.get("direction", "")
        iv = trade.get("iv", 0)
        timestamp = trade.get("timestamp", 0) / 1000
        
        # Parse instrument: BTC-7FEB25-70000-P
        parts = instrument.split("-")
        if len(parts) < 4:
            return
            
        expiry = parts[1]
        strike = float(parts[2])
        option_type = parts[3]  # P or C
        
        # Track in rolling window
        self.state.recent_trades.append({
            "timestamp": timestamp,
            "type": option_type,
            "strike": strike,
            "size_btc": amount,
            "price": price,
            "iv": iv,
            "direction": direction,
            "instrument": instrument,
            "expiry": expiry
        })
        
        # Update P/C volumes
        if option_type == "P":
            self.state.puts_volume_btc += amount
            # Track put strikes
            self.state.large_put_strikes[strike] = \
                self.state.large_put_strikes.get(strike, 0) + amount
        else:
            self.state.calls_volume_btc += amount
        
        # Check if trade meets alert threshold
        if amount >= self.config["OPTIONS_MIN_TRADE_SIZE_BTC"]:
            await self._alert_trade(trade, option_type, strike, expiry, amount, price, iv, direction)
    
    async def _alert_trade(self, trade, option_type, strike, expiry, amount, price, iv, direction):
        """Send alert for significant trade"""
        
        # Determine size category
        if amount >= self.config["OPTIONS_WHALE_TRADE_BTC"]:
            size_label = "🐋 WHALE"
            emoji = "🚨"
        elif amount >= self.config["OPTIONS_LARGE_TRADE_BTC"]:
            size_label = "🔵 LARGE"
            emoji = "⚡"
        else:
            size_label = "📊 NOTABLE"
            emoji = "📊"
        
        type_emoji = "🔴" if option_type == "P" else "🟢"
        type_label = "PUT" if option_type == "P" else "CALL"
        
        # Calculate distance from current price
        if self.btc_price > 0:
            distance = ((strike - self.btc_price) / self.btc_price) * 100
            distance_str = f"{distance:+.1f}% from spot"
        else:
            distance_str = ""
        
        # Notional USD value
        notional_usd = amount * self.btc_price
        
        # Interpret the trade
        interpretation = self._interpret_trade(option_type, strike, direction, amount)
        
        msg = (
            f"{emoji} <b>{size_label} BTC OPTIONS TRADE</b>\n"
            f"{'━' * 30}\n"
            f"{type_emoji} <b>{type_label}</b> | Strike: <b>${strike:,.0f}</b>\n"
            f"📅 Expiry: {expiry}\n"
            f"📦 Size: <b>{amount:.1f} BTC</b> (${notional_usd:,.0f})\n"
            f"💰 Price: {price:.4f} BTC | IV: {iv:.1f}%\n"
            f"↕️ {distance_str}\n"
            f"🔄 Direction: {direction.upper()}\n"
            f"\n💡 <i>{interpretation}</i>"
        )
        
        await self.sender.send(msg)
    
    def _interpret_trade(self, option_type: str, strike: float, direction: str, amount: float) -> str:
        """Provide trading interpretation of the options trade"""
        
        if self.btc_price == 0:
            return "Unable to interpret - no price data"
        
        otm_pct = abs(strike - self.btc_price) / self.btc_price * 100
        
        if option_type == "P":
            if direction == "buy":
                if strike < self.btc_price and otm_pct < 10:
                    return f"Near-the-money put buying — likely hedging a long position. Protective floor at ${strike:,.0f}."
                elif strike < self.btc_price and otm_pct >= 10:
                    return f"Deep OTM put buying — tail risk protection or bearish bet on a crash below ${strike:,.0f}."
                elif strike >= self.btc_price:
                    return f"ITM/ATM put buying — aggressive bearish positioning or delta-neutral hedge."
            else:  # sell
                if strike < self.btc_price:
                    return f"Put selling at ${strike:,.0f} — bullish. Collecting premium, believes price stays above strike."
                else:
                    return f"ITM put selling — closing a protective position or taking a bullish stance."
        else:  # CALL
            if direction == "buy":
                if strike > self.btc_price and otm_pct < 10:
                    return f"Near-the-money call buying — bullish positioning. Targeting move above ${strike:,.0f}."
                elif strike > self.btc_price and otm_pct >= 10:
                    return f"Deep OTM call buying — lottery ticket or hedging short exposure above ${strike:,.0f}."
                elif strike <= self.btc_price:
                    return f"ITM/ATM call buying — strong bullish conviction or replacing spot exposure with leverage."
            else:  # sell
                if strike > self.btc_price:
                    return f"Call selling at ${strike:,.0f} — capping upside. Likely covered call or bearish lean."
                else:
                    return f"ITM call selling — closing a bullish position or taking profit."
        
        return "Mixed signal — review in context of broader flow."
    
    async def _check_put_call_ratio(self):
        """Alert on significant P/C ratio shifts"""
        now = time.time()
        window = self.config["PUT_CALL_WINDOW_MINUTES"] * 60
        
        # Only alert once per window
        if now - self.state.last_pc_alert_time < window:
            return
        
        # Calculate rolling P/C from recent trades
        puts_vol = 0
        calls_vol = 0
        for t in self.state.recent_trades:
            if now - t["timestamp"] <= window:
                if t["type"] == "P":
                    puts_vol += t["size_btc"]
                else:
                    calls_vol += t["size_btc"]
        
        if calls_vol == 0:
            return
            
        pc_ratio = puts_vol / calls_vol
        
        if pc_ratio >= self.config["PUT_CALL_ALERT_THRESHOLD"]:
            self.state.last_pc_alert_time = now
            msg = (
                f"⚠️ <b>PUT/CALL RATIO ALERT</b>\n"
                f"{'━' * 30}\n"
                f"📊 Ratio: <b>{pc_ratio:.2f}</b> "
                f"(threshold: {self.config['PUT_CALL_ALERT_THRESHOLD']})\n"
                f"🔴 Puts: {puts_vol:.1f} BTC\n"
                f"🟢 Calls: {calls_vol:.1f} BTC\n"
                f"⏱️ Window: {self.config['PUT_CALL_WINDOW_MINUTES']}min\n"
                f"\n💡 <i>Elevated put activity — market is hedging or "
                f"positioning for downside. Check if concentrated at specific "
                f"strikes below.</i>"
            )
            await self.sender.send(msg)
    
    async def _check_strike_concentration(self):
        """Alert if put activity concentrates at specific strikes"""
        if not self.state.large_put_strikes:
            return
            
        for strike, total_btc in list(self.state.large_put_strikes.items()):
            if total_btc >= self.config["OPTIONS_LARGE_TRADE_BTC"] * 2:
                if self.btc_price > 0:
                    distance = ((strike - self.btc_price) / self.btc_price) * 100
                    msg = (
                        f"🎯 <b>CONCENTRATED PUT ACTIVITY</b>\n"
                        f"{'━' * 30}\n"
                        f"Strike: <b>${strike:,.0f}</b> ({distance:+.1f}% from spot)\n"
                        f"Total volume: <b>{total_btc:.1f} BTC</b>\n"
                        f"BTC Price: ${self.btc_price:,.0f}\n"
                        f"\n💡 <i>Multiple put trades clustering at ${strike:,.0f}. "
                        f"This strike may represent a hedging floor or "
                        f"anticipated support/target level.</i>"
                    )
                    await self.sender.send(msg)
                # Reset after alerting
                self.state.large_put_strikes[strike] = 0
    
    def _clean_old_trades(self):
        """Remove trades older than rolling window"""
        cutoff = time.time() - (self.config["PUT_CALL_WINDOW_MINUTES"] * 60 * 2)
        self.state.recent_trades = [
            t for t in self.state.recent_trades if t["timestamp"] > cutoff
        ]
        
    async def cleanup(self):
        if self.session:
            await self.session.close()


# ============================================================
# ON-CHAIN WHALE MONITOR
# ============================================================

class OnChainMonitor:
    """
    Monitors large BTC transactions using free APIs.
    
    Limitations without Arkham/Nansen:
    - Cannot label most wallets (only known exchange addresses)
    - Cannot attribute to specific entities
    - Exchange internal transfers will create noise
    
    Uses mempool.space API (free, no key needed)
    """
    
    MEMPOOL_API = "https://mempool.space/api"
    
    def __init__(self, sender: TelegramSender, config: dict):
        self.sender = sender
        self.config = config
        self.state = OnChainState()
        self.session: Optional[aiohttp.ClientSession] = None
        self.btc_price = 0.0
        
    async def start(self):
        self.session = aiohttp.ClientSession()
        logger.info("On-chain monitor started")
        
        while True:
            try:
                await self._poll_cycle()
            except Exception as e:
                logger.error(f"On-chain poll error: {e}")
            await asyncio.sleep(self.config["ONCHAIN_POLL_INTERVAL_SEC"])
    
    async def _poll_cycle(self):
        await self._update_price()
        await self._check_recent_blocks()
        await self._check_mempool()
        self._trim_seen()
    
    async def _update_price(self):
        """Get BTC price from mempool.space"""
        url = f"{self.MEMPOOL_API}/v1/prices"
        try:
            async with self.session.get(url) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    self.btc_price = data.get("USD", 0)
        except Exception:
            pass
    
    async def _check_recent_blocks(self):
        """Check recent confirmed blocks for large transactions"""
        url = f"{self.MEMPOOL_API}/blocks"
        try:
            async with self.session.get(url) as resp:
                if resp.status != 200:
                    return
                blocks = await resp.json()
        except Exception:
            return
        
        if not blocks:
            return
            
        # Check latest block
        block_hash = blocks[0].get("id", "")
        if not block_hash:
            return
            
        txs_url = f"{self.MEMPOOL_API}/block/{block_hash}/txs"
        try:
            async with self.session.get(txs_url) as resp:
                if resp.status != 200:
                    return
                txs = await resp.json()
        except Exception:
            return
        
        for tx in txs:
            await self._process_tx(tx, confirmed=True)
    
    async def _check_mempool(self):
        """Check mempool for large unconfirmed transactions"""
        url = f"{self.MEMPOOL_API}/mempool/recent"
        try:
            async with self.session.get(url) as resp:
                if resp.status != 200:
                    return
                txs = await resp.json()
        except Exception:
            return
        
        for tx_summary in txs:
            txid = tx_summary.get("txid", "")
            value_sats = tx_summary.get("value", 0)
            value_btc = value_sats / 1e8
            
            if value_btc < self.config["ONCHAIN_MIN_BTC"]:
                continue
            if txid in self.state.seen_txids:
                continue
                
            # Fetch full tx for address analysis
            tx_url = f"{self.MEMPOOL_API}/tx/{txid}"
            try:
                async with self.session.get(tx_url) as resp:
                    if resp.status != 200:
                        continue
                    tx = await resp.json()
            except Exception:
                continue
            
            await self._process_tx(tx, confirmed=False)
    
    async def _process_tx(self, tx: dict, confirmed: bool):
        """Process a transaction and alert if significant"""
        txid = tx.get("txid", "")
        
        if txid in self.state.seen_txids:
            return
        
        # Calculate total output value
        total_btc = 0
        output_addresses = []
        input_addresses = []
        
        for vout in tx.get("vout", []):
            value_btc = vout.get("value", 0) / 1e8
            total_btc += value_btc
            addr = vout.get("scriptpubkey_address", "")
            if addr:
                output_addresses.append((addr, value_btc))
        
        for vin in tx.get("vin", []):
            prevout = vin.get("prevout", {})
            addr = prevout.get("scriptpubkey_address", "")
            if addr:
                input_addresses.append(addr)
        
        if total_btc < self.config["ONCHAIN_MIN_BTC"]:
            return
        
        self.state.seen_txids.add(txid)
        
        # Identify exchange involvement
        from_exchange = None
        to_exchange = None
        
        for addr in input_addresses:
            if addr in self.config["EXCHANGE_ADDRESSES"]:
                from_exchange = self.config["EXCHANGE_ADDRESSES"][addr]
                break
        
        for addr, _ in output_addresses:
            if addr in self.config["EXCHANGE_ADDRESSES"]:
                to_exchange = self.config["EXCHANGE_ADDRESSES"][addr]
                break
        
        # Determine flow type and significance
        flow_type, interpretation = self._classify_flow(
            from_exchange, to_exchange, total_btc
        )
        
        # Size category
        if total_btc >= self.config["ONCHAIN_WHALE_BTC"]:
            size_label = "🐋 WHALE TX"
            emoji = "🚨"
        elif total_btc >= self.config["ONCHAIN_LARGE_BTC"]:
            size_label = "🔵 LARGE TX"
            emoji = "⚡"
        else:
            size_label = "📊 NOTABLE TX"
            emoji = "📊"
        
        usd_value = total_btc * self.btc_price if self.btc_price > 0 else 0
        status = "✅ Confirmed" if confirmed else "⏳ Mempool"
        
        msg = (
            f"{emoji} <b>{size_label}</b>\n"
            f"{'━' * 30}\n"
            f"💰 Amount: <b>{total_btc:,.2f} BTC</b>"
            f"{f' (${usd_value:,.0f})' if usd_value > 0 else ''}\n"
            f"📍 Status: {status}\n"
            f"{flow_type}\n"
            f"🔗 <a href='https://mempool.space/tx/{txid}'>View TX</a>\n"
            f"\n💡 <i>{interpretation}</i>"
        )
        
        await self.sender.send(msg)
    
    def _classify_flow(self, from_exchange, to_exchange, amount_btc):
        """Classify the transaction flow and provide interpretation"""
        
        if from_exchange and to_exchange:
            flow = f"🔄 {from_exchange} → {to_exchange}"
            interp = (
                f"Exchange to exchange transfer. Could be arbitrage, "
                f"internal rebalancing, or position migration. "
                f"Low signal without additional context."
            )
        elif from_exchange and not to_exchange:
            flow = f"📤 {from_exchange} → Unknown Wallet"
            interp = (
                f"Withdrawal from {from_exchange}. {amount_btc:,.0f} BTC moving "
                f"to self-custody. Generally bullish — reduces sell-side supply "
                f"on exchanges. Could be institutional cold storage move."
            )
        elif not from_exchange and to_exchange:
            flow = f"📥 Unknown Wallet → {to_exchange}"
            interp = (
                f"Deposit to {to_exchange}. {amount_btc:,.0f} BTC moving to "
                f"exchange — potential sell pressure incoming. Watch for increased "
                f"ask-side liquidity on {to_exchange} order books."
            )
        else:
            flow = "❓ Unknown → Unknown"
            interp = (
                f"Non-exchange transfer. Could be OTC deal, fund rebalancing, "
                f"or cold storage rotation. Without wallet labeling (Arkham/Nansen), "
                f"cannot determine intent."
            )
        
        return flow, interp
    
    def _trim_seen(self):
        """Prevent memory bloat"""
        if len(self.state.seen_txids) > self.state.max_seen:
            # Keep most recent half
            self.state.seen_txids = set(
                list(self.state.seen_txids)[self.state.max_seen // 2:]
            )
    
    async def cleanup(self):
        if self.session:
            await self.session.close()


# ============================================================
# PERIODIC SUMMARY
# ============================================================

class SummaryReporter:
    """Sends periodic flow summaries"""
    
    def __init__(self, sender: TelegramSender, deribit: DeribitMonitor, config: dict):
        self.sender = sender
        self.deribit = deribit
        self.config = config
    
    async def start(self):
        while True:
            await asyncio.sleep(self.config["HEARTBEAT_INTERVAL_SEC"])
            try:
                await self._send_summary()
            except Exception as e:
                logger.error(f"Summary error: {e}")
    
    async def _send_summary(self):
        state = self.deribit.state
        btc_price = self.deribit.btc_price
        
        total_puts = state.puts_volume_btc
        total_calls = state.calls_volume_btc
        pc_ratio = total_puts / total_calls if total_calls > 0 else 0
        
        # Top put strikes
        sorted_strikes = sorted(
            state.large_put_strikes.items(), 
            key=lambda x: x[1], 
            reverse=True
        )[:5]
        
        strikes_str = ""
        for strike, vol in sorted_strikes:
            if vol > 0:
                dist = ((strike - btc_price) / btc_price * 100) if btc_price > 0 else 0
                strikes_str += f"  ${strike:,.0f} ({dist:+.1f}%): {vol:.1f} BTC\n"
        
        if not strikes_str:
            strikes_str = "  No significant activity\n"
        
        # Determine market sentiment
        if pc_ratio > 1.5:
            sentiment = "🔴 Heavily hedged / bearish options flow"
        elif pc_ratio > 1.0:
            sentiment = "🟡 Slightly put-heavy — cautious positioning"
        elif pc_ratio > 0.7:
            sentiment = "⚪ Balanced flow — no strong directional lean"
        else:
            sentiment = "🟢 Call-heavy — bullish options positioning"
        
        msg = (
            f"📊 <b>HOURLY OPTIONS FLOW SUMMARY</b>\n"
            f"{'━' * 30}\n"
            f"💲 BTC Price: ${btc_price:,.0f}\n"
            f"🔴 Total Puts: {total_puts:,.1f} BTC\n"
            f"🟢 Total Calls: {total_calls:,.1f} BTC\n"
            f"📊 P/C Ratio: <b>{pc_ratio:.2f}</b>\n"
            f"\n🎯 <b>Top Put Strikes:</b>\n{strikes_str}"
            f"\n{sentiment}\n"
            f"\n⏱️ Next update in {self.config['HEARTBEAT_INTERVAL_SEC'] // 60} min"
        )
        
        await self.sender.send(msg)


# ============================================================
# MAIN
# ============================================================

async def main():
    # Validate config
    if CONFIG["TELEGRAM_BOT_TOKEN"] == "YOUR_BOT_TOKEN_HERE":
        print("\n" + "=" * 60)
        print("SETUP REQUIRED")
        print("=" * 60)
        print("\n1. Message @BotFather on Telegram to create a bot")
        print("   Send: /newbot")
        print("   Copy the token\n")
        print("2. Message @userinfobot on Telegram to get your chat ID")
        print("   Copy the number\n")
        print("3. Edit CONFIG in bot.py:")
        print('   TELEGRAM_BOT_TOKEN: "your_token_here"')
        print('   TELEGRAM_CHAT_ID: "your_chat_id_here"')
        print("\n4. Run: python3 bot.py")
        print("=" * 60 + "\n")
        return
    
    logger.info("Starting BTC Flow Monitor Bot...")
    
    # Initialize components
    sender = TelegramSender(CONFIG["TELEGRAM_BOT_TOKEN"], CONFIG["TELEGRAM_CHAT_ID"])
    deribit = DeribitMonitor(sender, CONFIG)
    onchain = OnChainMonitor(sender, CONFIG)
    summary = SummaryReporter(sender, deribit, CONFIG)
    
    # Startup message
    await sender.send(
        f"🟢 <b>BTC Flow Monitor Online</b>\n"
        f"{'━' * 30}\n"
        f"📊 Options: Monitoring Deribit (min {CONFIG['OPTIONS_MIN_TRADE_SIZE_BTC']} BTC)\n"
        f"⛓️ On-chain: Monitoring mempool (min {CONFIG['ONCHAIN_MIN_BTC']} BTC)\n"
        f"⏱️ Summaries every {CONFIG['HEARTBEAT_INTERVAL_SEC'] // 60} min\n"
        f"\nTracking: BTC only"
    )
    
    # Run all monitors concurrently
    try:
        await asyncio.gather(
            sender.start(),
            deribit.start(),
            onchain.start(),
            summary.start()
        )
    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        await deribit.cleanup()
        await onchain.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
