/**
 * Crypto Speed Strategy — 15-Minute Markets — SPECULATIVE, NOT TRUE ARBITRAGE
 * 
 * ⚠️ IMPORTANT: This is NOT arbitrage. This is a single-platform directional bet.
 * 
 * THE THESIS: Polymarket's 15-min BTC/ETH/SOL up/down markets lag
 * behind real-time exchange prices by 1-2 minutes. When spot price
 * is clearly trending (e.g., BTC up +0.3% in last 2 min), the
 * Polymarket market still shows ~50/50 odds.
 * 
 * We buy the direction matching the trend and hope it holds to resolution.
 * 
 * RISKS:
 * - Price can reverse in the remaining time
 * - Polymarket may not have active 15-min markets (often finds 0)
 * - Requires Binance WebSocket feed for real-time prices
 * - Single-platform: if Polymarket is down, strategy is dead
 * 
 * Disabled by default. Enable via config.enableCryptoSpeed = true
 */

import { EventEmitter } from 'events';

const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const POLY_CLOB = 'https://clob.polymarket.com';

// Minimum momentum thresholds to trigger a trade
const THRESHOLDS = {
    // changePercent over 2 minutes needed to consider a trade
    minChangePercent: 0.15,     // 0.15% move in 2 min = clear direction
    // Minimum strength score (0-1)
    minStrength: 0.3,
    // Minimum confidence (enough data points)
    minConfidence: 0.3,
    // Maximum Polymarket price to buy (cents) — we want to buy cheap
    // If market already reflects the move (price > 70¢), skip
    maxBuyPrice: 68,
    // Minimum discount: how much cheaper than our estimated probability
    minEdge: 10,  // Must be at least 10¢ cheaper than estimated true probability
    // Cooldown between trades on same market (ms)
    tradeCooldownMs: 5 * 60 * 1000,  // 5 min
};

// Time-weighted edge thresholds — markets approaching expiry need MORE edge
const TIME_PHASES = {
    EARLY:  { minMinutes: 10, minEdge: 8,  minStrength: 0.25 },  // >10 min left
    MID:    { minMinutes: 5,  minEdge: 12, minStrength: 0.35 },  // 5-10 min left
    LATE:   { minMinutes: 0,  minEdge: 18, minStrength: 0.50 },  // <5 min left
};

/**
 * Fetch the CLOB order book for a given token
 * @param {string} tokenId - Polymarket CLOB token ID
 * @returns {Promise<{ bids: Array<{price: string, size: string}>, asks: Array<{price: string, size: string}> }>}
 */
async function fetchOrderBook(tokenId) {
    const url = `${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CLOB book error: ${res.status}`);
    return res.json();
}

/**
 * Walk the order book to find the actual executable price for a given size
 * @param {{ bids: Array, asks: Array }} book - Order book from CLOB
 * @param {'bid'|'ask'} side - 'ask' if buying, 'bid' if selling
 * @param {number} size - Number of contracts to fill
 * @returns {number|null} - Volume-weighted average price, or null if insufficient liquidity
 */
function getExecutablePrice(book, side, size) {
    const levels = side === 'ask'
        ? (Array.isArray(book?.asks) ? [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price)) : [])
        : (Array.isArray(book?.bids) ? [...book.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price)) : []);

    if (levels.length === 0) return null;

    let remaining = size;
    let totalCost = 0;

    for (const level of levels) {
        const price = parseFloat(level.price);
        const available = parseFloat(level.size);
        if (!Number.isFinite(price) || !Number.isFinite(available) || available <= 0) continue;

        const fill = Math.min(remaining, available);
        totalCost += fill * price;
        remaining -= fill;

        if (remaining <= 0) break;
    }

    if (remaining > 0) return null;  // Not enough liquidity
    return totalCost / size;  // Volume-weighted average price
}

export { fetchOrderBook, getExecutablePrice };

