/**
 * BTC 15-Minute Same-Market Arbitrage ("Gabagool" Strategy)
 * 
 * Pure arbitrage: Buy BOTH UP and DOWN on Polymarket's 15-min BTC/ETH/SOL
 * markets when their combined cost is less than $1.00 (minus fees).
 * 
 * At resolution, exactly ONE side pays $1.00 per share. Since you hold both,
 * you always receive $1.00 per pair regardless of outcome.
 * 
 * HOW IT WORKS:
 * 1. Discover active 15-min crypto markets (slug: btc-updown-15m-{timestamp})
 * 2. Fetch the CLOB order book for BOTH the UP and DOWN tokens
 * 3. Walk the ask side to compute actual executable cost for desired order size
 * 4. If UP_cost + DOWN_cost < $1.00 - fees → execute both legs
 * 5. Auto-rotate to next market when current one expires
 * 
 * Reference: https://github.com/gabagool222/15min-btc-polymarket-trading-bot
 */

import { EventEmitter } from 'events';

const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const POLY_CLOB = 'https://clob.polymarket.com';
const BTC_15M_WINDOW = 900; // 15 minutes in seconds

// Slug patterns for 15-min crypto markets
const SLUG_PATTERNS = {
    BTC: /^btc-updown-15m-(\d+)$/,
    ETH: /^eth-updown-15m-(\d+)$/,
    SOL: /^sol-updown-15m-(\d+)$/,
};

// ─── Order Book Helpers ─────────────────────────────────────────

/**
 * Fetch the CLOB order book for a given token
 * @param {string} tokenId - Polymarket CLOB token ID
 * @returns {Promise<{ bids: Array, asks: Array }>}
 */
async function fetchOrderBook(tokenId) {
    const url = `${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CLOB book error: ${res.status}`);
    return res.json();
}

/**
 * Walk the ask side of an order book to compute the actual fill cost.
 * This is the core of the gabagool strategy — you need the REAL price,
 * not the indicative mid-price.
 * 
 * @param {Array<{price: string|number, size: string|number}>} asks - Ask levels
 * @param {number} targetSize - Number of shares to buy
 * @returns {{ totalCost: number, vwap: number, worstPrice: number, bestPrice: number, filled: number } | null}
 */
export function computeBuyFill(asks, targetSize) {
    if (!asks || asks.length === 0 || targetSize <= 0) return null;

    // Parse and sort asks from cheapest to most expensive
    const sortedAsks = asks
        .map(l => ({
            price: typeof l.price === 'string' ? parseFloat(l.price) : l.price,
            size: typeof l.size === 'string' ? parseFloat(l.size) : l.size,
        }))
        .filter(l => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0 && l.price > 0)
        .sort((a, b) => a.price - b.price);

    if (sortedAsks.length === 0) return null;

    let remaining = targetSize;
    let totalCost = 0;
    let worstPrice = null;
    const bestPrice = sortedAsks[0].price;

    for (const level of sortedAsks) {
        if (remaining <= 0) break;
        const fill = Math.min(remaining, level.size);
        totalCost += fill * level.price;
        remaining -= fill;
        worstPrice = level.price;
    }

    if (remaining > 0) return null; // Not enough liquidity

    const vwap = totalCost / targetSize;
    return { totalCost, vwap, worstPrice, bestPrice, filled: targetSize };
}

/**
 * Calculate Polymarket taker fee for 15-min crypto markets.
 * Formula: shares × price × 0.25 × (price × (1 - price))²
 * 
 * At 50/50 odds (p=0.50): fee ≈ 0.78% per share
 * For a pair (UP+DOWN): total fee ≈ 1.5-1.6¢
 * 
 * @param {number} price - Price in decimal (0-1), e.g. 0.48
 * @param {number} shares - Number of shares
 * @returns {number} Fee in dollars
 */
export function calcTakerFee(price, shares = 1) {
    if (price <= 0 || price >= 1) return 0;
    const feePerShare = price * 0.25 * Math.pow(price * (1 - price), 2);
    return feePerShare * shares;
}

/**
 * Calculate total pair arb profitability.
 * 
 * @param {number} upCostPerShare - Cost per share for UP side (0-1 dollars)
 * @param {number} downCostPerShare - Cost per share for DOWN side (0-1 dollars)
 * @param {number} shares - Shares per leg
 * @returns {{ pairCost, grossProfit, upFee, downFee, totalFees, netProfit, profitPerShare, isProfitable }}
 */
