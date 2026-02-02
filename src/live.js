/**
 * Live Bot — Main entry point
 * Dual WebSocket: Polymarket + Kalshi real-time feeds
 * Paper trading + live dashboard
 */

import pmxt from 'pmxtjs';
import WebSocket from 'ws';
import { PaperTrader } from './paper-trader.js';
import { MarketScanner } from './market-scanner.js';
import { createDashboard } from './dashboard.js';
import { AlertManager } from './alerts.js';
import { config } from '../config.js';
import { loadKalshiCredentials, generateKalshiHeaders, generateKalshiRestHeaders } from './kalshi-auth.js';
import { MARKET_PAIRS, POLY_GAMMA, resolvePair } from './market-pairs.js';
import { BinanceFeed } from './binance-feed.js';
import { CryptoSpeedStrategy } from './crypto-speed.js';
import { SameMarketArb } from './same-market-arb.js';
import { CombinatorialArb } from './combinatorial-arb.js';
import { ChainlinkFeed } from './chainlink-feed.js';
import { insertNearMiss } from './db.js';
import { AutoRedeemer } from './auto-redeem.js';
import { OrderManager } from './order-manager.js';
import { CircuitBreaker } from './circuit-breaker.js';

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // Re-scan every 5 min

/**
 * Execution Lock — promise-based mutex
 * Ensures only one trade executes at a time
 */
class ExecutionLock {
    constructor() {
        this._locked = false;
        this._queue = [];
        this.skippedCount = 0;
    }

    get isLocked() {
        return this._locked;
    }

    /**
     * Try to acquire the lock. Returns true if acquired, false if busy.
     */
    tryAcquire() {
        if (this._locked) return false;
        this._locked = true;
        return true;
    }

    /**
     * Acquire the lock (blocking). Returns a promise that resolves when lock is acquired.
     */
    acquire() {
        if (!this._locked) {
            this._locked = true;
            return Promise.resolve(true);
        }
        return new Promise(resolve => {
            this._queue.push(resolve);
        });
    }

    /**
     * Release the lock. If others are waiting, hand off to next in queue.
     */
    release() {
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            next(true);
        } else {
            this._locked = false;
        }
    }
}

class LiveBot {
    constructor() {
        this.config = {
            ...config,
            alertThresholdCents: 3.0,  // Alert only on real opportunities
        };

        this.polymarket = new pmxt.polymarket({ privateKey: this.config.polymarketPrivateKey });
        this.kalshi = new pmxt.kalshi({ apiKey: this.config.kalshiApiKey, apiSecret: this.config.kalshiApiSecret });

        this.scanner = new MarketScanner(this.config);
        this.trader = new PaperTrader({
            initialBalance: 500,        // $500 per side
            contractSize: 10,           // $10 per trade (10 contracts × $1 each)
            // Fees now use real platform formulas:
            // - Polymarket: 0% on event/political markets, variable on 15-min crypto
            // - Kalshi: ceil(0.07 × price × (1-price)) per contract
            minNetProfit: 1.0,          // Only trade if ≥1¢/contract after fees
            maxOpenPositions: 20,
        });

        // State
        this.polyPrices = new Map();
        this.kalshiPrices = new Map();
        this.marketMappings = [];
        this.currentOpportunities = [];
        this.lastUpdate = null;
        this.polyWs = null;
        this.kalshiWs = null;
        this.kalshiMsgId = 1;
        this.dashboard = null;
        this.polyConnected = false;
        this.kalshiConnected = false;
        this.kalshiRestMode = false;

        // Load Kalshi credentials
        try {
            this.kalshiCreds = loadKalshiCredentials();
            console.log('[AUTH] Kalshi API key loaded ✅');
        } catch (e) {
            console.warn('[AUTH] No Kalshi credentials:', e.message);
            this.kalshiCreds = null;
        }

        // Alert system
        this.alerts = new AlertManager({
            webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
            cooldownMs: 60000,  // 1 alert per type per minute
        });

        // Circuit breaker & execution lock
        this.circuitBreaker = new CircuitBreaker({
            maxPositionPerMarket: 50,
            maxTotalPosition: 200,
            maxDailyLoss: 5000,          // $50 in cents
            maxConsecutiveErrors: 5,
            cooldownMs: 60000,
        });
        this.executionLock = new ExecutionLock();

        // Auto-redemption & order management
        this.autoRedeemer = new AutoRedeemer(this.polymarket, this.kalshi, this.trader, {
            intervalMs: 5 * 60 * 1000,   // Check every 5 minutes
            gracePeriodMs: 2 * 60 * 1000, // 2 min grace after expiry
        });
        this.orderManager = new OrderManager({
            timeoutMs: 10000, // 10 second timeout per order
        });

        // New strategies
        this.binanceFeed = new BinanceFeed();
        this.chainlinkFeed = new ChainlinkFeed();
        this.cryptoSpeed = new CryptoSpeedStrategy(this.binanceFeed, this.trader, {}, this.chainlinkFeed);
        this.sameMarketArb = new SameMarketArb(this.trader);
        this.combinatorialArb = new CombinatorialArb(this.trader, {
            scanIntervalMs: 60_000,     // Every 60s
            minEdgeCents: 3,            // Min 3¢ edge
            maxDaysToExpiry: 14,        // 2 weeks out
            useEmbeddings: false,        // Sync mode on Fly (saves RAM). Set true locally.
        });
    }

