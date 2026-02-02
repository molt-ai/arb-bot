/**
 * Chainlink Price Feed — Polymarket Settlement Price Tracker
 * 
 * Tracks the SAME BTC/USD price that Polymarket uses for settlement
 * (Chainlink oracle on Polygon). This is different from exchange spot prices.
 * 
 * Primary: Polymarket live WebSocket (`wss://ws-live-data.polymarket.com`)
 *   - Subscribes to `crypto_prices_chainlink` topic
 *   - Receives real-time Chainlink oracle updates as shown on the Polymarket UI
 * 
 * Fallback: Polygon RPC HTTP (Chainlink aggregator contract on-chain)
 *   - Calls `latestRoundData()` on the Chainlink BTC/USD aggregator
 *   - Address: 0xc907E116054Ad103354f2D350FD2514433D57F6f (Polygon mainnet)
 * 
 * Inspired by https://github.com/FrondEnt/PolymarketBTC15mAssistant
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

const POLYMARKET_LIVE_WS = 'wss://ws-live-data.polymarket.com';
const CHAINLINK_BTC_USD_AGGREGATOR = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const POLYGON_RPC_URLS = [
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.llamarpc.com',
];

// Chainlink aggregator ABI (minimal — just what we need)
// latestRoundData() returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
// decimals() returns (uint8)
const LATEST_ROUND_DATA_SIG = '0xfeaf968c';  // keccak256("latestRoundData()")[:4]
const DECIMALS_SIG = '0x313ce567';             // keccak256("decimals()")[:4]

const RPC_TIMEOUT_MS = 3000;
const RPC_POLL_INTERVAL_MS = 15000;  // Poll on-chain every 15s when WS is down
const DIVERGENCE_ALERT_PCT = 0.1;    // 0.1% = alert threshold

export class ChainlinkFeed extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.connected = false;
        this._closed = false;
        this._reconnectMs = 500;
        this._rpcPollInterval = null;
        this._cachedDecimals = null;
        this._preferredRpcIndex = 0;

        // Price state per ticker (currently BTC, extensible)
        this.prices = {
            BTC: { price: null, updatedAt: null, source: null },
        };

        // Divergence tracking
        this._lastDivergenceAlert = {};
    }

    /**
     * Start the Chainlink feed — WebSocket primary, RPC fallback
     */
    connect() {
        console.log('[CHAINLINK] Starting Polymarket Chainlink price feed...');
        this._closed = false;
        this._connectWs();
        // Start RPC polling as backup (runs alongside WS, but WS takes priority)
        this._startRpcPolling();
    }

    /**
     * Get the current Chainlink price for a ticker
     * @param {string} ticker - 'BTC' (others can be added later)
     * @returns {{ price: number|null, updatedAt: number|null, source: string|null }}
     */
    getPrice(ticker = 'BTC') {
        return this.prices[ticker] || { price: null, updatedAt: null, source: null };
    }

    /**
     * Calculate divergence between Chainlink price and an exchange price
     * @param {string} ticker - 'BTC'
     * @param {number} exchangePrice - Current exchange (Binance/Coinbase) price
     * @returns {{ divergenceUsd: number|null, divergencePct: number|null, chainlinkPrice: number|null }}
     */
    getDivergence(ticker = 'BTC', exchangePrice) {
        const cl = this.prices[ticker];
        if (!cl?.price || !exchangePrice || exchangePrice <= 0) {
            return { divergenceUsd: null, divergencePct: null, chainlinkPrice: null };
        }

        const divergenceUsd = exchangePrice - cl.price;
        const divergencePct = (divergenceUsd / cl.price) * 100;

        return {
            divergenceUsd: parseFloat(divergenceUsd.toFixed(2)),
            divergencePct: parseFloat(divergencePct.toFixed(4)),
            chainlinkPrice: cl.price,
        };
    }

    /**
     * Stop all connections and cleanup
     */
    stop() {
        this._closed = true;
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }
        if (this._rpcPollInterval) {
            clearInterval(this._rpcPollInterval);
            this._rpcPollInterval = null;
        }
        this.connected = false;
        console.log('[CHAINLINK] Stopped');
    }

    // ── Polymarket Live WebSocket ───────────────────────────

    _connectWs() {
        if (this._closed) return;

        this.ws = new WebSocket(POLYMARKET_LIVE_WS, {
            handshakeTimeout: 10_000,
        });

        this.ws.on('open', () => {
            console.log('[CHAINLINK] ✅ Connected to Polymarket live WS');
            this.connected = true;
            this._reconnectMs = 500;

            // Subscribe to Chainlink price topic
            try {
                this.ws.send(JSON.stringify({
                    action: 'subscribe',
                    subscriptions: [{
                        topic: 'crypto_prices_chainlink',
                        type: '*',
                        filters: '',
                    }],
                }));
            } catch (e) {
                this._scheduleReconnect();
            }
        });

        this.ws.on('message', (buf) => {
            try {
                const raw = typeof buf === 'string' ? buf : buf.toString();
                if (!raw || !raw.trim()) return;

                const data = JSON.parse(raw);
                if (!data || data.topic !== 'crypto_prices_chainlink') return;

                this._handleChainlinkMessage(data);
            } catch (e) { /* ignore parse errors */ }
        });

        this.ws.on('close', () => {
            this.connected = false;
            this._scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            if (!this._wsErrorLogged) {
                console.error('[CHAINLINK] WS error:', err.message);
                this._wsErrorLogged = true;
                setTimeout(() => { this._wsErrorLogged = false; }, 30000);
            }
        });
    }

    _scheduleReconnect() {
        if (this._closed) return;
        try { this.ws?.terminate(); } catch (e) { /* ignore */ }
        this.ws = null;

        const wait = this._reconnectMs;
        this._reconnectMs = Math.min(10000, Math.floor(this._reconnectMs * 1.5));
        setTimeout(() => this._connectWs(), wait);
    }

    /**
     * Parse Chainlink price from Polymarket WS payload
     * The reference implementation checks: value, price, current, data
     * Symbol field can be: symbol, pair, ticker
     */
    _handleChainlinkMessage(data) {
        let payload = data.payload;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) { return; }
        }
        if (!payload || typeof payload !== 'object') return;

        // Identify the asset
        const symbol = String(payload.symbol || payload.pair || payload.ticker || '').toLowerCase();

        // Map symbol to our ticker
        let ticker = null;
        if (symbol.includes('btc')) ticker = 'BTC';
        else if (symbol.includes('eth')) ticker = 'ETH';
        else if (symbol.includes('sol')) ticker = 'SOL';
        else return;  // Unknown symbol, skip

        // Extract price — try multiple field names
        const rawPrice = payload.value ?? payload.price ?? payload.current ?? payload.data;
        const price = typeof rawPrice === 'string' ? Number(rawPrice) : typeof rawPrice === 'number' ? rawPrice : NaN;
        if (!Number.isFinite(price) || price <= 0) return;

        // Extract timestamp
        const rawTs = payload.timestamp ?? payload.updatedAt;
        const updatedAt = rawTs ? (Number(rawTs) > 1e12 ? Number(rawTs) : Number(rawTs) * 1000) : Date.now();

        // Update state
        this.prices[ticker] = {
            price,
            updatedAt: Math.floor(updatedAt),
            source: 'polymarket_ws',
        };

        this.emit('price', { ticker, price, updatedAt, source: 'polymarket_ws' });
    }

    // ── Polygon RPC Fallback (On-Chain Chainlink) ───────────

    _startRpcPolling() {
        if (this._rpcPollInterval) return;
        this._rpcPollInterval = setInterval(() => this._pollChainlinkRpc(), RPC_POLL_INTERVAL_MS);
        // Also do an immediate fetch
        this._pollChainlinkRpc();
    }

    async _pollChainlinkRpc() {
        // Only use RPC if WS hasn't updated in 30s
        const btc = this.prices.BTC;
        if (btc?.source === 'polymarket_ws' && btc.updatedAt && (Date.now() - btc.updatedAt) < 30000) {
            return;  // WS is fresh, no need for RPC
        }

        try {
            const result = await this._fetchChainlinkOnChain();
            if (result && result.price) {
                this.prices.BTC = {
                    price: result.price,
                    updatedAt: result.updatedAt || Date.now(),
                    source: 'polygon_rpc',
                };
                this.emit('price', { ticker: 'BTC', ...this.prices.BTC });
            }
        } catch (e) {
            // RPC errors are non-critical — we have WS as primary
        }
    }

    /**
     * Call Chainlink aggregator on Polygon via JSON-RPC
     * No ethers.js dependency — raw hex encoding/decoding
     */
    async _fetchChainlinkOnChain() {
        // Try each RPC URL in order, preferring the last one that worked
        const rpcs = [...POLYGON_RPC_URLS];
        // Put preferred first
        if (this._preferredRpcIndex > 0 && this._preferredRpcIndex < rpcs.length) {
            const pref = rpcs.splice(this._preferredRpcIndex, 1)[0];
            rpcs.unshift(pref);
        }

        for (let i = 0; i < rpcs.length; i++) {
            const rpcUrl = rpcs[i];
            try {
                // Get decimals if not cached
                if (this._cachedDecimals === null) {
                    const decResult = await this._ethCall(rpcUrl, CHAINLINK_BTC_USD_AGGREGATOR, DECIMALS_SIG);
                    this._cachedDecimals = parseInt(decResult, 16);
                    if (!Number.isFinite(this._cachedDecimals)) {
                        this._cachedDecimals = 8;  // Default for BTC/USD
                    }
                }

                // Call latestRoundData()
                const result = await this._ethCall(rpcUrl, CHAINLINK_BTC_USD_AGGREGATOR, LATEST_ROUND_DATA_SIG);

                // Parse response — latestRoundData returns 5 × 32-byte values
                // [0] roundId (uint80), [1] answer (int256), [2] startedAt, [3] updatedAt, [4] answeredInRound
                // Each is 64 hex chars (32 bytes)
                const hex = result.startsWith('0x') ? result.slice(2) : result;
                if (hex.length < 320) return null;  // 5 × 64 = 320 hex chars minimum

                const answerHex = hex.slice(64, 128);
                const updatedAtHex = hex.slice(192, 256);

                // Parse answer as signed int256
                const answer = this._hexToSignedBigInt(answerHex);
                const scale = 10 ** this._cachedDecimals;
                const price = Number(answer) / scale;

                // Parse updatedAt as uint256 (seconds)
                const updatedAtSec = parseInt(updatedAtHex, 16);
                const updatedAt = updatedAtSec * 1000;

                if (!Number.isFinite(price) || price <= 0) continue;

                this._preferredRpcIndex = POLYGON_RPC_URLS.indexOf(rpcUrl);
                return { price, updatedAt };
            } catch (e) {
                this._cachedDecimals = null;  // Reset on error
                continue;
            }
        }
        return null;
    }

    /**
     * Raw JSON-RPC eth_call
     */
    async _ethCall(rpcUrl, to, data) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

        try {
            const res = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_call',
                    params: [{ to, data }, 'latest'],
                }),
                signal: controller.signal,
            });

            if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
            const json = await res.json();
            if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
            return json.result;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Parse a 64-char hex string as a signed int256
     */
    _hexToSignedBigInt(hex) {
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        const x = BigInt('0x' + clean);
        const TWO_255 = 1n << 255n;
        const TWO_256 = 1n << 256n;
        return x >= TWO_255 ? x - TWO_256 : x;
    }

    /**
     * Check divergence and log alerts when significant
     * Called externally by live.js during tick
     * @param {string} ticker
     * @param {number} exchangePrice
     */
    checkDivergence(ticker, exchangePrice) {
        const div = this.getDivergence(ticker, exchangePrice);
        if (div.divergencePct === null) return div;

        const absPct = Math.abs(div.divergencePct);
        if (absPct > DIVERGENCE_ALERT_PCT) {
            const lastAlert = this._lastDivergenceAlert[ticker] || 0;
            if (Date.now() - lastAlert > 60000) {  // Max 1 alert per minute per ticker
                console.log(`⚠️  [CHAINLINK] ${ticker} divergence: Chainlink $${div.chainlinkPrice?.toFixed(2)} vs Exchange $${exchangePrice.toFixed(2)} (${div.divergencePct > 0 ? '+' : ''}${div.divergencePct.toFixed(3)}%)`);
                this._lastDivergenceAlert[ticker] = Date.now();
                this.emit('divergence', { ticker, ...div });
            }
        }

        return div;
    }

    /**
     * Get full state snapshot for dashboard/API
     */
    getSnapshot() {
        return {
            connected: this.connected,
            prices: { ...this.prices },
        };
    }
}

export default ChainlinkFeed;
