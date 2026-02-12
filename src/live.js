/**
 * Live Bot — Main entry point
 * 
 * DEFAULT STRATEGY:
 * 1. Cross-Platform Arb: Buy YES on Polymarket + NO on Kalshi (or vice versa)
 *    for the SAME event. Guaranteed profit at resolution regardless of outcome.
 * 
 * OPTIONAL STRATEGIES (all disabled by default, enable via config):
 * - Crypto Speed: Exploit Polymarket crypto markets lagging Binance spot (never produced trades in testing)
 * - BTC 15-Min Arb: Gabagool strategy — buy UP+DOWN when sum < $1 (never produced trades in testing)
 * - Same-Market Arb: YES+NO < $1 on single platform (theoretical, finds 0)
 * - Combinatorial: Statistical edge from related markets (NOT guaranteed profit)
 */

import pmxt from 'pmxtjs';
import WebSocket from 'ws';
import { PaperTrader } from './paper-trader.js';
import { MarketScanner } from './market-scanner.js';
import { createDashboard } from './dashboard.js';
import { AlertManager } from './alerts.js';
import { EmailAlerts } from './email-alerts.js';
import { config } from '../config.js';
import { loadKalshiCredentials, generateKalshiHeaders, generateKalshiRestHeaders } from './kalshi-auth.js';
import { MARKET_PAIRS, POLY_GAMMA, resolvePair } from './market-pairs.js';
import { insertNearMiss } from './db.js';
import { AutoRedeemer } from './auto-redeem.js';
import { OrderManager } from './order-manager.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { LiveExecutor } from './live-executor.js';
import { ResolutionChecker } from './resolution-checker.js';

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

    tryAcquire() {
        if (this._locked) return false;
        this._locked = true;
        return true;
    }

    acquire() {
        if (!this._locked) {
            this._locked = true;
            return Promise.resolve(true);
        }
        return new Promise(resolve => {
            this._queue.push(resolve);
        });
    }

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
            initialBalance: 500,
            contractSize: 10,
            minNetProfit: 1.0,
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
            cooldownMs: 60000,
        });

        // Email alerts
        this.email = new EmailAlerts({
            from: process.env.GMAIL_USER,
            to: process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER,
            appPassword: process.env.GMAIL_APP_PASSWORD,
        });

        // Circuit breaker & execution lock
        this.circuitBreaker = new CircuitBreaker({
            maxPositionPerMarket: 50,
            maxTotalPosition: 200,
            maxDailyLoss: 5000,
            maxConsecutiveErrors: 5,
            cooldownMs: 60000,
        });
        this.executionLock = new ExecutionLock();

        // Auto-redemption & order management
        this.autoRedeemer = new AutoRedeemer(this.polymarket, this.kalshi, this.trader, {
            intervalMs: 5 * 60 * 1000,
            gracePeriodMs: 2 * 60 * 1000,
        });
        this.orderManager = new OrderManager({
            timeoutMs: 10000,
        });

        // Live/Paper Mode
        this.isLiveMode = process.env.DRY_RUN === '0';
        this.liveExecutor = new LiveExecutor(this.polymarket, this.kalshi, {
            dryRun: !this.isLiveMode,
            proxyUrl: process.env.ORDER_PROXY_URL,
            proxyToken: process.env.ORDER_PROXY_TOKEN,
        });

        // Optional strategies — lazy-loaded only if enabled
        this.cryptoSpeed = null;
        this.sameMarketArb = null;
        this.combinatorialArb = null;
        this.btc15minArb = null;
        this.binanceFeed = null;
        this.chainlinkFeed = null;
        this.resolutionWatcher = null;

        // Resolution criteria checker (LLM-powered)
        this.resolutionChecker = new ResolutionChecker({
            minConfidence: 0.8,
            cacheExpiryMs: 24 * 60 * 60 * 1000, // 24h
        });
    }

    async start() {
        const modeTag = this.isLiveMode ? '🔴 LIVE MODE — REAL MONEY' : '📄 PAPER MODE — DRY RUN';
        const strategies = ['Cross-Platform Arb'];
        if (this.config.enableCryptoSpeed) strategies.push('Crypto Speed (15m/hourly/daily)');
        if (this.config.enableBtc15minArb) strategies.push('BTC 15-Min Arb (gabagool)');
        if (this.config.enableSameMarketArb) strategies.push('Same-Market Arb');
        if (this.config.enableCombinatorialArb) strategies.push('Combinatorial (speculative)');
        if (this.config.enableResolutionWatcher) strategies.push('Resolution Watcher (logging)');

        console.log('╔═══════════════════════════════════════════════════╗');
        console.log('║   🎯 ARB BOT v4 — CROSS-PLATFORM FOCUSED        ║');
        console.log(`║   ${modeTag.padEnd(47)}║`);
        console.log('╚═══════════════════════════════════════════════════╝');
        console.log(`\nActive strategies: ${strategies.join(', ')}\n`);

        if (this.isLiveMode) {
            console.log('⚠️  ⚠️  ⚠️  LIVE TRADING ENABLED — REAL ORDERS WILL BE PLACED ⚠️  ⚠️  ⚠️\n');
        } else {
            console.log('[PAPER MODE] Set DRY_RUN=0 to enable live trading\n');
        }

        // 1. Start dashboard FIRST — Fly health checks need the port open
        this.dashboard = createDashboard(this, this.trader, { port: 3456 });
        await this.dashboard.ready;

        // Alert: bot started
        this.alerts.botStarted().catch(() => {});
        this.email.botStarted().catch(() => {});

        // 2. Scan & map markets (cross-platform arb — always on)
        await this.scanMarkets();

        // 3. Connect BOTH platform WebSockets
        this.connectPolyWS();
        this.connectKalshiWS();

        // 4. Crypto Speed strategy (exchange price leads prediction market)
        if (this.config.enableCryptoSpeed) {
            const { BinanceFeed } = await import('./binance-feed.js');
            const { ChainlinkFeed } = await import('./chainlink-feed.js');
            const { CryptoSpeedStrategy } = await import('./crypto-speed.js');
            this.binanceFeed = new BinanceFeed();
            this.chainlinkFeed = new ChainlinkFeed();
            this.cryptoSpeed = new CryptoSpeedStrategy(this.binanceFeed, this.trader, {}, this.chainlinkFeed);
            this.binanceFeed.connect();
            this.chainlinkFeed.connect();
            await this.cryptoSpeed.start();
            console.log('[CRYPTO-SPEED] ⚡ Enabled (15m / hourly / daily crypto markets)');
        }

        // 5. Optional: Same-market rebalancing arb
        if (this.config.enableSameMarketArb) {
            const { SameMarketArb } = await import('./same-market-arb.js');
            this.sameMarketArb = new SameMarketArb(this.trader);
            await this.sameMarketArb.start();
            console.log('[SAME-MARKET] 🔄 Enabled');
        }

        // 6. Optional: BTC 15-Min Same-Market Arb (Gabagool strategy — TRUE arb)
        if (this.config.enableBtc15minArb) {
            const { Btc15minArb } = await import('./btc-15min-arb.js');
            this.btc15minArb = new Btc15minArb(this.trader, this.config);
            await this.btc15minArb.start();
            console.log('[BTC-15MIN-ARB] 🎯 Enabled (true arb — gabagool strategy)');
        }

        // 7. Optional: Combinatorial arb (speculative)
        if (this.config.enableCombinatorialArb) {
            const { CombinatorialArb } = await import('./combinatorial-arb.js');
            this.combinatorialArb = new CombinatorialArb(this.trader, {
                scanIntervalMs: 60_000,
                minEdgeCents: 3,
                maxDaysToExpiry: 14,
                useEmbeddings: false,
            });
            await this.combinatorialArb.start();
            console.log('[COMBO-ARB] 📊 Enabled (speculative, not guaranteed profit)');
        }

        // 8. Optional: Resolution watcher (settlement lag scanner — logging only)
        if (this.config.enableResolutionWatcher) {
            const { ResolutionWatcher } = await import('./resolution-watcher.js');
            this.resolutionWatcher = new ResolutionWatcher({
                checkIntervalMs: 5 * 60 * 1000, // 5 min
                maxAgeHours: 24,
                minProfitCents: 3,
            });
            await this.resolutionWatcher.start();
            console.log('[RESOLUTION-WATCHER] 🔍 Enabled (logging only — no auto-trade)');
        }

        // 9. Start auto-redemption engine
        this.autoRedeemer.start();

        // 8. Re-scan periodically
        setInterval(() => this.scanMarkets(), SCAN_INTERVAL_MS);

        // 9. Tick every 10s — check exits, broadcast state
        setInterval(() => this.tick(), 10000);

        console.log(`\n[LIVE] Bot running — ${strategies.length} strategy(ies) active. Dashboard at :3456\n`);
    }

    // ── Market Discovery (Curated + Auto-Discovery) ─────────

    async scanMarkets() {
        try {
            console.log('\n[SCAN] Scanning cross-platform markets...');

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

            const maxDays = this.config.maxDaysToExpiry || 30;
            const maxExpiryMs = Date.now() + maxDays * 24 * 60 * 60 * 1000;

            // ── Phase 1: Resolve curated MARKET_PAIRS ──────────
            const activePairs = MARKET_PAIRS.filter(p => p.active);
            console.log(`[SCAN] Phase 1: ${activePairs.length} curated pairs...`);

            const newMappings = [];
            for (const pair of activePairs) {
                const resolved = await resolvePair(pair, fetchKalshi);
                let added = 0;
                let skippedExpiry = 0;
                for (const r of resolved) {
                    if (r.kalshiTicker && r.polyYes != null) {
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
                            source: 'curated',
                        });
                        added++;
                    }
                }
                if (resolved.length > 0) {
                    const expiryNote = skippedExpiry > 0 ? ` (${skippedExpiry} skipped: >${maxDays}d)` : '';
                    console.log(`  ✓ ${pair.name}: ${resolved.length} resolved, ${added} with prices${expiryNote}`);
                }
            }

            // ── Phase 2: Auto-discovery via targeted series scan ──────────
            try {
                console.log(`\n[DISCOVERY] Phase 2: Auto-discovering cross-platform pairs...`);
                const maxDaysMs = maxDays * 24 * 60 * 60 * 1000;
                const existingKalshi = new Set(newMappings.map(m => m.kalshiTicker));
                const existingPoly = new Set(newMappings.map(m => m.polyMarketId));

                // 2a. Fetch Kalshi markets by targeted series (NOT all 3000+ markets)
                const kalshiSeries = this.config.discoveryKalshiSeries || [];
                let allKalshi = [];
                for (const series of kalshiSeries) {
                    try {
                        const data = await fetchKalshi(`/markets?series_ticker=${series}&status=open&limit=50`);
                        if (data.markets?.length) {
                            allKalshi.push(...data.markets);
                        }
                    } catch (e) {
                        // Series doesn't exist — skip
                    }
                }

                // Filter to short-dated only
                const shortKalshi = allKalshi.filter(m => {
                    if (existingKalshi.has(m.ticker)) return false; // Skip already matched
                    const exp = m.expected_expiration_time || m.expiration_time;
                    if (!exp) return false;
                    return new Date(exp).getTime() <= Date.now() + maxDaysMs;
                });
                console.log(`[DISCOVERY] Kalshi: ${allKalshi.length} from ${kalshiSeries.length} series → ${shortKalshi.length} short-dated unmatched`);

                // 2b. Fetch top Polymarket events by volume (more than default 100)
                const polyLimit = this.config.discoveryPolyEventLimit || 200;
                const pRes = await fetch(`${POLY_GAMMA}/events?active=true&closed=false&order=volume&ascending=false&limit=${polyLimit}`);
                const polyEvents = await pRes.json();
                const allPolyMarkets = [];
                for (const evt of (polyEvents || [])) {
                    for (const pm of (evt.markets || [])) {
                        if (existingPoly.has(pm.conditionId || pm.id)) continue; // Skip already matched
                        if (pm.endDate && new Date(pm.endDate).getTime() <= Date.now() + maxDaysMs) {
                            allPolyMarkets.push({ ...pm, eventTitle: evt.title, eventSlug: evt.slug });
                        }
                    }
                }
                console.log(`[DISCOVERY] Polymarket: ${allPolyMarkets.length} short-dated unmatched from ${polyLimit} events`);

                // 2c. Improved fuzzy matching
                const norm = s => (s || '').toLowerCase()
                    .replace(/[^a-z0-9\s]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                
                // Extract key entities for better matching (names, numbers, dates)
                const extractEntities = (text) => {
                    const n = norm(text);
                    const words = n.split(' ').filter(w => w.length > 2);
                    const numbers = n.match(/\d+/g) || [];
                    // Key nouns that distinguish markets
                    const keyTerms = words.filter(w => 
                        !['will', 'the', 'for', 'and', 'not', 'than', 'more', 'less',
                          'what', 'how', 'who', 'when', 'are', 'this', 'that', 'any',
                          'price', 'before', 'after', 'rate', 'rates'].includes(w)
                    );
                    // Detect direction words — critical for price/threshold markets
                    const hasAbove = /\b(above|over)\b/.test(n);
                    const hasBelow = /\b(below|under)\b/.test(n);
                    return { words, numbers, keyTerms, norm: n, hasAbove, hasBelow };
                };
                
                const minSimilarity = this.config.discoveryMinSimilarity || 0.30;
                let discovered = 0;

                for (const pm of allPolyMarkets) {
                    const polyQ = extractEntities(pm.question || pm.groupItemTitle || pm.eventTitle || '');
                    let bestMatch = null;
                    let bestScore = 0;

                    for (const km of shortKalshi) {
                        if (existingKalshi.has(km.ticker)) continue;
                        const kalshiQ = extractEntities(km.title || km.subtitle || '');

                        // Direction mismatch check — "above" vs "below" are opposite markets
                        if ((polyQ.hasAbove && kalshiQ.hasBelow) || (polyQ.hasBelow && kalshiQ.hasAbove)) continue;

                        // Multi-signal scoring:
                        // 1. Jaccard word overlap (baseline)
                        const common = polyQ.words.filter(w => kalshiQ.words.includes(w));
                        const union = new Set([...polyQ.words, ...kalshiQ.words]).size;
                        const jaccard = union > 0 ? common.length / union : 0;

                        // 2. Key term overlap (more important — entity names, specific nouns)
                        const keyCommon = polyQ.keyTerms.filter(w => kalshiQ.keyTerms.includes(w));
                        const keyUnion = new Set([...polyQ.keyTerms, ...kalshiQ.keyTerms]).size;
                        const keyOverlap = keyUnion > 0 ? keyCommon.length / keyUnion : 0;

                        // 3. Number matching (critical for price/threshold markets)
                        const numCommon = polyQ.numbers.filter(n => kalshiQ.numbers.includes(n));
                        const numBonus = numCommon.length > 0 ? 0.15 : 0;

                        // Combined score
                        const score = (jaccard * 0.3) + (keyOverlap * 0.55) + numBonus;

                        if (score > bestScore && score > minSimilarity) {
                            bestScore = score;
                            bestMatch = km;
                        }
                    }

                    if (bestMatch) {
                        let pPrices;
                        try {
                            pPrices = typeof pm.outcomePrices === 'string' ? JSON.parse(pm.outcomePrices) : pm.outcomePrices;
                        } catch (e) { continue; }
                        if (!pPrices?.[0]) continue;

                        let tokenIds = pm.clobTokenIds;
                        if (typeof tokenIds === 'string') {
                            try { tokenIds = JSON.parse(tokenIds); } catch(e) {}
                        }

                        const kalshiYes = bestMatch.yes_ask || bestMatch.yes_bid;
                        const kalshiNo = bestMatch.no_ask || bestMatch.no_bid;
                        // Skip if either price is missing — need both valid prices
                        if (!kalshiYes || kalshiYes <= 0 || !kalshiNo || kalshiNo <= 0) continue;

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
                            source: 'discovered',
                            discoveryScore: bestScore,
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
                console.error('[DISCOVERY] Error in auto-discovery:', e.message);
            }

            this.marketMappings = newMappings;
            const curatedCount = newMappings.filter(m => m.source === 'curated').length;
            const discoveredCount = newMappings.filter(m => m.source === 'discovered').length;
            console.log(`[SCAN] Total: ${this.marketMappings.length} cross-platform pairs (${curatedCount} curated + ${discoveredCount} discovered), max ${maxDays}d\n`);

            // Re-subscribe WebSockets
            if (this.polyConnected) this.subscribePolyMarkets();
            if (this.kalshiConnected) this.subscribeKalshiMarkets();

            // Seed initial prices from scan data (only if both prices valid)
            for (const m of this.marketMappings) {
                if (m.polyYes > 0 && m.polyNo > 0) {
                    this.polyPrices.set(m.polyTokenId, {
                        yes: m.polyYes, no: m.polyNo,
                        lastUpdate: Date.now(), source: 'scan'
                    });
                }
                if (m.kalshiYes > 0 && m.kalshiNo > 0) {
                    this.kalshiPrices.set(m.kalshiTicker, {
                        yes: m.kalshiYes, no: m.kalshiNo,
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
        if (!this.kalshiCreds) return;

        const tickers = this.marketMappings
            .map(m => m.kalshiTicker)
            .filter(Boolean);
        if (tickers.length === 0) return;

        for (const ticker of tickers) {
            try {
                // Skip if we have fresh WS data
                const existing = this.kalshiPrices.get(ticker);
                if (existing?.source === 'ws' && (Date.now() - existing.lastUpdate) < 30000) continue;

                const path = `/trade-api/v2/markets/${ticker}`;
                const headers = generateKalshiRestHeaders(
                    this.kalshiCreds.keyId, this.kalshiCreds.privateKey,
                    'GET', path
                );
                const res = await fetch(`https://api.elections.kalshi.com${path}`, { headers });
                if (!res.ok) continue;

                const data = await res.json();
                const market = data.market;
                if (!market) continue;

                const yesAsk = market.yes_ask;
                const noAsk = market.no_ask;
                // Skip if either price is missing or 0 — need both valid prices
                if (!yesAsk || yesAsk <= 0 || !noAsk || noAsk <= 0) continue;

                this.kalshiPrices.set(ticker, {
                    yes: yesAsk,
                    no: noAsk,
                    yesAsk,
                    lastUpdate: Date.now(),
                    source: 'rest-fallback'
                });

                const mapping = this.marketMappings.find(m => m.kalshiTicker === ticker);
                if (mapping) this.evaluateSpread(mapping);
            } catch (e) {
                // Individual ticker errors are non-critical
            }
        }
    }

    // ── Spread Evaluation ───────────────────────────────────

    evaluateSpread(mapping) {
        const poly = this.polyPrices.get(mapping.polyTokenId);
        const kalshi = this.kalshiPrices.get(mapping.kalshiTicker);
        if (!poly || !kalshi) return;

        // Strict price validation — reject null, undefined, NaN, or 0
        const prices = [poly.yes, poly.no, kalshi.yes, kalshi.no];
        if (prices.some(p => p == null || isNaN(p) || p === 0)) return;

        // STALENESS CHECK — don't trade on prices older than 60 seconds
        const MAX_PRICE_AGE_MS = 60000;
        const now = Date.now();
        if ((now - (poly.lastUpdate || 0)) > MAX_PRICE_AGE_MS || 
            (now - (kalshi.lastUpdate || 0)) > MAX_PRICE_AGE_MS) {
            return; // Skip — prices too old
        }

        const minPrice = this.config.minPriceThreshold || 2;
        if (poly.yes <= minPrice || poly.no <= minPrice || kalshi.yes <= minPrice || kalshi.no <= minPrice) return;

        // Time-weighted spread thresholds
        let spreadMultiplier = 1.0;
        if (mapping.expiresAt) {
            const msToExpiry = new Date(mapping.expiresAt) - Date.now();
            const hoursToExpiry = msToExpiry / (60 * 60 * 1000);

            if (hoursToExpiry < 2) {
                spreadMultiplier = 2.0;
            } else if (hoursToExpiry < 24) {
                spreadMultiplier = 1.0 + (1.0 * (24 - hoursToExpiry) / 22);
            }
        }

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
            source: mapping.source || 'curated',
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

        // Log near misses
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

        // Trade
        this._executeSafeTrade(opp, mapping);

        // Alert real opportunities
        if (bestArb.isProfitable && bestArb.netProfit >= this.config.alertThresholdCents) {
            const desc = strategy === 1
                ? `Poly YES (${poly.yes.toFixed(1)}¢) + Kalshi NO (${kalshi.no.toFixed(1)}¢) = ${bestArb.totalCost.toFixed(1)}¢ cost → ${bestArb.netProfit.toFixed(1)}¢ net profit`
                : `Poly NO (${poly.no.toFixed(1)}¢) + Kalshi YES (${kalshi.yes.toFixed(1)}¢) = ${bestArb.totalCost.toFixed(1)}¢ cost → ${bestArb.netProfit.toFixed(1)}¢ net profit`;
            this.alerts.bigOpportunity({ name: mapping.name, netProfit: bestArb.netProfit, description: desc }).catch(() => {});
            this.email.bigOpportunity({ name: mapping.name, netProfit: bestArb.netProfit, description: desc }).catch(() => {});
        }
    }

    // ── Safe Trade Execution ────────────────────────────────

    async _executeSafeTrade(opp, mapping) {
        const context = this._getPositionContext();
        const cbCheck = this.circuitBreaker.check(opp, context);
        if (!cbCheck.allowed) {
            if (!this._lastCBLog || Date.now() - this._lastCBLog > 30000) {
                console.log(`[CIRCUIT-BREAKER] Blocked: ${cbCheck.reason}`);
                this._lastCBLog = Date.now();
            }
            return;
        }

        // For auto-discovered pairs with big spreads, verify resolution criteria match
        const isAutoDiscovered = mapping?.source === 'discovered';
        const spread = opp.grossSpread || 0;
        const isBigSpread = spread > 5; // >5% spread is suspicious
        
        if (isAutoDiscovered && isBigSpread && this.resolutionChecker) {
            try {
                // Build minimal market objects for comparison
                const polyMarket = { 
                    id: mapping.polyMarketId,
                    conditionId: mapping.polyMarketId,
                    question: opp.name,
                    description: mapping.polyDescription || null,
                };
                const kalshiMarket = {
                    ticker: mapping.kalshiTicker,
                    title: opp.name,
                    rules: mapping.kalshiRules || null,
                };
                
                const resCheck = await this.resolutionChecker.check(polyMarket, kalshiMarket, spread);
                
                if (!resCheck.approved) {
                    console.log(`⚠️ [RESOLUTION-CHECK] Blocked ${opp.name}: ${resCheck.reason}`);
                    if (resCheck.issues?.length) {
                        resCheck.issues.forEach(i => console.log(`   • ${i}`));
                    }
                    return; // Don't trade if resolution criteria don't match
                }
            } catch (e) {
                console.log(`⚠️ [RESOLUTION-CHECK] Error checking ${opp.name}: ${e.message}`);
                // Continue with trade if check fails (fail-open for now)
            }
        }

        if (!this.executionLock.tryAcquire()) {
            this.executionLock.skippedCount++;
            return;
        }

        try {
            const tradeId = `xp-${(opp.name || '').replace(/[^a-zA-Z0-9]/g, '-').substring(0, 40)}-${Date.now()}`;

            if (this.isLiveMode && mapping) {
                const { status, result: liveResult, elapsedMs } = await this.orderManager.executeWithTimeout(
                    () => this.liveExecutor.execute(opp, mapping, this.trader.contractSize),
                    tradeId
                );

                if (status === 'timeout') {
                    console.log(`⏰ [LIVE] TRADE TIMEOUT: ${opp.name} after ${elapsedMs}ms`);
                } else if (liveResult?.success) {
                    const paperTrade = this.trader.executeTrade(opp);
                    this.circuitBreaker.recordSuccess();

                    const net = paperTrade ? (paperTrade.expectedNetProfit / 100).toFixed(2) : '?';
                    const fee = paperTrade ? (paperTrade.fees / 100).toFixed(2) : '?';
                    console.log(`🔴📈 [LIVE] ENTER ${opp.name} | S${opp.strategy} | Cost: ${opp.totalCost?.toFixed(1)}¢ | Net: +$${net} | Fees: $${fee} | Exec: ${elapsedMs}ms`);
                    this.alerts.tradeExecuted(paperTrade || opp).catch(() => {});
                    this.email.tradeExecuted(paperTrade || opp).catch(() => {});
                    if (this.dashboard) {
                        this.dashboard.broadcast('trade', paperTrade || opp);
                        this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
                    }
                } else if (liveResult?.criticalPartialFill) {
                    this.circuitBreaker.recordError(new Error(`Partial fill: ${liveResult.error}`));
                    this.alerts.bigOpportunity({
                        name: `🚨 PARTIAL FILL: ${opp.name}`,
                        netProfit: 0,
                        description: liveResult.error,
                    }).catch(() => {});
                    this.email.bigOpportunity({
                        name: `🚨 PARTIAL FILL: ${opp.name}`,
                        netProfit: 0,
                        description: liveResult.error,
                    }).catch(() => {});
                } else if (liveResult?.error) {
                    console.log(`❌ [LIVE] Failed: ${opp.name} — ${liveResult.error}`);
                }
            } else {
                const { status, result: trade, elapsedMs } = await this.orderManager.executeWithTimeout(
                    () => this.trader.executeTrade(opp),
                    tradeId
                );

                if (status === 'timeout') {
                    console.log(`⏰ TRADE TIMEOUT: ${opp.name} after ${elapsedMs}ms`);
                } else if (trade) {
                    this.circuitBreaker.recordSuccess();

                    const net = (trade.expectedNetProfit / 100).toFixed(2);
                    const fee = (trade.fees / 100).toFixed(2);
                    console.log(`📈 ENTER ${trade.name} | S${trade.strategy} | Cost: $${(trade.totalCost/100).toFixed(2)} | Gross: ${trade.grossSpread.toFixed(1)}¢ | Fees: $${fee} | Net: +$${net} | Exec: ${elapsedMs}ms`);
                    this.alerts.tradeExecuted(trade).catch(() => {});
                    this.email.tradeExecuted(trade).catch(() => {});
                    if (this.dashboard) {
                        this.dashboard.broadcast('trade', trade);
                        this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
                    }
                }
            }
        } catch (err) {
            this.circuitBreaker.recordError(err);
            console.error(`[TRADE-ERROR] ${opp.name}: ${err.message}`);
        } finally {
            this.executionLock.release();
        }
    }

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
        // Check stop-loss exits
        const closed = this.trader.checkExits(this.currentOpportunities);
        for (const trade of closed) {
            const net = trade.netPnl >= 0 ? `+$${(trade.netPnl/100).toFixed(2)}` : `-$${Math.abs(trade.netPnl/100).toFixed(2)}`;
            console.log(`📉 STOP-LOSS ${trade.name} | Net: ${net} | Hold: ${Math.round(trade.holdTime/1000)}s`);
            this.alerts.positionRedeemed(trade.name, trade.netPnl).catch(() => {});

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

        // Count profitable opportunities
        const profitable = this.currentOpportunities.filter(o => o.isProfitable).length;
        const p = this.trader.getPortfolioSummary();
        const pWs = this.polyConnected ? '🟢' : '🔴';
        const kWs = this.kalshiConnected ? '🟢' : (this.kalshiRestMode ? '🔄' : '🔴');
        const maxDays = this.config.maxDaysToExpiry || 30;
        const modeIndicator = this.isLiveMode ? '🔴LIVE' : '📄PAPER';

        // Build status line
        let statusParts = [
            `Poly ${pWs} Kalshi ${kWs}`,
            `XP:${this.currentOpportunities.length}≤${maxDays}d(${profitable}✓)`,
        ];

        // Add optional strategy stats
        if (this.cryptoSpeed) {
            const cs = this.cryptoSpeed.getStats();
            const bWs = this.binanceFeed?.connected ? '🟢' : '🔴';
            statusParts.push(`CS:${cs.activeMarkets}mkts Bin${bWs}`);
        }
        if (this.sameMarketArb) {
            const sm = this.sameMarketArb.getStats();
            statusParts.push(`SM:${sm.found}found`);
        }
        if (this.combinatorialArb) {
            const ca = this.combinatorialArb.stats || {};
            statusParts.push(`CA:${ca.opportunitiesFound || 0}opps`);
        }
        if (this.btc15minArb) {
            const g = this.btc15minArb.getStats();
            statusParts.push(`G15:${g.activeMarkets}mkts/${g.opportunities}opp/${g.trades}trd`);
        }
        if (this.resolutionWatcher) {
            const rw = this.resolutionWatcher.getStats();
            statusParts.push(`RW:${rw.currentOpportunities}opp`);
        }

        statusParts.push(`${p.openPositions} pos`, `P&L: $${p.netPnL}`, `Trades: ${p.totalTrades}`);
        console.log(`[${new Date().toLocaleTimeString()}] ${modeIndicator} | ${statusParts.join(' | ')}`);
    }

    stop() {
        this.alerts.botStopped('shutdown').catch(() => {});
        this.alerts.stop();
        this.email.botStopped('shutdown').catch(() => {});
        this.email.stop();
        if (this.autoRedeemer) this.autoRedeemer.stop();
        if (this.circuitBreaker) this.circuitBreaker.destroy();
        if (this.polyWs) this.polyWs.close();
        if (this.kalshiWs) this.kalshiWs.close();
        if (this.binanceFeed) this.binanceFeed.stop();
        if (this.chainlinkFeed) this.chainlinkFeed.stop();
        if (this.cryptoSpeed) this.cryptoSpeed.stop();
        if (this.sameMarketArb) this.sameMarketArb.stop();
        if (this.combinatorialArb) this.combinatorialArb.stop();
        if (this.btc15minArb) this.btc15minArb.stop();
        if (this.resolutionWatcher) this.resolutionWatcher.stop();
        if (this.dashboard?.server) this.dashboard.server.close();
        console.log('\n[STOPPED]');
    }
}

// ── Start ───────────────────────────────────────────────
const bot = new LiveBot();
process.on('SIGINT', () => { bot.stop(); process.exit(0); });
bot.start().catch(console.error);
