const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );

        // POST: save a trade from the client (dual-write)
        if (req.method === 'POST') {
            const trade = req.body;
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
                return res.status(500).json({ error: error.message });
            }

            return res.status(200).json({ ok: true });
        }

        // GET: fetch trades from Supabase
        const limit = parseInt(req.query.limit || '500', 10);
        const since = req.query.since;

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
            return res.status(500).json({ error: error.message });
        }

        // Transform column names from snake_case to camelCase for frontend
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

        res.setHeader('Cache-Control', 'public, max-age=10');
        return res.status(200).json({ trades, count: trades.length });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