export function calcPairArb(upCostPerShare, downCostPerShare, shares) {
    const pairCost = upCostPerShare + downCostPerShare;
    const grossProfit = (1.0 - pairCost) * shares;
    
    const upFee = calcTakerFee(upCostPerShare, shares);
    const downFee = calcTakerFee(downCostPerShare, shares);
    const totalFees = upFee + downFee;
    
    const netProfit = grossProfit - totalFees;
    const profitPerShare = shares > 0 ? netProfit / shares : 0;
    
    return {
        pairCost,
        grossProfit,
        upFee,
        downFee,
        totalFees,
        netProfit,
        profitPerShare,
        isProfitable: netProfit > 0,
    };
}

// ─── Market Discovery ───────────────────────────────────────────

/**
 * Discover active 15-min crypto markets via Gamma API.
 * Looks for markets with slugs matching the btc/eth/sol-updown-15m-{timestamp} pattern.
 * 
 * @param {string[]} tickers - Which tickers to look for ['BTC', 'ETH', 'SOL']
 * @returns {Promise<Array<{ slug, ticker, startTs, endTs, yesTokenId, noTokenId, conditionId, question }>>}
 */
async function discoverMarketsFromGamma(tickers = ['BTC', 'ETH', 'SOL']) {
    const nowTs = Math.floor(Date.now() / 1000);
    const markets = [];

    try {
        // Fetch open markets from Gamma API
        const res = await fetch(
            `${POLY_GAMMA}/markets?closed=false&active=true&limit=500`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) return markets;

        for (const m of data) {
            const slug = (m.slug || '').trim();
            
            for (const ticker of tickers) {
                const pattern = SLUG_PATTERNS[ticker];
                if (!pattern) continue;
                
                const match = pattern.exec(slug);
                if (!match) continue;
                
                const startTs = parseInt(match[1], 10);
                const endTs = startTs + BTC_15M_WINDOW;
                
                // Only include markets that are still open
                if (nowTs >= endTs) continue;
                
                let tokenIds = m.clobTokenIds;
                if (typeof tokenIds === 'string') {
                    try { tokenIds = JSON.parse(tokenIds); } catch (e) { continue; }
                }
                if (!Array.isArray(tokenIds) || tokenIds.length < 2) continue;
                
                markets.push({
                    slug,
                    ticker,
                    startTs,
                    endTs,
                    yesTokenId: tokenIds[0],  // UP token
                    noTokenId: tokenIds[1],   // DOWN token
                    conditionId: m.conditionId || m.id,
                    question: m.question || m.groupItemTitle || slug,
                    volume: parseFloat(m.volume || 0),
                });
            }
        }
    } catch (e) {
        console.error('[BTC-15MIN-ARB] Gamma API discovery failed:', e.message);
    }

    // Sort by endTs (soonest to resolve first) then by volume (most liquid)
    markets.sort((a, b) => a.endTs - b.endTs || b.volume - a.volume);
    return markets;
}

/**
 * Try computed slugs for current and upcoming 15-min windows.
 * This is a fallback when Gamma API doesn't return the markets fast enough.
 * 
 * @param {string} ticker - 'BTC', 'ETH', or 'SOL'
 * @returns {string[]} Array of possible slugs to check
 */
function computePossibleSlugs(ticker = 'BTC') {
    const prefix = ticker.toLowerCase();
    const nowTs = Math.floor(Date.now() / 1000);
    const slugs = [];
    
    // Check current window + next 6 windows (covering next ~1.5 hours)
    for (let i = -1; i <= 6; i++) {
        const ts = nowTs + (i * BTC_15M_WINDOW);
        const tsRounded = Math.floor(ts / BTC_15M_WINDOW) * BTC_15M_WINDOW;
        // Only include if window hasn't ended
        if (nowTs < tsRounded + BTC_15M_WINDOW) {
            slugs.push(`${prefix}-updown-15m-${tsRounded}`);
        }
    }
    
    // Deduplicate
    return [...new Set(slugs)];
}

// ─── Main Strategy Class ────────────────────────────────────────