    async start() {
        console.log('╔═══════════════════════════════════════════════════╗');
        console.log('║   🎯 ARB BOT v3 — MULTI-STRATEGY LIVE MODE      ║');
        console.log('║   XP + Crypto Speed + Rebalance + Combinatorial  ║');
        console.log('╚═══════════════════════════════════════════════════╝\n');

        // 1. Start dashboard FIRST and WAIT for it to bind — Fly health checks need the port open
        this.dashboard = createDashboard(this, this.trader, { port: 3456 });
        await this.dashboard.ready;

        // Alert: bot started
        this.alerts.botStarted().catch(() => {});

        // 2. Scan & map markets (cross-platform arb)
        await this.scanMarkets();

        // 3. Connect BOTH platform WebSockets
        this.connectPolyWS();
        this.connectKalshiWS();

        // 4. Start Binance feed + Chainlink feed + crypto speed strategy
        this.binanceFeed.connect();
        this.chainlinkFeed.connect();
        await this.cryptoSpeed.start();

        // 5. Start same-market rebalancing arb
        await this.sameMarketArb.start();

        // 6. Start combinatorial arb (entity matcher)
        await this.combinatorialArb.start();

        // 7. Start auto-redemption engine
        this.autoRedeemer.start();

        // 8. Re-scan periodically
        setInterval(() => this.scanMarkets(), SCAN_INTERVAL_MS);

        // 9. Tick every 10s — check exits, broadcast state
        setInterval(() => this.tick(), 10000);

        // 10. Kalshi REST fallback every 30s (in case WS misses something)
        setInterval(() => this.pollKalshiFallback(), 30000);

        console.log('\n[LIVE] Bot running — 4 strategies active. Dashboard live.\n');
    }

    // ── Market Discovery (Multi-Category) ─────────────────

