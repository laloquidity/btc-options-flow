import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DERIBIT_API = 'https://www.deribit.com/api/v2/public';
const SAVE_THRESHOLD_USD = 500_000;
const SAVE_THRESHOLD_BTC = 50;

async function fetchDeribit(endpoint, params = {}) {
    const url = new URL(`${DERIBIT_API}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Deribit API error: HTTP ${res.status}`);
    const data = await res.json();
    return data.result;
}

export default async function handler(req) {
    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        // Fetch current BTC price
        const priceResult = await fetchDeribit('get_index_price', { index_name: 'btc_usd' });
        const btcPrice = priceResult?.index_price || 0;
        if (!btcPrice) {
            return new Response(JSON.stringify({ error: 'Could not fetch BTC price' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
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
            return new Response(JSON.stringify({
                message: 'No whale trades found',
                btcPrice,
                totalTrades: trades.length,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
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

        const { data, error } = await supabase
            .from('whale_trades')
            .upsert(rows, { onConflict: 'trade_id', ignoreDuplicates: true });

        if (error) {
            console.error('Supabase upsert error:', error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({
            message: `Processed ${whaleTrades.length} whale trades`,
            btcPrice,
            totalTrades: trades.length,
            whaleTrades: whaleTrades.length,
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err) {
        console.error('Cron error:', err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export const config = {
    runtime: 'edge',
};