export class Btc15minArb extends EventEmitter {
    /**
     * @param {import('./paper-trader.js').PaperTrader} paperTrader
     * @param {object} config
     */
    constructor(paperTrader, config = {}) {
        super();
        this.trader = paperTrader;
        this.config = {
            targetPairCost: config.btc15minTargetPairCost ?? 0.97,
            orderSize: config.btc15minOrderSize ?? 10,
            scanIntervalMs: config.btc15minScanIntervalMs ?? 5000,
            marketRefreshMs: config.btc15minMarketRefreshMs ?? 60000,
            tickers: config.btc15minTickers ?? ['BTC', 'ETH', 'SOL'],
            maxPositionsPerMarket: config.btc15minMaxPositionsPerMarket ?? 3,
            minTimeRemainingMs: config.btc15minMinTimeRemainingMs ?? 30_000,  // Don't trade < 30s to expiry
            cooldownMs: config.btc15minCooldownMs ?? 10_000,  // 10s between trades on same market
        };

        // Active 15-min markets: slug -> market info
        this.activeMarkets = new Map();

        // Track last trade time per market (for cooldown)
        this.lastTradeTime = new Map();

        // Positions in current markets (for max position tracking)
        this.marketPositions = new Map();  // slug -> count

        // Intervals
        this.scanInterval = null;
        this.marketRefreshInterval = null;

        // Stats
        this.stats = {
            scans: 0,
            marketsActive: 0,
            marketsDiscovered: 0,
            opportunities: 0,
            trades: 0,
            totalGrossProfit: 0,    // in dollars
            totalFees: 0,           // in dollars
            totalNetProfit: 0,      // in dollars
            totalInvested: 0,       // in dollars
            bookFetches: 0,
            bookFailures: 0,
            noLiquidity: 0,
            aboveThreshold: 0,
            belowMinTime: 0,
            oneLegFails: 0,         // CRITICAL: partial fill situations
            lastOpportunity: null,
        };
    }

    async start() {
        console.log('[BTC-15MIN-ARB] 🎯 Starting Gabagool strategy...');
        console.log(`[BTC-15MIN-ARB] Config: targetPairCost=$${this.config.targetPairCost} | orderSize=${this.config.orderSize} shares | scan=${this.config.scanIntervalMs / 1000}s`);
        console.log(`[BTC-15MIN-ARB] Tickers: ${this.config.tickers.join(', ')} | Cooldown: ${this.config.cooldownMs / 1000}s | Min time: ${this.config.minTimeRemainingMs / 1000}s`);

        // Initial market discovery
        await this.discoverMarkets();

        // Re-discover markets periodically (they cycle every 15 min)
        this.marketRefreshInterval = setInterval(
            () => this.discoverMarkets().catch(e => console.error('[BTC-15MIN-ARB] Discovery error:', e.message)),
            this.config.marketRefreshMs
        );

        // Scan order books every N seconds
        this.scanInterval = setInterval(
            () => this.scan().catch(e => console.error('[BTC-15MIN-ARB] Scan error:', e.message)),
            this.config.scanIntervalMs
        );

        // Initial scan
        await this.scan();
    }

    /**
     * Discover active 15-min crypto markets from Gamma API
     */
    async discoverMarkets() {
        try {
            const markets = await discoverMarketsFromGamma(this.config.tickers);

            // Remove expired markets
            const nowTs = Math.floor(Date.now() / 1000);
            for (const [slug, market] of this.activeMarkets) {
                if (nowTs >= market.endTs) {
                    this.activeMarkets.delete(slug);
                    this.marketPositions.delete(slug);
                    this.lastTradeTime.delete(slug);
                }
            }

            // Add newly discovered markets
            let newCount = 0;
            for (const m of markets) {
                if (!this.activeMarkets.has(m.slug)) {
                    this.activeMarkets.set(m.slug, m);
                    newCount++;
                }
            }

            this.stats.marketsActive = this.activeMarkets.size;
            this.stats.marketsDiscovered += newCount;

            if (this.activeMarkets.size > 0) {
                const mList = [...this.activeMarkets.values()];
                console.log(`[BTC-15MIN-ARB] 📡 ${this.activeMarkets.size} active markets (${newCount} new):`);
                for (const m of mList.slice(0, 5)) {
                    const timeLeft = Math.max(0, m.endTs - nowTs);
                    const min = Math.floor(timeLeft / 60);
                    const sec = timeLeft % 60;
                    console.log(`  ${m.ticker} | ${m.slug} | ${min}m${sec}s remaining`);
                }
                if (mList.length > 5) console.log(`  ... and ${mList.length - 5} more`);
            } else {
                console.log('[BTC-15MIN-ARB] No active 15-min crypto markets found (markets appear during US trading hours)');
            }
        } catch (e) {
            console.error('[BTC-15MIN-ARB] Discovery error:', e.message);
        }
    }