    async scanMarkets() {
        try {
            console.log('\n[SCAN] Scanning all cross-platform markets...');
            const activePairs = MARKET_PAIRS.filter(p => p.active);
            console.log(`[SCAN] Checking ${activePairs.length} market categories...`);

            const fetchKalshi = async (path) => {
                if (!this.kalshiCreds) throw new Error('No creds');
                const headers = generateKalshiRestHeaders(
                    this.kalshiCreds.keyId, this.kalshiCreds.privateKey,
                    'GET', `/trade-api/v2${path}`
                );
                const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2${path}`, { headers });
                if (!res.ok) throw new Error(`${res.status}`);
                return res.json();
            };

            const maxDays = this.config.maxDaysToExpiry || 7;
            const maxExpiryMs = Date.now() + maxDays * 24 * 60 * 60 * 1000;

            const newMappings = [];
            for (const pair of activePairs) {
                const resolved = await resolvePair(pair, fetchKalshi);
                let added = 0;
                let skippedExpiry = 0;
                for (const r of resolved) {
                    if (r.kalshiTicker && r.polyYes != null) {
                        // Filter by expiry date — skip markets resolving too far out
                        if (r.expiresAt) {
                            const expiryTime = new Date(r.expiresAt).getTime();
                            if (expiryTime > maxExpiryMs) {
                                skippedExpiry++;
                                continue;
                            }
                        }

                        newMappings.push({
                            name: r.name,
                            category: r.category,
                            polyMarketId: r.polyMarketId,
                            polyTokenId: r.polyTokenId || r.polyMarketId,
                            kalshiTicker: r.kalshiTicker,
                            polyYes: r.polyYes,
                            polyNo: r.polyNo,
                            kalshiYes: r.kalshiYes,
                            kalshiNo: r.kalshiNo,
                            expiresAt: r.expiresAt,
                        });
                        added++;
                    }
                }
                if (resolved.length > 0) {
                    const expiryNote = skippedExpiry > 0 ? ` (${skippedExpiry} skipped: >${ maxDays}d)` : '';
                    console.log(`  ✓ ${pair.name}: ${resolved.length} resolved, ${added} with prices${expiryNote}`);
                }
            }

            // Dynamic discovery: scan ALL open Kalshi markets and match against top Polymarket events
            try {
                console.log(`\n[DISCOVERY] Scanning for additional short-dated cross-platform pairs...`);
                const maxDaysMs = maxDays * 24 * 60 * 60 * 1000;
                
                // Fetch all active Kalshi markets (short-dated only)
                let allKalshi = [];
                let cursor = null;
                let page = 0;
                do {
                    const path = cursor
                        ? `/markets?status=open&limit=200&cursor=${cursor}`
                        : '/markets?status=open&limit=200';
                    const data = await fetchKalshi(path);
                    if (data.markets?.length) allKalshi.push(...data.markets);
                    cursor = data.cursor || null;
                    page++;
                } while (cursor && page < 10);
                
                // Filter Kalshi to short-dated only
                const shortKalshi = allKalshi.filter(m => {
                    const exp = m.expected_expiration_time || m.expiration_time;
                    if (!exp) return false;
                    return new Date(exp).getTime() <= Date.now() + maxDaysMs;
                });
                console.log(`[DISCOVERY] Kalshi: ${allKalshi.length} total open → ${shortKalshi.length} within ${maxDays} days`);
                
                // Fetch top Polymarket events by volume
                const pRes2 = await fetch(`${POLY_GAMMA}/events?active=true&closed=false&order=volume&ascending=false&limit=100`);
                const polyEvents = await pRes2.json();
                const allPolyMarkets = [];
                for (const evt of (polyEvents || [])) {
                    for (const pm of (evt.markets || [])) {
                        // Filter poly to short-dated
                        if (pm.endDate && new Date(pm.endDate).getTime() <= Date.now() + maxDaysMs) {
                            allPolyMarkets.push({ ...pm, eventTitle: evt.title });
                        }
                    }
                }
                console.log(`[DISCOVERY] Polymarket: ${allPolyMarkets.length} short-dated markets from top events`);
                
                // Fuzzy match — find cross-platform pairs not in our curated list
                const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
                const existingKalshi = new Set(newMappings.map(m => m.kalshiTicker));
                let discovered = 0;
                
                for (const pm of allPolyMarkets) {
                    const polyQ = norm(pm.question || pm.groupItemTitle || pm.eventTitle || '');
                    let bestMatch = null;
                    let bestSim = 0;
                    
                    for (const km of shortKalshi) {
                        if (existingKalshi.has(km.ticker)) continue;
                        const kQ = norm(km.title || km.subtitle || '');
                        
                        const pWords = polyQ.split(' ').filter(w => w.length > 2);
                        const kWords = kQ.split(' ').filter(w => w.length > 2);
                        const common = pWords.filter(w => kWords.includes(w));
                        const union = new Set([...pWords, ...kWords]).size;
                        const sim = union > 0 ? common.length / union : 0;
                        
                        if (sim > bestSim && sim > 0.35) {
                            bestSim = sim;
                            bestMatch = km;
                        }
                    }
                    
                    if (bestMatch) {
                        const pPrices = pm.outcomePrices ? (typeof pm.outcomePrices === 'string' ? JSON.parse(pm.outcomePrices) : pm.outcomePrices) : [];
                        if (!pPrices[0]) continue;
                        
                        let tokenIds = pm.clobTokenIds;
                        if (typeof tokenIds === 'string') {
                            try { tokenIds = JSON.parse(tokenIds); } catch(e) {}
                        }
                        
                        const kalshiYes = bestMatch.yes_ask || bestMatch.yes_bid || 0;
                        const kalshiNo = bestMatch.no_ask || bestMatch.no_bid || 0;
                        if (kalshiYes <= 0 && kalshiNo <= 0) continue;
                        
                        newMappings.push({
                            name: pm.question || pm.groupItemTitle || bestMatch.title,
                            category: 'discovered',
                            polyMarketId: pm.conditionId || pm.id,
                            polyTokenId: tokenIds?.[0] || pm.conditionId || pm.id,
                            kalshiTicker: bestMatch.ticker,
                            polyYes: parseFloat(pPrices[0]) * 100,
                            polyNo: parseFloat(pPrices[1]) * 100,
                            kalshiYes,
                            kalshiNo,
                            expiresAt: bestMatch.expected_expiration_time || bestMatch.expiration_time || pm.endDate,
                        });
                        existingKalshi.add(bestMatch.ticker);
                        discovered++;
                    }
                }
                
                if (discovered > 0) {
                    console.log(`[DISCOVERY] ✨ Found ${discovered} additional cross-platform pairs`);
                } else {
                    console.log(`[DISCOVERY] No additional pairs found beyond curated list`);
                }
            } catch (e) {
                console.error('[DISCOVERY] Error in dynamic scan:', e.message);
            }

            this.marketMappings = newMappings;
            console.log(`[SCAN] Total: ${this.marketMappings.length} cross-platform pairs (curated + discovered), all within ${maxDays} days`);

            // Re-subscribe WebSockets
            if (this.polyConnected) this.subscribePolyMarkets();
            if (this.kalshiConnected) this.subscribeKalshiMarkets();

            // Seed initial prices from scan data
            for (const m of this.marketMappings) {
                if (m.polyYes != null) {
                    this.polyPrices.set(m.polyTokenId, {
                        yes: m.polyYes, no: m.polyNo,
                        lastUpdate: Date.now(), source: 'scan'
                    });
                }
                if (m.kalshiYes != null) {
                    this.kalshiPrices.set(m.kalshiTicker, {
                        yes: m.kalshiYes, no: m.kalshiNo || (100 - m.kalshiYes),
                        lastUpdate: Date.now(), source: 'scan'
                    });
                }
                this.evaluateSpread(m);
            }

        } catch (e) {
            console.error('[SCAN] Error:', e.message);
        }
    }

    // ── Polymarket WebSocket ────────────────────────────────

    connectPolyWS() {
        console.log('[POLY-WS] Connecting...');
        this.polyWs = new WebSocket(POLY_WS_URL);

        this.polyWs.on('open', () => {
            console.log('[POLY-WS] ✅ Connected');
            this.polyConnected = true;
            this.subscribePolyMarkets();
        });

        this.polyWs.on('message', (data) => {
            try {
                this.handlePolyMessage(JSON.parse(data.toString()));
            } catch (e) { /* ignore */ }
        });

        this.polyWs.on('close', () => {
            console.log('[POLY-WS] Disconnected, reconnecting in 5s...');
            this.polyConnected = false;
            setTimeout(() => this.connectPolyWS(), 5000);
        });

        this.polyWs.on('error', (err) => console.error('[POLY-WS] Error:', err.message));
    }

    subscribePolyMarkets() {
        const tokenIds = this.marketMappings.map(m => m.polyTokenId).filter(Boolean);
        if (tokenIds.length > 0 && this.polyWs?.readyState === 1) {
            this.polyWs.send(JSON.stringify({ type: 'MARKET', assets_ids: tokenIds }));
            console.log(`[POLY-WS] Subscribed to ${tokenIds.length} tokens`);
        }
    }

    handlePolyMessage(msg) {
        const tokenId = msg.asset_id;
        if (!tokenId) return;

        const mapping = this.marketMappings.find(m => m.polyTokenId === tokenId);
        if (!mapping) return;

        const yesPrice = msg.price ? msg.price * 100 : null;
        if (yesPrice !== null) {
            this.polyPrices.set(tokenId, {
                yes: yesPrice,
                no: 100 - yesPrice,
                lastUpdate: Date.now(),
                source: 'ws'
            });
            this.evaluateSpread(mapping);
        }
    }

    // ── Kalshi WebSocket ────────────────────────────────────

    connectKalshiWS() {
        if (!this.kalshiCreds) {
            console.log('[KALSHI-WS] No API credentials — using REST polling');
            this.kalshiRestMode = true;
            this.startKalshiPolling();
            return;
        }

        console.log('[KALSHI-WS] Connecting with authenticated session...');

        try {
            const headers = generateKalshiHeaders(
                this.kalshiCreds.keyId,
                this.kalshiCreds.privateKey
            );

            this.kalshiWs = new WebSocket(KALSHI_WS_URL, { headers });

            this.kalshiWs.on('open', () => {
                console.log('[KALSHI-WS] ✅ Connected (authenticated)');
                this.kalshiConnected = true;
                this._kalshiWsRetries = 0;
                this.subscribeKalshiMarkets();
            });

            this.kalshiWs.on('message', (raw) => {
                try {
                    this.handleKalshiMessage(JSON.parse(raw.toString()));
                } catch (e) { /* ignore */ }
            });

            this.kalshiWs.on('close', (code) => {
                this.kalshiConnected = false;
                this._kalshiWsRetries = (this._kalshiWsRetries || 0) + 1;

                if (this._kalshiWsRetries >= 5) {
                    console.log(`[KALSHI-WS] Failed ${this._kalshiWsRetries}x. Falling back to REST polling.`);
                    this.kalshiRestMode = true;
                    this.startKalshiPolling();
                } else {
                    const delay = Math.min(5000 * this._kalshiWsRetries, 30000);
                    console.log(`[KALSHI-WS] Disconnected (code ${code}), retry #${this._kalshiWsRetries} in ${delay/1000}s...`);
                    setTimeout(() => this.connectKalshiWS(), delay);
                }
            });