export class CryptoSpeedStrategy extends EventEmitter {
    /**
     * @param {import('./binance-feed.js').BinanceFeed} binanceFeed
     * @param {import('./paper-trader.js').PaperTrader} paperTrader
     * @param {object} [config]
     * @param {import('./chainlink-feed.js').ChainlinkFeed} [chainlinkFeed] - Optional Chainlink price feed
     */
    constructor(binanceFeed, paperTrader, config = {}, chainlinkFeed = null) {
        super();
        this.binance = binanceFeed;
        this.trader = paperTrader;
        this.config = { ...THRESHOLDS, ...config };
        this.chainlink = chainlinkFeed;
        
        // Track active 15-min markets
        this.activeMarkets = [];  // { ticker, conditionId, tokenIds, question, endDate, currentYes, currentNo }
        this.lastTrade = new Map();  // market id → timestamp
        this.scanInterval = null;
        this.evalInterval = null;
        
        // Stats
        this.stats = {
            scans: 0,
            evaluations: 0,
            signals: 0,
            trades: 0,
            skipped: 0,
            bookFetches: 0,
            bookFailures: 0,
            skippedByBook: 0,
            skippedByTimePhase: 0,
        };
    }

    async start() {
        console.log('[CRYPTO-SPEED] Starting 15-min crypto strategy...');
        console.log(`[CRYPTO-SPEED] Thresholds: ${this.config.minChangePercent}% move, strength>${this.config.minStrength}, maxBuy=${this.config.maxBuyPrice}¢`);

        // Initial market scan
        await this.scanMarkets();

        // Re-scan for new 15-min markets every 2 minutes
        this.scanInterval = setInterval(() => this.scanMarkets(), 2 * 60 * 1000);

        // Evaluate momentum vs market prices every 5 seconds
        this.evalInterval = setInterval(() => this.evaluate().catch(e => console.error('[CRYPTO-SPEED] Eval error:', e.message)), 5000);
    }

    /**
     * Scan Polymarket for active 15-minute / hourly crypto markets
     * 
     * Actual Polymarket slug format: btc-updown-15m-{unix_timestamp}
     * Actual question format: "Bitcoin Up or Down - January 30, 2PM ET"
     * The Gamma API returns these under the crypto tag
     */
    async scanMarkets() {
        this.stats.scans++;
        try {
            const newMarkets = [];
            const seenIds = new Set();

            const addMarket = (market, eventTitle) => {
                const id = market.conditionId || market.id;
                if (seenIds.has(id)) return;

                const q = (market.question || market.groupItemTitle || eventTitle || '').toLowerCase();
                if (!this._isShortTermCrypto(q, market.endDate)) return;

                const ticker = this._extractTicker(q);
                if (!ticker) return;

                let tokenIds = market.clobTokenIds;
                if (typeof tokenIds === 'string') {
                    try { tokenIds = JSON.parse(tokenIds); } catch (e) { tokenIds = []; }
                }
                let prices = market.outcomePrices;
                if (typeof prices === 'string') {
                    try { prices = JSON.parse(prices); } catch (e) { prices = []; }
                }

                seenIds.add(id);
                newMarkets.push({
                    id,
                    question: market.question || market.groupItemTitle || eventTitle,
                    ticker,
                    direction: this._extractDirection(q),
                    tokenIds: tokenIds || [],
                    endDate: market.endDate,
                    currentYes: prices?.[0] ? parseFloat(prices[0]) * 100 : null,
                    currentNo: prices?.[1] ? parseFloat(prices[1]) * 100 : null,
                    volume: parseFloat(market.volume || 0),
                    slug: market.slug,
                });
            };

            // Strategy 1: Fetch ALL active crypto events from Gamma API
            // Sort by volume descending to get the most liquid markets first
            const res = await fetch(`${POLY_GAMMA}/events?active=true&closed=false&tag=crypto&order=volume24hr&ascending=false&limit=100`);
            const events = await res.json();
            for (const event of (events || [])) {
                const title = (event.title || '').toLowerCase();
                // Only process "up or down" / "above" style events
                if (title.includes('up or down') || title.includes('above')) {
                    for (const market of (event.markets || [])) {
                        addMarket(market, event.title);
                    }
                }
            }

            // Strategy 2: Direct market search for short-term crypto markets
            // These are returned as individual markets, not grouped events
            const searchRes = await fetch(`${POLY_GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200`);
            const allMarkets = await searchRes.json();
            for (const market of (allMarkets || [])) {
                const q = (market.question || market.groupItemTitle || '').toLowerCase();
                if ((q.includes('up or down') || q.includes('above')) &&
                    (q.includes('bitcoin') || q.includes('btc') || q.includes('ethereum') || q.includes('eth') || q.includes('solana') || q.includes('sol'))) {
                    addMarket(market);
                }
            }

            this.activeMarkets = newMarkets;
            if (newMarkets.length > 0) {
                console.log(`[CRYPTO-SPEED] Found ${newMarkets.length} short-term crypto markets:`);
                for (const m of newMarkets.slice(0, 8)) {
                    const timeLeft = m.endDate ? Math.round((new Date(m.endDate) - Date.now()) / 60000) : '?';
                    console.log(`  ${m.ticker} ${m.direction} | ${m.question?.substring(0, 55)} | YES: ${m.currentYes?.toFixed(0)}¢ | ${timeLeft}m`);
                }
                if (newMarkets.length > 8) console.log(`  ... and ${newMarkets.length - 8} more`);
            } else {
                console.log(`[CRYPTO-SPEED] No active short-term crypto markets found (checked ${events?.length || 0} events + ${allMarkets?.length || 0} markets)`);
            }
        } catch (e) {
            console.error('[CRYPTO-SPEED] Scan error:', e.message);
        }
    }