    /**
     * Main scan loop: For each active market, fetch order books and check for arb.
     */
    async scan() {
        if (this.activeMarkets.size === 0) return;
        this.stats.scans++;

        const nowTs = Math.floor(Date.now() / 1000);
        const nowMs = Date.now();

        for (const [slug, market] of this.activeMarkets) {
            // Skip expired markets
            if (nowTs >= market.endTs) {
                this.activeMarkets.delete(slug);
                continue;
            }

            // Skip if not enough time remaining (too risky near expiry)
            const timeRemainingMs = (market.endTs - nowTs) * 1000;
            if (timeRemainingMs < this.config.minTimeRemainingMs) {
                this.stats.belowMinTime++;
                continue;
            }

            // Skip if on cooldown
            const lastTrade = this.lastTradeTime.get(slug) || 0;
            if (nowMs - lastTrade < this.config.cooldownMs) continue;

            // Skip if max positions reached for this market
            const posCount = this.marketPositions.get(slug) || 0;
            if (posCount >= this.config.maxPositionsPerMarket) continue;

            // Fetch order books for BOTH tokens
            let upBook, downBook;
            try {
                this.stats.bookFetches += 2;
                // Fetch in parallel for speed
                [upBook, downBook] = await Promise.all([
                    fetchOrderBook(market.yesTokenId),
                    fetchOrderBook(market.noTokenId),
                ]);
            } catch (e) {
                this.stats.bookFailures++;
                continue;
            }

            // Walk the ask side to get actual fill prices
            const upFill = computeBuyFill(upBook.asks, this.config.orderSize);
            const downFill = computeBuyFill(downBook.asks, this.config.orderSize);

            if (!upFill || !downFill) {
                this.stats.noLiquidity++;
                continue;
            }

            // Calculate pair cost and profitability
            const arb = calcPairArb(upFill.vwap, downFill.vwap, this.config.orderSize);

            // Check if profitable
            if (arb.pairCost > this.config.targetPairCost) {
                this.stats.aboveThreshold++;
                continue;
            }

            if (!arb.isProfitable) {
                // Above threshold but fees eat the profit
                this.stats.aboveThreshold++;
                continue;
            }

            // 🎯 ARBITRAGE OPPORTUNITY FOUND
            this.stats.opportunities++;
            const timeLeft = Math.max(0, market.endTs - nowTs);
            const min = Math.floor(timeLeft / 60);
            const sec = timeLeft % 60;

            const opportunityInfo = {
                slug: market.slug,
                ticker: market.ticker,
                question: market.question,
                upVwap: upFill.vwap,
                downVwap: downFill.vwap,
                upWorstPrice: upFill.worstPrice,
                downWorstPrice: downFill.worstPrice,
                pairCost: arb.pairCost,
                grossProfit: arb.grossProfit,
                totalFees: arb.totalFees,
                netProfit: arb.netProfit,
                profitPerShare: arb.profitPerShare,
                shares: this.config.orderSize,
                timeRemaining: `${min}m${sec}s`,
                timestamp: new Date().toISOString(),
            };

            this.stats.lastOpportunity = opportunityInfo;

            console.log(`\n💰 [BTC-15MIN-ARB] OPPORTUNITY: ${market.ticker} | ${market.slug}`);
            console.log(`   UP: $${upFill.vwap.toFixed(4)} (worst: $${upFill.worstPrice.toFixed(4)}) | DOWN: $${downFill.vwap.toFixed(4)} (worst: $${downFill.worstPrice.toFixed(4)})`);
            console.log(`   Pair cost: $${arb.pairCost.toFixed(4)} | Gross: $${arb.grossProfit.toFixed(4)} | Fees: $${arb.totalFees.toFixed(4)} | Net: $${arb.netProfit.toFixed(4)}`);
            console.log(`   Time left: ${min}m${sec}s | Shares: ${this.config.orderSize}`);

            this.emit('opportunity', opportunityInfo);

            // Execute the trade
            const trade = this._executePaperTrade(market, upFill, downFill, arb);
            if (trade) {
                this.lastTradeTime.set(slug, Date.now());
                this.marketPositions.set(slug, posCount + 1);
                this.stats.trades++;
                this.stats.totalGrossProfit += arb.grossProfit;
                this.stats.totalFees += arb.totalFees;
                this.stats.totalNetProfit += arb.netProfit;
                this.stats.totalInvested += arb.pairCost * this.config.orderSize;
                
                console.log(`   ✅ TRADE EXECUTED: ${this.config.orderSize} pairs @ $${arb.pairCost.toFixed(4)} | Net profit: $${arb.netProfit.toFixed(4)}`);
                this.emit('trade', trade);
            }
        }
    }

