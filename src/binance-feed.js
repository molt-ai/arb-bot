/**
 * Exchange Real-Time Price Feed
 * 
 * WebSocket connection to Coinbase (US-friendly) for BTC, ETH, SOL spot prices.
 * Falls back to Binance.US if Coinbase fails.
 * 
 * Tracks real-time price + short-term momentum (1m, 5m, 15m windows).
 * 
 * The edge: Polymarket 15-min crypto markets lag behind exchange spot
 * prices by 1-2 minutes. When we see strong momentum here,
 * Polymarket is still showing ~50/50 odds.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

// Exchange WebSocket URLs (US-accessible)
const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
const BINANCE_US_WS = 'wss://stream.binance.us:9443/stream';

// Coinbase product IDs
const COINBASE_PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const COINBASE_MAP = {
    'BTC-USD': 'BTC',
    'ETH-USD': 'ETH',
    'SOL-USD': 'SOL',
};

// Binance US symbols (fallback)
const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt'];
const SYMBOL_MAP = {
    btcusdt: 'BTC',
    ethusdt: 'ETH',
    solusdt: 'SOL',
};

export class BinanceFeed extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.connected = false;
        this.retries = 0;

        // Price state per symbol
        // Each entry: { price, prices1m: [], prices5m: [], prices15m: [], lastUpdate }
        this.state = {};
        for (const sym of SYMBOLS) {
            const ticker = SYMBOL_MAP[sym];
            this.state[ticker] = {
                price: 0,
                // Rolling window of {price, ts} for momentum calculation
                ticks: [],
                lastUpdate: 0,
            };
        }

        // Cleanup old ticks every 30s
        this._cleanupInterval = null;
    }

    connect() {
        this._connectCoinbase();
    }

    _connectCoinbase() {
        console.log('[EXCHANGE] Connecting to Coinbase WebSocket...');
        this.ws = new WebSocket(COINBASE_WS);

        this.ws.on('open', () => {
            // Subscribe to match (trade) channel for real-time prices
            const subscribe = {
                type: 'subscribe',
                product_ids: COINBASE_PRODUCTS,
                channels: ['matches'],
            };
            this.ws.send(JSON.stringify(subscribe));
            console.log(`[EXCHANGE] ✅ Coinbase connected — tracking ${COINBASE_PRODUCTS.join(', ')}`);
            this.connected = true;
            this.retries = 0;
            this._source = 'coinbase';
            this._cleanupInterval = setInterval(() => this._cleanupTicks(), 30000);
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'match' || msg.type === 'last_match') {
                    this._handleCoinbaseTrade(msg);
                }
            } catch (e) { /* ignore */ }
        });

        this.ws.on('close', () => {
            this.connected = false;
            if (this._cleanupInterval) clearInterval(this._cleanupInterval);
            this.retries++;

            if (this.retries >= 3 && this._source === 'coinbase') {
                console.log('[EXCHANGE] Coinbase failed 3x, trying Binance.US...');
                this._connectBinanceUS();
            } else {
                const delay = Math.min(5000 * this.retries, 30000);
                console.log(`[EXCHANGE] Disconnected, reconnecting in ${delay / 1000}s...`);
                setTimeout(() => this._connectCoinbase(), delay);
            }
        });

        this.ws.on('error', (err) => {
            console.error('[EXCHANGE] Coinbase error:', err.message);
        });
    }

    _connectBinanceUS() {
        const streams = SYMBOLS.map(s => `${s}@aggTrade`).join('/');
        const url = `${BINANCE_US_WS}?streams=${streams}`;

        console.log('[EXCHANGE] Connecting to Binance.US...');
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log(`[EXCHANGE] ✅ Binance.US connected — tracking ${SYMBOLS.map(s => SYMBOL_MAP[s]).join(', ')}`);
            this.connected = true;
            this.retries = 0;
            this._source = 'binance-us';
            this._cleanupInterval = setInterval(() => this._cleanupTicks(), 30000);
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.data) this._handleBinanceTrade(msg.data);
            } catch (e) { /* ignore */ }
        });

        this.ws.on('close', () => {
            this.connected = false;
            this.retries++;
            const delay = Math.min(5000 * this.retries, 30000);
            console.log(`[EXCHANGE] Binance.US disconnected, reconnecting in ${delay / 1000}s...`);
            if (this._cleanupInterval) clearInterval(this._cleanupInterval);
            setTimeout(() => this._connectBinanceUS(), delay);
        });

        this.ws.on('error', (err) => {
            console.error('[EXCHANGE] Binance.US error:', err.message);
        });
    }

    _handleCoinbaseTrade(msg) {
        const ticker = COINBASE_MAP[msg.product_id];
        if (!ticker) return;

        const price = parseFloat(msg.price);
        const ts = new Date(msg.time).getTime() || Date.now();

        const state = this.state[ticker];
        state.price = price;
        state.lastUpdate = ts;
        state.ticks.push({ price, ts });

        this.emit('price', { ticker, price, ts });
    }

    _handleBinanceTrade(data) {
        const sym = data.s?.toLowerCase();
        const ticker = SYMBOL_MAP[sym];
        if (!ticker) return;

        const price = parseFloat(data.p);
        const ts = data.T || Date.now();

        const state = this.state[ticker];
        state.price = price;
        state.lastUpdate = ts;
        state.ticks.push({ price, ts });

        this.emit('price', { ticker, price, ts });
    }

    _cleanupTicks() {
        const cutoff = Date.now() - 20 * 60 * 1000; // Keep 20 minutes
        for (const ticker in this.state) {
            this.state[ticker].ticks = this.state[ticker].ticks.filter(t => t.ts > cutoff);
        }
    }

    /**
     * Get current price for a ticker
     */
    getPrice(ticker) {
        return this.state[ticker]?.price || 0;
    }

    /**
     * Calculate momentum over a time window
     * Returns { changePercent, direction, strength, priceStart, priceEnd, windowMs }
     * 
     * strength: 0-1 normalized (0 = flat, 1 = very strong move)
     * direction: 'up' | 'down' | 'flat'
     */
    getMomentum(ticker, windowMs = 2 * 60 * 1000) {
        const state = this.state[ticker];
        if (!state || state.ticks.length < 2) {
            return { changePercent: 0, direction: 'flat', strength: 0, confidence: 0 };
        }

        const now = Date.now();
        const cutoff = now - windowMs;
        const windowTicks = state.ticks.filter(t => t.ts >= cutoff);

        if (windowTicks.length < 2) {
            return { changePercent: 0, direction: 'flat', strength: 0, confidence: 0 };
        }

        const priceStart = windowTicks[0].price;
        const priceEnd = windowTicks[windowTicks.length - 1].price;
        const changePercent = ((priceEnd - priceStart) / priceStart) * 100;

        // Calculate strength: how consistent is the trend?
        // Count how many ticks are in the same direction
        let upTicks = 0, downTicks = 0;
        for (let i = 1; i < windowTicks.length; i++) {
            if (windowTicks[i].price > windowTicks[i - 1].price) upTicks++;
            else if (windowTicks[i].price < windowTicks[i - 1].price) downTicks++;
        }
        const totalMoves = upTicks + downTicks;
        const consistency = totalMoves > 0
            ? Math.abs(upTicks - downTicks) / totalMoves
            : 0;

        // Strength combines magnitude + consistency
        const magnitude = Math.min(Math.abs(changePercent) / 0.5, 1); // 0.5% = max magnitude
        const strength = (magnitude * 0.6) + (consistency * 0.4);

        const direction = changePercent > 0.05 ? 'up' : (changePercent < -0.05 ? 'down' : 'flat');

        // Confidence: higher with more data points
        const confidence = Math.min(windowTicks.length / 50, 1);

        return {
            changePercent: parseFloat(changePercent.toFixed(4)),
            direction,
            strength: parseFloat(strength.toFixed(3)),
            consistency: parseFloat(consistency.toFixed(3)),
            confidence: parseFloat(confidence.toFixed(3)),
            priceStart,
            priceEnd,
            tickCount: windowTicks.length,
            windowMs,
        };
    }

    /**
     * Get a snapshot of all tickers
     */
    getSnapshot() {
        const snapshot = {};
        for (const ticker in this.state) {
            snapshot[ticker] = {
                price: this.state[ticker].price,
                momentum1m: this.getMomentum(ticker, 60 * 1000),
                momentum2m: this.getMomentum(ticker, 2 * 60 * 1000),
                momentum5m: this.getMomentum(ticker, 5 * 60 * 1000),
                momentum15m: this.getMomentum(ticker, 15 * 60 * 1000),
                lastUpdate: this.state[ticker].lastUpdate,
                tickCount: this.state[ticker].ticks.length,
            };
        }
        return snapshot;
    }

    stop() {
        if (this.ws) this.ws.close();
        if (this._cleanupInterval) clearInterval(this._cleanupInterval);
        console.log('[BINANCE] Stopped');
    }
}

export default BinanceFeed;