    /**
     * Evaluate: compare Binance momentum vs Polymarket prices
     * This runs every 5 seconds
     * 
     * Incorporates time-weighted edge thresholds and Chainlink divergence detection
     */
    async evaluate() {
        if (this.activeMarkets.length === 0) return;
        this.stats.evaluations++;

        // Check Chainlink vs exchange divergence (informational)
        if (this.chainlink) {
            for (const ticker of ['BTC', 'ETH', 'SOL']) {
                const exchangePrice = this.binance.getPrice(ticker);
                if (exchangePrice > 0) {
                    this.chainlink.checkDivergence(ticker, exchangePrice);
                }
            }
        }

        for (const market of this.activeMarkets) {
            // Skip if recently traded
            const lastTrade = this.lastTrade.get(market.id) || 0;
            if (Date.now() - lastTrade < this.config.tradeCooldownMs) continue;

            // Skip expired markets
            if (market.endDate && new Date(market.endDate) <= Date.now()) continue;

            // Calculate remaining time and determine phase
            const remainingMs = market.endDate ? new Date(market.endDate) - Date.now() : Infinity;
            const remainingMin = remainingMs / 60000;
            const phase = this._getTimePhase(remainingMin);

            // Get Binance momentum
            const momentum = this.binance.getMomentum(market.ticker, 2 * 60 * 1000);  // 2-min window
            if (!momentum || momentum.direction === 'flat') continue;
            if (Math.abs(momentum.changePercent) < this.config.minChangePercent) continue;

            // Time-weighted strength threshold
            if (momentum.strength < phase.minStrength) {
                this.stats.skippedByTimePhase++;
                continue;
            }
            if (momentum.confidence < this.config.minConfidence) continue;

            // Determine which side to buy based on market type and momentum
            let buyYes = false;
            if (market.direction === 'up_or_down') {
                // "Up or Down" market: YES = up, NO = down (typically)
                buyYes = momentum.direction === 'up';
            } else if (market.direction === 'above') {
                // "Above X" market: YES = price stays above
                buyYes = momentum.direction === 'up';
            } else {
                // Default: YES = up
                buyYes = momentum.direction === 'up';
            }

            // Get the price we'd buy at
            const buyPrice = buyYes ? market.currentYes : market.currentNo;
            if (buyPrice === null || buyPrice <= 0) continue;

            // Is it cheap enough? (market hasn't caught up to reality yet)
            if (buyPrice > this.config.maxBuyPrice) continue;

            // Skip dust markets — prices below 1¢ have no real liquidity
            if (buyPrice < 1) continue;

            // Estimate true probability from momentum — apply time decay
            const rawProb = this._estimateProbability(momentum);
            const estimatedProb = this._applyTimeDecay(rawProb, remainingMin);
            const edge = estimatedProb - buyPrice;

            // Time-weighted edge threshold (stricter as expiry approaches)
            if (edge < phase.minEdge) {
                this.stats.skippedByTimePhase++;
                continue;
            }

            // Prevent duplicate positions for same ticker+direction
            const posName = `⚡${market.ticker} ${buyYes ? 'UP' : 'DOWN'} (15m speed)`;
            const existingPos = this.trader.state.positions.find(p => p.name === posName);
            if (existingPos) continue;

            // Cap total crypto speed positions
            const csPositions = this.trader.state.positions.filter(p => p.name?.startsWith('⚡')).length;
            if (csPositions >= 5) continue;

            // 🚨 SIGNAL: Strong momentum + cheap price = buy
            this.stats.signals++;
            const signal = {
                type: 'CRYPTO_SPEED',
                market: market.question,
                ticker: market.ticker,
                side: buyYes ? 'YES' : 'NO',
                buyPrice,
                estimatedProb: estimatedProb.toFixed(1),
                edge: edge.toFixed(1),
                momentum: `${momentum.changePercent > 0 ? '+' : ''}${momentum.changePercent.toFixed(3)}% (${momentum.direction})`,
                strength: momentum.strength.toFixed(2),
                timeLeft: market.endDate ? `${Math.round(remainingMin)}m` : '?',
                phase: phase.name,
            };

            console.log(`\n🚀 [CRYPTO-SPEED] SIGNAL: ${signal.ticker} ${signal.side} @ ${signal.buyPrice}¢ [${phase.name}]`);
            console.log(`   Momentum: ${signal.momentum} | Strength: ${signal.strength}`);
            console.log(`   Est. prob: ${signal.estimatedProb}¢ | Edge: ${signal.edge}¢ | Time: ${signal.timeLeft} | Phase: ${phase.name} (minEdge=${phase.minEdge}¢)`);

            this.emit('signal', signal);

            // Execute paper trade (now with order book awareness)
            const trade = await this._executeTrade(market, buyYes, buyPrice, edge, momentum);
            if (trade) {
                this.lastTrade.set(market.id, Date.now());
                this.stats.trades++;
                console.log(`   ✅ TRADE ENTERED: ${trade.contracts} contracts @ ${trade.executablePrice || buyPrice}¢`);
            }
        }
    }

