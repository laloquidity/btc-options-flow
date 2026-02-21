import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        // POST: save a trade from the client (dual-write)
        if (req.method === 'POST') {
            const trade = await req.json();
            const row = {
                trade_id: trade.trade_id,
                instrument_name: trade.instrument_name,
                direction: trade.direction,
                amount: trade.amount,
                price: trade.price,
                timestamp: trade.timestamp,
                btc_price_at_save: trade.btcPriceAtSave,
                notional_usd: trade.notionalUsd,
                saved_at: trade.savedAt || Date.now(),
            };

            const { error } = await supabase
                .from('whale_trades')
                .upsert([row], { onConflict: 'trade_id', ignoreDuplicates: true });

            if (error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
                });
            }

            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
        }

        // GET: fetch trades from Supabase
        const url = new URL(req.url);
        const limit = parseInt(url.searchParams.get('limit') || '500', 10);
        const since = url.searchParams.get('since');

        let query = supabase
            .from('whale_trades')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (since) {
            query = query.gte('timestamp', parseInt(since, 10));
        }

        const { data, error } = await query;

        if (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
        }

        // Transform column names from snake_case to camelCase for frontend compatibility
        const trades = (data || []).map(row => ({
            trade_id: row.trade_id,
            instrument_name: row.instrument_name,
            direction: row.direction,
            amount: parseFloat(row.amount),
            price: parseFloat(row.price),
            timestamp: parseInt(row.timestamp, 10),
            btcPriceAtSave: parseFloat(row.btc_price_at_save),
            notionalUsd: parseFloat(row.notional_usd),
            savedAt: parseInt(row.saved_at, 10),
        }));

        return new Response(JSON.stringify({ trades, count: trades.length }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=10',
                ...CORS_HEADERS,
            },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
    }
}

export const config = {
    runtime: 'edge',
};
