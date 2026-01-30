/**
 * Crypto Speed Strategy — 15-Minute Markets
 * 
 * THE EDGE: Polymarket's 15-min BTC/ETH/SOL up/down markets lag
 * behind real-time exchange prices by 1-2 minutes. When spot price
 * is clearly trending (e.g., BTC up +0.3% in last 2 min), the
 * Polymarket market still shows ~50/50 odds.
 * 
 * We buy the correct direction at a discount and hold to resolution.
 * 
 * One bot did $313 → $414,000 in a month with 98% win rate using this.
 */

import { EventEmitter } from 'events';

const POLY_GAMMA = 'https://gamma-api.polymarket.com';

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

export class CryptoSpeedStrategy extends EventEmitter {
    constructor(binanceFeed, paperTrader, config = {}) {
        super();
        this.binance = binanceFeed;
        this.trader = paperTrader;
        this.config = { ...THRESHOLDS, ...config };
        
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
        this.evalInterval = setInterval(() => this.evaluate(), 5000);
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
     */
    evaluate() {
        if (this.activeMarkets.length === 0) return;
        this.stats.evaluations++;

        for (const market of this.activeMarkets) {
            // Skip if recently traded
            const lastTrade = this.lastTrade.get(market.id) || 0;
            if (Date.now() - lastTrade < this.config.tradeCooldownMs) continue;

            // Skip expired markets
            if (market.endDate && new Date(market.endDate) <= Date.now()) continue;

            // Get Binance momentum
            const momentum = this.binance.getMomentum(market.ticker, 2 * 60 * 1000);  // 2-min window
            if (!momentum || momentum.direction === 'flat') continue;
            if (Math.abs(momentum.changePercent) < this.config.minChangePercent) continue;
            if (momentum.strength < this.config.minStrength) continue;
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

            // Estimate true probability from momentum
            const estimatedProb = this._estimateProbability(momentum);
            const edge = estimatedProb - buyPrice;

            if (edge < this.config.minEdge) continue;

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
                timeLeft: market.endDate ? `${Math.round((new Date(market.endDate) - Date.now()) / 60000)}m` : '?',
            };

            console.log(`\n🚀 [CRYPTO-SPEED] SIGNAL: ${signal.ticker} ${signal.side} @ ${signal.buyPrice}¢`);
            console.log(`   Momentum: ${signal.momentum} | Strength: ${signal.strength}`);
            console.log(`   Est. prob: ${signal.estimatedProb}¢ | Edge: ${signal.edge}¢ | Time: ${signal.timeLeft}`);

            this.emit('signal', signal);

            // Execute paper trade
            const trade = this._executeTrade(market, buyYes, buyPrice, edge, momentum);
            if (trade) {
                this.lastTrade.set(market.id, Date.now());
                this.stats.trades++;
                console.log(`   ✅ TRADE ENTERED: ${trade.contracts} contracts @ ${buyPrice}¢`);
            }
        }
    }

    _executeTrade(market, buyYes, buyPrice, edge, momentum) {
        // Build an opportunity object compatible with PaperTrader
        // For single-platform trades, we model it as: buy one side, hold to resolution
        // Expected value = estimatedProb * 100¢ (if we're right) 
        const opportunity = {
            name: `⚡${market.ticker} ${buyYes ? 'UP' : 'DOWN'} (15m speed)`,
            strategy: buyYes ? 1 : 2,
            polyYes: buyYes ? buyPrice : (100 - buyPrice),
            polyNo: buyYes ? (100 - buyPrice) : buyPrice,
            // For single-platform, we use the complementary side as "kalshi" 
            // This is a hack to reuse PaperTrader — the "cost" is just the buy price
            kalshiYes: 0,
            kalshiNo: 0,
            expiresAt: market.endDate,
        };

        // Direct execution: deduct buy price, expect payout if correct
        // We override the standard arb logic since this isn't cross-platform
        const contracts = 10;  // $10 worth
        const totalCost = buyPrice * contracts;

        if (totalCost > this.trader.state.polyBalance) return null;

        this.trader.state.polyBalance -= totalCost;
        this.trader.state.totalTrades++;

        const position = {
            id: `cs-${Date.now()}`,
            name: opportunity.name,
            strategy: opportunity.strategy,
            polySide: buyYes ? 'YES' : 'NO',
            kalshiSide: 'N/A',
            polyPrice: buyPrice,
            kalshiPrice: 0,
            contracts,
            totalCost,
            grossSpread: edge * contracts,
            fees: buyPrice * 0.02 * contracts,  // ~2% Polymarket fee
            expectedNetProfit: (edge - buyPrice * 0.02) * contracts,
            expiresAt: market.endDate,
            entryTime: new Date().toISOString(),
            entryTimestamp: Date.now(),
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
            binanceSnapshot: this.binance.getSnapshot(),
        };
    }

    stop() {
        if (this.scanInterval) clearInterval(this.scanInterval);
        if (this.evalInterval) clearInterval(this.evalInterval);
        console.log('[CRYPTO-SPEED] Stopped');
    }
}

export default CryptoSpeedStrategy;