    /**
     * Determine time phase based on remaining minutes
     * @param {number} remainingMin
     * @returns {{ name: string, minEdge: number, minStrength: number }}
     */
    _getTimePhase(remainingMin) {
        if (remainingMin > TIME_PHASES.EARLY.minMinutes) {
            return { name: 'EARLY', ...TIME_PHASES.EARLY };
        } else if (remainingMin > TIME_PHASES.MID.minMinutes) {
            return { name: 'MID', ...TIME_PHASES.MID };
        } else {
            return { name: 'LATE', ...TIME_PHASES.LATE };
        }
    }

    /**
     * Decay estimated probability as time runs out
     * Closer to expiry → probability regresses toward 50%
     * adjustedProb = 50 + (rawProb - 50) * (remainingMin / 15)
     */
    _applyTimeDecay(rawProb, remainingMin) {
        const maxWindow = 15;  // Full 15-minute window
        const timeFactor = Math.min(remainingMin / maxWindow, 1);
        return 50 + (rawProb - 50) * timeFactor;
    }

    async _executeTrade(market, buyYes, buyPrice, edge, momentum) {
        const contracts = 10;  // $10 worth
        const side = buyYes ? 'BUY' : 'BUY';  // We're always buying (YES or NO)

        // ── Order Book Depth Check ──────────────────────────
        // Fetch real order book to know the ACTUAL executable price
        const tokenIndex = buyYes ? 0 : 1;
        const tokenId = market.tokenIds?.[tokenIndex];
        let executablePrice = buyPrice;  // Fallback to mid-price
        let bookInfo = null;

        if (tokenId) {
            try {
                const book = await fetchOrderBook(tokenId);
                bookInfo = this._summarizeBook(book);
                
                // Calculate executable price by walking the book
                const askPrice = getExecutablePrice(book, 'ask', contracts);
                if (askPrice !== null) {
                    executablePrice = askPrice * 100;  // Convert to cents
                    
                    // Log book info
                    const spread = bookInfo.spread !== null ? (bookInfo.spread * 100).toFixed(1) : '?';
                    console.log(`   📊 Book: bid=${(bookInfo.bestBid * 100).toFixed(1)}¢ ask=${(bookInfo.bestAsk * 100).toFixed(1)}¢ spread=${spread}¢ | Exec: ${executablePrice.toFixed(1)}¢ | Liq: ${bookInfo.askLiquidity.toFixed(0)} contracts`);
                    this.stats.bookFetches++;

                    // Only enter if executable price still shows edge
                    const realEdge = edge - (executablePrice - buyPrice);
                    if (realEdge < this.config.minEdge * 0.7) {  // Allow 30% slippage from mid-price edge
                        console.log(`   ❌ Book check FAILED: executable price ${executablePrice.toFixed(1)}¢ eats edge (real edge: ${realEdge.toFixed(1)}¢)`);
                        this.stats.skippedByBook++;
                        return null;
                    }
                }
            } catch (e) {
                // Book fetch failed — proceed with mid-price (not fatal)
                this.stats.bookFailures++;
            }
        }

        // Build an opportunity object compatible with PaperTrader
        const opportunity = {
            name: `⚡${market.ticker} ${buyYes ? 'UP' : 'DOWN'} (15m speed)`,
            strategy: buyYes ? 1 : 2,
            polyYes: buyYes ? executablePrice : (100 - executablePrice),
            polyNo: buyYes ? (100 - executablePrice) : executablePrice,
            kalshiYes: 0,
            kalshiNo: 0,
            expiresAt: market.endDate,
        };

        // Direct execution: deduct buy price, expect payout if correct
        const totalCost = executablePrice * contracts;

        if (totalCost > this.trader.state.polyBalance) return null;

        this.trader.state.polyBalance -= totalCost;
        this.trader.state.totalTrades++;

        const position = {
            id: `cs-${Date.now()}`,
            name: opportunity.name,
            strategy: opportunity.strategy,
            polySide: buyYes ? 'YES' : 'NO',
            kalshiSide: 'N/A',
            polyPrice: executablePrice,
            kalshiPrice: 0,
            contracts,
            totalCost,
            grossSpread: edge * contracts,
            fees: this.trader.calcPolyFee(executablePrice, { isCrypto15Min: true }) * contracts,
            expectedNetProfit: (edge - this.trader.calcPolyFee(executablePrice, { isCrypto15Min: true })) * contracts,
            expiresAt: market.endDate,
            entryTime: new Date().toISOString(),
            entryTimestamp: Date.now(),
            executablePrice,
            bookInfo,
            momentum: {
                changePercent: momentum.changePercent,
                direction: momentum.direction,
                strength: momentum.strength,
            },
        };

        this.trader.state.positions.push(position);
        this.trader.trades.push({ ...position, type: 'ENTRY', timestamp: new Date().toISOString() });
        this.trader.save();

        return position;
    }

