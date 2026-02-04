/**
 * Crypto Speed Strategy — Short-Term Crypto Markets
 * 
 * THE EDGE: Polymarket's crypto directional markets (15-min, hourly, daily
 * "above $X" / "up or down") lag behind real-time exchange prices.
 * When Binance spot price is clearly trending, the Polymarket market
 * still shows stale odds — we buy the correct direction at a discount.
 * 
 * MARKET TYPES (all supported):
 * - 15-min "Up or Down" markets (highest edge, fastest resolution)
 * - Hourly "above $X" markets
 * - Daily "Bitcoin above $82,000 on February 4?" markets
 * 
 * Time-weighted thresholds: longer-duration markets require stronger
 * momentum signals (bigger moves, higher strength) since there's more
 * time for reversals. The edge decays with time remaining.
 * 
 * Enabled by default alongside cross-platform arb.
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

// ── Duration Classes ────────────────────────────────────
// Markets are bucketed by total duration, which determines how much
// momentum is needed to trigger a trade. A 15-min market can be
// confidently read from a 2-min trend; a daily market needs a
// much stronger and sustained move to overcome mean-reversion risk.

const DURATION_CLASSES = {
    INTRADAY_15M: {
        maxTotalMinutes: 20,       // 15-min markets
        momentumWindowMs: 2 * 60 * 1000,   // 2-min momentum
        minChangePercent: 0.15,
        maxBuyPrice: 68,
        minEdge: 8,
        minStrength: 0.25,
        timeDecayBase: 15,         // full window for decay calc
    },
    INTRADAY_HOURLY: {
        maxTotalMinutes: 90,       // ~1-hour markets
        momentumWindowMs: 5 * 60 * 1000,   // 5-min momentum
        minChangePercent: 0.25,
        maxBuyPrice: 65,
        minEdge: 12,
        minStrength: 0.35,
        timeDecayBase: 60,
    },
    DAILY: {
        maxTotalMinutes: 24 * 60,  // daily markets (up to 24h)
        momentumWindowMs: 10 * 60 * 1000,  // 10-min momentum
        minChangePercent: 0.40,    // need bigger move for daily
        maxBuyPrice: 60,           // stricter — more time for reversal
        minEdge: 15,               // more edge required
        minStrength: 0.45,         // stronger signal required
        timeDecayBase: 60 * 8,     // 8-hour decay window (trading session)
    },
};

// Time-weighted edge thresholds WITHIN a duration class
// As a market approaches expiry, require MORE edge (less time to be right)
const TIME_PHASES = {
    EARLY:  { minMinutes: 10, edgeMultiplier: 1.0, strengthMultiplier: 1.0 },  // >10 min left
    MID:    { minMinutes: 5,  edgeMultiplier: 1.5, strengthMultiplier: 1.4 },  // 5-10 min left
    LATE:   { minMinutes: 0,  edgeMultiplier: 2.2, strengthMultiplier: 2.0 },  // <5 min left
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
        console.log('[CRYPTO-SPEED] Starting crypto speed strategy (15m / hourly / daily)...');
        console.log(`[CRYPTO-SPEED] Base thresholds: ${this.config.minChangePercent}% move, strength>${this.config.minStrength}, maxBuy=${this.config.maxBuyPrice}¢`);
        console.log(`[CRYPTO-SPEED] Duration classes: 15m (≤20min), hourly (≤90min), daily (≤24h)`);

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
     * Duration-aware: 15-min markets use 2-min momentum with loose thresholds,
     * daily markets use 10-min momentum with strict thresholds (more reversal risk).
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

            // Calculate remaining time
            const remainingMs = market.endDate ? new Date(market.endDate) - Date.now() : Infinity;
            const remainingMin = remainingMs / 60000;

            // ── Determine duration class ────────────────────
            const durClass = this._getDurationClass(market);
            const phase = this._getTimePhase(remainingMin);

            // Duration-class-specific thresholds
            const effectiveMinChange = durClass.minChangePercent;
            const effectiveMaxBuy = durClass.maxBuyPrice;
            const effectiveMinEdge = durClass.minEdge * phase.edgeMultiplier;
            const effectiveMinStrength = durClass.minStrength * phase.strengthMultiplier;

            // Get Binance momentum with duration-appropriate window
            const momentum = this.binance.getMomentum(market.ticker, durClass.momentumWindowMs);
            if (!momentum || momentum.direction === 'flat') continue;
            if (Math.abs(momentum.changePercent) < effectiveMinChange) continue;

            // Duration-weighted strength threshold
            if (momentum.strength < effectiveMinStrength) {
                this.stats.skippedByTimePhase++;
                continue;
            }
            if (momentum.confidence < this.config.minConfidence) continue;

            // Determine which side to buy based on market type and momentum
            let buyYes = false;
            if (market.direction === 'up_or_down') {
                buyYes = momentum.direction === 'up';
            } else if (market.direction === 'above') {
                buyYes = momentum.direction === 'up';
            } else {
                buyYes = momentum.direction === 'up';
            }

            // Get the price we'd buy at
            const buyPrice = buyYes ? market.currentYes : market.currentNo;
            if (buyPrice === null || buyPrice <= 0) continue;

            // Is it cheap enough? (duration-class sets the ceiling)
            if (buyPrice > effectiveMaxBuy) continue;

            // Skip dust markets — prices below 1¢ have no real liquidity
            if (buyPrice < 1) continue;

            // Estimate true probability from momentum — apply time decay
            const rawProb = this._estimateProbability(momentum, durClass);
            const estimatedProb = this._applyTimeDecay(rawProb, remainingMin, durClass);
            const edge = estimatedProb - buyPrice;

            // Duration-weighted edge threshold
            if (edge < effectiveMinEdge) {
                this.stats.skippedByTimePhase++;
                continue;
            }

            // Prevent duplicate positions for same ticker+direction+market
            const durLabel = market.durationClass || '15m';
            const posName = `⚡${market.ticker} ${buyYes ? 'UP' : 'DOWN'} (${durLabel} speed)`;
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
                durationClass: durLabel,
            };

            console.log(`\n🚀 [CRYPTO-SPEED] SIGNAL: ${signal.ticker} ${signal.side} @ ${signal.buyPrice}¢ [${durLabel}/${phase.name}]`);
            console.log(`   Momentum: ${signal.momentum} | Strength: ${signal.strength}`);
            console.log(`   Est. prob: ${signal.estimatedProb}¢ | Edge: ${signal.edge}¢ | Time: ${signal.timeLeft} | minEdge=${effectiveMinEdge.toFixed(0)}¢ minStr=${effectiveMinStrength.toFixed(2)}`);

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
     * Classify a market into a duration bucket based on its total lifespan.
     * Stores the result on the market object for reuse.
     */
    _getDurationClass(market) {
        if (market._durClass) return market._durClass;

        const totalMin = market.endDate
            ? (new Date(market.endDate) - Date.now()) / 60000
            : Infinity;

        let dc;
        if (totalMin <= DURATION_CLASSES.INTRADAY_15M.maxTotalMinutes) {
            dc = DURATION_CLASSES.INTRADAY_15M;
            market.durationClass = '15m';
        } else if (totalMin <= DURATION_CLASSES.INTRADAY_HOURLY.maxTotalMinutes) {
            dc = DURATION_CLASSES.INTRADAY_HOURLY;
            market.durationClass = '1h';
        } else {
            dc = DURATION_CLASSES.DAILY;
            market.durationClass = 'daily';
        }
        market._durClass = dc;
        return dc;
    }

    /**
     * Determine time phase based on remaining minutes.
     * Returns multipliers applied on top of the duration class base thresholds.
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
     * Decay estimated probability toward 50% as time runs out.
     * Uses the duration class's time base so a daily market doesn't
     * instantly decay to 50 the way a 15-min market does.
     */
    _applyTimeDecay(rawProb, remainingMin, durClass) {
        const maxWindow = (durClass && durClass.timeDecayBase) || 15;
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
        const durLabel = market.durationClass || '15m';
        const opportunity = {
            name: `⚡${market.ticker} ${buyYes ? 'UP' : 'DOWN'} (${durLabel} speed)`,
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
     * Estimate true probability from momentum data.
     * 
     * For 15-min markets a 0.3% move is very strong signal.
     * For daily markets the same 0.3% is noise — need 0.5%+ to be meaningful.
     * The duration class's minChangePercent already gates entry; this
     * function converts the magnitude above that floor into a probability.
     */
    _estimateProbability(momentum, durClass) {
        const absChange = Math.abs(momentum.changePercent);

        if (durClass === DURATION_CLASSES.DAILY) {
            // Daily markets: more conservative — reversals are common
            if (absChange >= 1.0) return 78;       // Very strong sustained move
            if (absChange >= 0.7) return 72;       // Strong move
            if (absChange >= 0.5) return 66;       // Moderate move
            if (absChange >= 0.4) return 62;       // Mild but meaningful
            return 57;
        } else if (durClass === DURATION_CLASSES.INTRADAY_HOURLY) {
            // Hourly markets: moderate confidence
            if (absChange >= 0.6) return 80;
            if (absChange >= 0.4) return 73;
            if (absChange >= 0.25) return 65;
            return 58;
        } else {
            // 15-min markets: highest confidence — momentum carries
            if (absChange >= 0.5) return 85;
            if (absChange >= 0.3) return 75;
            if (absChange >= 0.2) return 68;
            if (absChange >= 0.15) return 62;
            return 55;
        }
    }

    _isShortTermCrypto(question, endDate) {
        const q = question.toLowerCase();
        const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol'];
        const hasCrypto = cryptoKeywords.some(k => q.includes(k));
        if (!hasCrypto) return false;

        // Must be an "up or down" or "above" style market
        const isDirectional = q.includes('up or down') || q.includes('above') || q.includes('below');
        if (!isDirectional) return false;

        // Accept markets resolving within 24 hours:
        // - 15-min "up or down" markets (appear during US trading hours)
        // - Hourly crypto markets
        // - Daily "Bitcoin above $X on <date>?" markets (always available)
        if (endDate) {
            const timeLeft = new Date(endDate) - Date.now();
            if (timeLeft <= 0) return false;                      // Already expired
            if (timeLeft > 24 * 60 * 60 * 1000) return false;    // More than 24 hours out
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