    /**
     * Execute a paper trade: deduct cost, record position, expect payout at resolution.
     */
    _executePaperTrade(market, upFill, downFill, arb) {
        // Check for existing position with same name
        const posName = `🎯 ${market.ticker} 15m Arb (${market.slug})`;
        const existing = this.trader.state?.positions?.find(p => p.name === posName);
        if (existing) return null;

        // Check position limit
        const arbPositions = (this.trader.state?.positions || []).filter(p => p.name?.startsWith('🎯')).length;
        if (arbPositions >= 10) return null;

        // Calculate costs in cents (paper trader uses cents internally)
        const totalCostCents = arb.pairCost * this.config.orderSize * 100;  // Convert to cents
        const feesCents = arb.totalFees * 100;
        const netProfitCents = arb.netProfit * 100;

        // Check balance (need funds on Poly side)
        if (totalCostCents > (this.trader.state?.polyBalance ?? 0)) {
            return null;
        }

        // Deduct cost
        this.trader.state.polyBalance -= totalCostCents;
        this.trader.state.totalTrades = (this.trader.state.totalTrades || 0) + 1;

        const position = {
            id: `g15-${Date.now()}`,
            name: posName,
            strategy: 5,  // 5 = 15-min same-market arb (gabagool)
            polySide: 'YES+NO',
            kalshiSide: 'N/A',
            polyPrice: upFill.vwap * 100,   // UP price in cents
            kalshiPrice: downFill.vwap * 100, // DOWN price in cents (stored in kalshiPrice for display)
            contracts: this.config.orderSize,
            totalCost: totalCostCents,
            grossSpread: (1 - arb.pairCost) * 100,  // in cents per pair
            fees: feesCents,
            expectedNetProfit: netProfitCents,
            expiresAt: new Date(market.endTs * 1000).toISOString(),
            entryTime: new Date().toISOString(),
            entryTimestamp: Date.now(),
            // Extra data for this strategy
            marketSlug: market.slug,
            ticker: market.ticker,
            upVwap: upFill.vwap,
            downVwap: downFill.vwap,
            upWorstPrice: upFill.worstPrice,
            downWorstPrice: downFill.worstPrice,
            pairCost: arb.pairCost,
        };

        // Record position
        if (this.trader.state.positions) {
            this.trader.state.positions.push(position);
        }
        if (this.trader.trades) {
            this.trader.trades.push({ ...position, type: 'ENTRY', timestamp: new Date().toISOString() });
        }

        // Persist
        if (typeof this.trader.save === 'function') {
            this.trader.save();
        }

        return position;
    }

    /**
     * Get current stats for dashboard/logging
     */
    getStats() {
        return {
            ...this.stats,
            activeMarkets: this.activeMarkets.size,
            config: {
                targetPairCost: this.config.targetPairCost,
                orderSize: this.config.orderSize,
                tickers: this.config.tickers,
            },
        };
    }

    /**
     * Get list of active markets for display
     */
    getActiveMarkets() {
        const nowTs = Math.floor(Date.now() / 1000);
        return [...this.activeMarkets.values()].map(m => ({
            slug: m.slug,
            ticker: m.ticker,
            question: m.question,
            timeRemaining: Math.max(0, m.endTs - nowTs),
            positions: this.marketPositions.get(m.slug) || 0,
        }));
    }

    stop() {
        if (this.scanInterval) clearInterval(this.scanInterval);
        if (this.marketRefreshInterval) clearInterval(this.marketRefreshInterval);
        console.log('[BTC-15MIN-ARB] Stopped');
    }
}

export default Btc15minArb;