    /**
     * Summarize an order book into key metrics
     * @param {{ bids: Array, asks: Array }} book
     * @returns {{ bestBid: number|null, bestAsk: number|null, spread: number|null, bidLiquidity: number, askLiquidity: number }}
     */
    _summarizeBook(book) {
        const bids = Array.isArray(book?.bids) ? book.bids : [];
        const asks = Array.isArray(book?.asks) ? book.asks : [];
        const depthLevels = 5;

        const bestBid = bids.reduce((best, lvl) => {
            const p = parseFloat(lvl.price);
            return Number.isFinite(p) && (best === null || p > best) ? p : best;
        }, null);

        const bestAsk = asks.reduce((best, lvl) => {
            const p = parseFloat(lvl.price);
            return Number.isFinite(p) && (best === null || p < best) ? p : best;
        }, null);

        const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
        const bidLiquidity = bids.slice(0, depthLevels).reduce((acc, x) => acc + (parseFloat(x.size) || 0), 0);
        const askLiquidity = asks.slice(0, depthLevels).reduce((acc, x) => acc + (parseFloat(x.size) || 0), 0);

        return { bestBid, bestAsk, spread, bidLiquidity, askLiquidity };
    }

    /**
     * Estimate true probability from momentum data
     * When BTC moves +0.3% in 2 minutes, the 15-min "Up" probability
     * is much higher than 50% — more like 70-85%
     */
    _estimateProbability(momentum) {
        const absChange = Math.abs(momentum.changePercent);

        // Rough mapping: momentum → implied probability (in cents)
        // These are conservative estimates
        if (absChange >= 0.5) return 85;       // Very strong move → 85%
        if (absChange >= 0.3) return 75;       // Strong move → 75%
        if (absChange >= 0.2) return 68;       // Moderate move → 68%
        if (absChange >= 0.15) return 62;      // Mild move → 62%
        return 55;                             // Weak → barely worth it
    }