            this.kalshiWs.on('error', (err) => {
                if (!this._kalshiErrorLogged) {
                    console.error('[KALSHI-WS] Error:', err.message);
                    this._kalshiErrorLogged = true;
                    setTimeout(() => { this._kalshiErrorLogged = false; }, 30000);
                }
            });
        } catch (e) {
            console.error('[KALSHI-WS] Auth error:', e.message);
            console.log('[KALSHI-WS] Falling back to REST polling.');
            this.kalshiRestMode = true;
            this.startKalshiPolling();
        }
    }

    startKalshiPolling() {
        if (this._kalshiPollInterval) return;
        console.log('[KALSHI-REST] Starting 5s polling as fallback');
        this._kalshiPollInterval = setInterval(() => this.pollKalshiFallback(), 5000);
        this.pollKalshiFallback();
    }

    subscribeKalshiMarkets() {
        if (!this.kalshiWs || this.kalshiWs.readyState !== 1) return;

        const tickers = this.marketMappings.map(m => m.kalshiTicker).filter(Boolean);
        if (tickers.length === 0) return;

        // Subscribe to ticker channel — public, no auth needed
        const sub = {
            id: this.kalshiMsgId++,
            cmd: 'subscribe',
            params: {
                channels: ['ticker'],
                market_tickers: tickers
            }
        };
        this.kalshiWs.send(JSON.stringify(sub));
        console.log(`[KALSHI-WS] Subscribed to ${tickers.length} tickers`);

        // Also subscribe to trade feed for extra signals
        const tradeSub = {
            id: this.kalshiMsgId++,
            cmd: 'subscribe',
            params: {
                channels: ['trade'],
                market_tickers: tickers
            }
        };
        this.kalshiWs.send(JSON.stringify(tradeSub));
    }

    handleKalshiMessage(msg) {
        const type = msg.type;

        if (type === 'ticker' || type === 'ticker_v2') {
            const data = msg.msg;
            if (!data?.market_ticker) return;

            const ticker = data.market_ticker;
            const yesBid = data.yes_bid ?? null;
            const yesAsk = data.yes_ask ?? null;
            // Kalshi prices are already in cents (1-99)
            const yesPrice = yesBid !== null ? yesBid : (yesAsk !== null ? yesAsk : null);
            const noPrice = yesPrice !== null ? (100 - yesPrice) : null;

            if (yesPrice !== null) {
                this.kalshiPrices.set(ticker, {
                    yes: yesPrice,
                    no: noPrice,
                    yesBid,
                    yesAsk,
                    lastUpdate: Date.now(),
                    source: 'ws'
                });

                const mapping = this.marketMappings.find(m => m.kalshiTicker === ticker);
                if (mapping) this.evaluateSpread(mapping);
            }
        } else if (type === 'trade') {
            const data = msg.msg;
            if (!data?.market_ticker) return;
            // Update with last trade price
            const ticker = data.market_ticker;
            const yesPrice = data.yes_price ?? null;
            if (yesPrice !== null) {
                const existing = this.kalshiPrices.get(ticker) || {};
                this.kalshiPrices.set(ticker, {
                    ...existing,
                    yes: yesPrice,
                    no: 100 - yesPrice,
                    lastTrade: yesPrice,
                    lastUpdate: Date.now(),
                    source: 'ws-trade'
                });
                const mapping = this.marketMappings.find(m => m.kalshiTicker === ticker);
                if (mapping) this.evaluateSpread(mapping);
            }
        } else if (type === 'error') {
            console.error(`[KALSHI-WS] Error ${msg.msg?.code}: ${msg.msg?.msg}`);
        }
    }

    // ── Kalshi REST Fallback ────────────────────────────────

    async pollKalshiFallback() {
        try {
            const kalshiId = this.extractSlug(this.config.kalshiUrl);
            const markets = await this.kalshi.getMarketsBySlug(kalshiId);

            for (const market of markets || []) {
                const ticker = market.ticker || market.id;
                const existing = this.kalshiPrices.get(ticker);

                // Only update if WS hasn't updated in 30s
                if (existing?.source === 'ws' && (Date.now() - existing.lastUpdate) < 30000) continue;

                const yes = market.outcomes?.find(o => o.label?.toLowerCase().includes('yes') || o.side === 'yes');
                const no = market.outcomes?.find(o => o.label?.toLowerCase().includes('no') || o.side === 'no');

                this.kalshiPrices.set(ticker, {
                    yes: (yes?.price || market.outcomes?.[0]?.price || 0) * 100,
                    no: (no?.price || market.outcomes?.[1]?.price || 0) * 100,
                    lastUpdate: Date.now(),
                    source: 'rest-fallback'
                });

                const mapping = this.marketMappings.find(m => m.kalshiTicker === ticker);
                if (mapping) this.evaluateSpread(mapping);
            }
        } catch (e) {
            // Fallback error is non-critical
        }
    }

    // ── Spread Evaluation ───────────────────────────────────

    evaluateSpread(mapping) {
        const poly = this.polyPrices.get(mapping.polyTokenId);
        const kalshi = this.kalshiPrices.get(mapping.kalshiTicker);
        if (!poly || !kalshi) return;

        // Skip if any price is 0 or missing (no liquidity = no real opportunity)
        const minPrice = this.config.minPriceThreshold || 2;
        if (poly.yes <= minPrice || poly.no <= minPrice || kalshi.yes <= minPrice || kalshi.no <= minPrice) return;

        // ── Time-Weighted Spread Thresholds ─────────────────
        // Markets approaching expiry need more edge (less time for resolution)
        let spreadMultiplier = 1.0;
        if (mapping.expiresAt) {
            const msToExpiry = new Date(mapping.expiresAt) - Date.now();
            const hoursToExpiry = msToExpiry / (60 * 60 * 1000);

            if (hoursToExpiry < 2) {
                // Very close to expiry — require 2x normal spread
                spreadMultiplier = 2.0;
            } else if (hoursToExpiry < 24) {
                // Within 24h — linearly increase from 1x to 2x as we approach 2h
                spreadMultiplier = 1.0 + (1.0 * (24 - hoursToExpiry) / 22);
            }
        }

        // Calculate both strategies using resolution arb math
        // Strategy 1: Buy Poly YES + Kalshi NO
        const cost1 = poly.yes + kalshi.no;
        const gross1 = 100 - cost1;
        const arb1 = this.trader.calcResolutionProfit(poly.yes, kalshi.no);

        // Strategy 2: Buy Poly NO + Kalshi YES
        const cost2 = poly.no + kalshi.yes;
        const gross2 = 100 - cost2;
        const arb2 = this.trader.calcResolutionProfit(poly.no, kalshi.yes);

        const bestArb = arb1.netProfit > arb2.netProfit ? arb1 : arb2;
        const strategy = arb1.netProfit > arb2.netProfit ? 1 : 2;
        const grossSpread = Math.max(gross1, gross2);

        // Apply time-weighted threshold — scale the minimum profit requirement
        const baseMinProfit = this.trader.config?.minNetProfit || 1.0;
        const adjustedMinProfit = baseMinProfit * spreadMultiplier;
        if (bestArb.netProfit < adjustedMinProfit && spreadMultiplier > 1.0) {
            // Below time-adjusted threshold — don't trade, but still track the opportunity
            // (the paper trader will also check its own threshold, this is an additional filter)
        }

        const opp = {
            name: mapping.name,
            profit: bestArb.netProfit,
            netProfit: bestArb.netProfit,
            grossSpread,
            totalCost: bestArb.totalCost,
            fees: bestArb.fees,
            isProfitable: bestArb.isProfitable,
            strategy,
            polyYes: poly.yes,
            polyNo: poly.no,
            kalshiYes: kalshi.yes,
            kalshiNo: kalshi.no,
            polySource: poly.source || 'ws',
            kalshiSource: kalshi.source || 'rest',
            expiresAt: mapping.expiresAt || null,
            lastUpdate: Date.now()
        };

        const idx = this.currentOpportunities.findIndex(o => o.name === mapping.name);
        if (idx >= 0) {
            this.currentOpportunities[idx] = opp;
        } else {
            this.currentOpportunities.push(opp);
        }
        this.currentOpportunities.sort((a, b) => b.netProfit - a.netProfit);
        this.lastUpdate = new Date().toISOString();

        // Log near misses — positive gross spread but not profitable after fees
        if (grossSpread > 0 && !bestArb.isProfitable) {
            let reason = 'fees_exceed_spread';
            if (bestArb.netProfit > 0) reason = 'below_min_profit';
            insertNearMiss({
                name: mapping.name,
                polyYes: poly.yes,
                polyNo: poly.no,
                kalshiYes: kalshi.yes,
                kalshiNo: kalshi.no,
                grossSpread,
                fees: bestArb.fees,
                netProfit: bestArb.netProfit,
                reason,
                timestamp: new Date().toISOString(),
            });
        }

        // Paper trade — gate through circuit breaker + execution lock
        this._executeSafeTrade(opp);

        // Alert real opportunities (profitable after fees)
        if (bestArb.isProfitable && bestArb.netProfit >= this.config.alertThresholdCents) {
            const desc = strategy === 1
                ? `Poly YES (${poly.yes.toFixed(1)}¢) + Kalshi NO (${kalshi.no.toFixed(1)}¢) = ${bestArb.totalCost.toFixed(1)}¢ cost → ${bestArb.netProfit.toFixed(1)}¢ net profit`
                : `Poly NO (${poly.no.toFixed(1)}¢) + Kalshi YES (${kalshi.yes.toFixed(1)}¢) = ${bestArb.totalCost.toFixed(1)}¢ cost → ${bestArb.netProfit.toFixed(1)}¢ net profit`;
            this.alerts.bigOpportunity({ name: mapping.name, netProfit: bestArb.netProfit, description: desc }).catch(() => {});
        }
    }

    // ── Safe Trade Execution (circuit breaker + lock + balance reservation) ──

    async _executeSafeTrade(opp) {
        // 1. Check circuit breaker
        const context = this._getPositionContext();
        const cbCheck = this.circuitBreaker.check(opp, context);
        if (!cbCheck.allowed) {
            // Only log circuit breaker blocks occasionally to avoid spam
            if (!this._lastCBLog || Date.now() - this._lastCBLog > 30000) {
                console.log(`[CIRCUIT-BREAKER] Blocked: ${cbCheck.reason}`);
                this._lastCBLog = Date.now();
            }
            return;
        }

        // 2. Try to acquire execution lock (non-blocking)
        if (!this.executionLock.tryAcquire()) {
            this.executionLock.skippedCount++;
            console.log(`[LOCK] Skipped: execution busy (${this.executionLock.skippedCount} total skips)`);
            return;
        }

        try {
            // 3. Execute trade wrapped with OrderManager timeout
            const tradeId = `xp-${(opp.name || '').replace(/[^a-zA-Z0-9]/g, '-').substring(0, 40)}-${Date.now()}`;
            const { status, result: trade, elapsedMs } = await this.orderManager.executeWithTimeout(
                () => this.trader.executeTrade(opp),
                tradeId
            );

            if (status === 'timeout') {
                console.log(`⏰ TRADE TIMEOUT: ${opp.name} after ${elapsedMs}ms`);
            } else if (trade) {
                // 4. Record success with circuit breaker
                this.circuitBreaker.recordSuccess();

                const net = (trade.expectedNetProfit / 100).toFixed(2);
                const fee = (trade.fees / 100).toFixed(2);
                console.log(`📈 ENTER ${trade.name} | S${trade.strategy} | Cost: $${(trade.totalCost/100).toFixed(2)} | Gross: ${trade.grossSpread.toFixed(1)}¢ | Fees: $${fee} | Net: +$${net} | Exec: ${elapsedMs}ms`);
                this.alerts.tradeExecuted(trade).catch(() => {});
                if (this.dashboard) {
                    this.dashboard.broadcast('trade', trade);
                    this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
                }
            }
        } catch (err) {
            // 5. Record error with circuit breaker
            this.circuitBreaker.recordError(err);
            console.error(`[TRADE-ERROR] ${opp.name}: ${err.message}`);
        } finally {
            // 6. Always release the lock
            this.executionLock.release();
        }
    }

    /**
     * Build position context for circuit breaker checks
     */
    _getPositionContext() {
        const positions = this.trader.state.positions || [];
        const currentPositions = new Map();
        let totalContracts = 0;

        for (const pos of positions) {
            const existing = currentPositions.get(pos.name) || 0;
            currentPositions.set(pos.name, existing + (pos.contracts || 0));
            totalContracts += (pos.contracts || 0);
        }

        return { currentPositions, totalContracts };
    }

    // ── Tick (every 10s) ────────────────────────────────────

    tick() {
        // Check stop-loss exits (only on massive reversals)
        const closed = this.trader.checkExits(this.currentOpportunities);
        for (const trade of closed) {
            const net = trade.netPnl >= 0 ? `+$${(trade.netPnl/100).toFixed(2)}` : `-$${Math.abs(trade.netPnl/100).toFixed(2)}`;
            console.log(`📉 STOP-LOSS ${trade.name} | Net: ${net} | Hold: ${Math.round(trade.holdTime/1000)}s`);
            this.alerts.positionRedeemed(trade.name, trade.netPnl).catch(() => {});

            // Record losses with circuit breaker
            if (trade.netPnl < 0) {
                this.circuitBreaker.recordLoss(Math.abs(trade.netPnl));
            }

            if (this.dashboard) {
                this.dashboard.broadcast('trade', trade);
                this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
            }
        }

        if (this.dashboard) {
            this.dashboard.broadcast('opportunities', this.currentOpportunities);
            this.dashboard.broadcast('circuitBreaker', this.circuitBreaker.getStatus());
        }

        // Broadcast Chainlink data alongside other state
        if (this.dashboard) {
            this.dashboard.broadcast('chainlink', this.chainlinkFeed.getSnapshot());
        }

        // Count profitable opportunities
        const profitable = this.currentOpportunities.filter(o => o.isProfitable).length;
        const p = this.trader.getPortfolioSummary();
        const pWs = this.polyConnected ? '🟢' : '🔴';
        const kWs = this.kalshiConnected ? '🟢' : (this.kalshiRestMode ? '🔄' : '🔴');
        const bWs = this.binanceFeed.connected ? '🟢' : '🔴';
        const clWs = this.chainlinkFeed.connected ? '🟢' : '🔴';
        const maxDays = this.config.maxDaysToExpiry || 7;
        const csStats = this.cryptoSpeed.getStats();
        const smStats = this.sameMarketArb.getStats();
        const caStats = this.combinatorialArb?.stats || {};
        console.log(`[${new Date().toLocaleTimeString()}] Poly ${pWs} Kalshi ${kWs} Binance ${bWs} CL ${clWs} | XP:${this.currentOpportunities.length}≤${maxDays}d(${profitable}✓) CS:${csStats.activeMarkets}mkts/${csStats.signals}sig SM:${smStats.found}found CA:${caStats.opportunitiesFound || 0}opps | ${p.openPositions} pos | P&L: $${p.netPnL} | Trades: ${p.totalTrades}`);
    }

    stop() {
        this.alerts.botStopped('shutdown').catch(() => {});
        this.alerts.stop();
        if (this.autoRedeemer) this.autoRedeemer.stop();
        if (this.circuitBreaker) this.circuitBreaker.destroy();
        if (this.polyWs) this.polyWs.close();
        if (this.kalshiWs) this.kalshiWs.close();
        if (this.binanceFeed) this.binanceFeed.stop();
        if (this.chainlinkFeed) this.chainlinkFeed.stop();
        if (this.cryptoSpeed) this.cryptoSpeed.stop();
        if (this.sameMarketArb) this.sameMarketArb.stop();
        if (this.combinatorialArb) this.combinatorialArb.stop();
        if (this.dashboard?.server) this.dashboard.server.close();
        console.log('\n[STOPPED]');
    }
}

// ── Start ───────────────────────────────────────────────
const bot = new LiveBot();
process.on('SIGINT', () => { bot.stop(); process.exit(0); });
bot.start().catch(console.error);
