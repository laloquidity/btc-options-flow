const { createClient } = require('@supabase/supabase-js');

const DERIBIT_API = 'https://www.deribit.com/api/v2/public';
const SAVE_THRESHOLD_USD = 500_000;
const SAVE_THRESHOLD_BTC = 50;
const FETCH_TIMEOUT_MS = 10_000; // 10s timeout per request
const MAX_RETRIES = 3;

async function fetchDeribit(endpoint, params = {}, retries = MAX_RETRIES) {
    const url = new URL(`${DERIBIT_API}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const res = await fetch(url.toString(), { signal: controller.signal });
            clearTimeout(timeout);

            if (!res.ok) {
                // Retry on 429 (rate-limit) or 5xx (server error)
                if ((res.status === 429 || res.status >= 500) && attempt < retries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
                    console.warn(`Deribit ${endpoint} returned HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt}/${retries})`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw new Error(`Deribit API error: HTTP ${res.status}`);
            }

            const data = await res.json();
            return data.result;
        } catch (err) {
            if (err.name === 'AbortError') {
                err.message = `Deribit ${endpoint} timed out after ${FETCH_TIMEOUT_MS}ms`;
            }
            if (attempt < retries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
                console.warn(`Deribit ${endpoint} failed: ${err.message}, retrying in ${delay}ms (attempt ${attempt}/${retries})`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
}

module.exports = async function handler(req, res) {
    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        // Fetch current BTC price
        const priceResult = await fetchDeribit('get_index_price', { index_name: 'btc_usd' });
        const btcPrice = priceResult?.index_price || 0;
        if (!btcPrice) {
            return res.status(500).json({ error: 'Could not fetch BTC price' });
        }

        // Fetch latest options trades
        const tradesResult = await fetchDeribit('get_last_trades_by_currency', {
            currency: 'BTC',
            kind: 'option',
            count: '200',
            sorting: 'desc',
        });
        const trades = tradesResult?.trades || [];

        // Filter for whale trades
        const whaleTrades = trades.filter(t => {
            const notional = t.amount * btcPrice;
            return notional >= SAVE_THRESHOLD_USD || t.amount >= SAVE_THRESHOLD_BTC;
        });

        if (whaleTrades.length === 0) {
            return res.status(200).json({
                message: 'No whale trades found',
                btcPrice,
                totalTrades: trades.length,
            });
        }

        // Upsert whale trades to Supabase (dedup by trade_id)
        const rows = whaleTrades.map(t => ({
            trade_id: t.trade_id,
            instrument_name: t.instrument_name,
            direction: t.direction,
            amount: t.amount,
            price: t.price,
            timestamp: t.timestamp,
            btc_price_at_save: btcPrice,
            notional_usd: t.amount * btcPrice,
            saved_at: Date.now(),
        }));

        const { error } = await supabase
            .from('whale_trades')
            .upsert(rows, { onConflict: 'trade_id', ignoreDuplicates: true });

        if (error) {
            console.error('Supabase upsert error:', error);
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({
            message: `Processed ${whaleTrades.length} whale trades`,
            btcPrice,
            totalTrades: trades.length,
            whaleTrades: whaleTrades.length,
        });
    } catch (err) {
        console.error('Cron error:', err);
        return res.status(500).json({ error: err.message });
    }
};