    _isShortTermCrypto(question, endDate) {
        const q = question.toLowerCase();
        const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol'];
        const hasCrypto = cryptoKeywords.some(k => q.includes(k));
        if (!hasCrypto) return false;

        // Must be an "up or down" or "above" style market
        const isDirectional = q.includes('up or down') || q.includes('above') || q.includes('below');
        if (!isDirectional) return false;

        // Check if market resolves within 4 hours (covers 15-min, hourly, and near-term)
        if (endDate) {
            const timeLeft = new Date(endDate) - Date.now();
            if (timeLeft <= 0) return false;           // Already expired
            if (timeLeft > 4 * 60 * 60 * 1000) return false; // More than 4 hours out
        }

        return true;
    }

    _extractTicker(question) {
        const q = question.toLowerCase();
        if (q.includes('bitcoin') || q.includes('btc')) return 'BTC';
        if (q.includes('ethereum') || q.includes('eth')) return 'ETH';
        if (q.includes('solana') || q.includes('sol')) return 'SOL';
        return null;
    }

    _extractDirection(question) {
        const q = question.toLowerCase();
        if (q.includes('up or down')) return 'up_or_down';
        if (q.includes('above')) return 'above';
        if (q.includes('below')) return 'below';
        return 'up_or_down';
    }

    getStats() {
        return {
            ...this.stats,
            activeMarkets: this.activeMarkets.length,
            binanceConnected: this.binance.connected,
            chainlinkConnected: this.chainlink?.connected || false,
            binanceSnapshot: this.binance.getSnapshot(),
            chainlinkSnapshot: this.chainlink?.getSnapshot() || null,
        };
    }

    stop() {
        if (this.scanInterval) clearInterval(this.scanInterval);
        if (this.evalInterval) clearInterval(this.evalInterval);
        console.log('[CRYPTO-SPEED] Stopped');
    }
}

export default CryptoSpeedStrategy;
