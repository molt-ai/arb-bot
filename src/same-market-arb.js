/**
 * Same-Market Rebalancing Arbitrage
 * 
 * Scans a single platform for markets where YES + NO < $1.00.
 * This is pure risk-free arb — buy both sides, guaranteed profit at resolution.
 * 
 * Windows typically last ~200ms on liquid markets, but illiquid markets
 * can hold mispricings for minutes.
 */

const POLY_GAMMA = 'https://gamma-api.polymarket.com';

export class SameMarketArb {
    constructor(paperTrader, config = {}) {
        this.trader = paperTrader;
        this.config = {
            minProfitCents: config.minProfitCents || 1.0,  // At least 1¢ per contract
            maxMarkets: config.maxMarkets || 200,           // Markets to scan per pass
            scanIntervalMs: config.scanIntervalMs || 15000, // Scan every 15s
            minVolume: config.minVolume || 1000,            // Min $1000 volume (liquidity filter)
            minPrice: config.minPrice || 3,                 // Skip prices ≤ 3¢ (no liquidity)
            ...config,
        };

        this.scanInterval = null;
        this.opportunities = [];
        this.stats = {
            scans: 0,
            found: 0,
            trades: 0,
        };
    }

    async start() {
        console.log('[SAME-MARKET] Starting single-platform rebalancing arb...');
        console.log(`[SAME-MARKET] Min profit: ${this.config.minProfitCents}¢ | Scan every ${this.config.scanIntervalMs / 1000}s`);

        await this.scan();
        this.scanInterval = setInterval(() => this.scan(), this.config.scanIntervalMs);
    }

    /**
     * Scan all active Polymarket markets for YES + NO < 100¢ opportunities
     */
    async scan() {
        this.stats.scans++;
        try {
            // Fetch top markets by volume (most liquid = most likely to have tradeable mispricings)
            const res = await fetch(
                `${POLY_GAMMA}/markets?active=true&closed=false&order=volume&ascending=false&limit=${this.config.maxMarkets}`
            );
            const markets = await res.json();

            const newOpps = [];

            for (const market of (markets || [])) {
                let prices = market.outcomePrices;
                if (typeof prices === 'string') {
                    try { prices = JSON.parse(prices); } catch (e) { continue; }
                }
                if (!prices || prices.length < 2) continue;

                const yesPrice = parseFloat(prices[0]) * 100;  // Convert to cents
                const noPrice = parseFloat(prices[1]) * 100;

                // Skip if either side has no liquidity
                if (yesPrice <= this.config.minPrice || noPrice <= this.config.minPrice) continue;

                const totalCost = yesPrice + noPrice;
                const profit = 100 - totalCost;  // Guaranteed payout is 100¢

                // Account for Polymarket fees (~2% on winning side)
                // Worst case fee: 2% of 100¢ = 2¢
                const estimatedFee = 2;
                const netProfit = profit - estimatedFee;

                if (netProfit >= this.config.minProfitCents) {
                    let tokenIds = market.clobTokenIds;
                    if (typeof tokenIds === 'string') {
                        try { tokenIds = JSON.parse(tokenIds); } catch (e) { tokenIds = []; }
                    }

                    newOpps.push({
                        name: market.question || market.groupItemTitle || 'Unknown',
                        id: market.conditionId || market.id,
                        yesPrice,
                        noPrice,
                        totalCost,
                        grossProfit: profit,
                        netProfit,
                        volume: parseFloat(market.volume || 0),
                        tokenIds: tokenIds || [],
                        endDate: market.endDate,
                        slug: market.slug,
                    });
                }
            }

            // Sort by net profit descending
            newOpps.sort((a, b) => b.netProfit - a.netProfit);
            this.opportunities = newOpps;

            if (newOpps.length > 0) {
                this.stats.found += newOpps.length;
                console.log(`\n💰 [SAME-MARKET] Found ${newOpps.length} rebalancing opportunities:`);
                for (const opp of newOpps.slice(0, 5)) {
                    console.log(`  ${opp.name.substring(0, 50)} | YES: ${opp.yesPrice.toFixed(1)}¢ + NO: ${opp.noPrice.toFixed(1)}¢ = ${opp.totalCost.toFixed(1)}¢ | Net: +${opp.netProfit.toFixed(1)}¢`);
                }

                // Execute paper trades on the best opportunities
                for (const opp of newOpps) {
                    const trade = this._executeTrade(opp);
                    if (trade) {
                        this.stats.trades++;
                        console.log(`  ✅ REBALANCE TRADE: ${opp.name.substring(0, 40)} | +${opp.netProfit.toFixed(1)}¢/contract`);
                    }
                }
            }
        } catch (e) {
            console.error('[SAME-MARKET] Scan error:', e.message);
        }
    }

    _executeTrade(opp) {
        // Check if we already have this position
        if (this.trader.state.positions.find(p => p.name === `🔄 ${opp.name}`)) return null;
        if (this.trader.state.positions.length >= (this.trader.maxOpenPositions || 20)) return null;

        const contracts = 10;
        const totalCost = opp.totalCost * contracts;
        const fees = 2 * contracts;  // ~2¢ per contract fee estimate

        // Need funds on Polymarket side (both legs are on Poly)
        if (totalCost > this.trader.state.polyBalance) return null;

        this.trader.state.polyBalance -= totalCost;
        this.trader.state.totalTrades++;

        const position = {
            id: `sm-${Date.now()}`,
            name: `🔄 ${opp.name}`,
            strategy: 0,  // 0 = same-market rebalancing
            polySide: 'YES+NO',
            kalshiSide: 'N/A',
            polyPrice: opp.yesPrice,
            kalshiPrice: opp.noPrice,
            contracts,
            totalCost,
            grossSpread: opp.grossProfit,
            fees,
            expectedNetProfit: opp.netProfit * contracts,
            expiresAt: opp.endDate,
            entryTime: new Date().toISOString(),
            entryTimestamp: Date.now(),
        };

        this.trader.state.positions.push(position);
        this.trader.trades.push({ ...position, type: 'ENTRY', timestamp: new Date().toISOString() });
        this.trader.save();

        return position;
    }

    getOpportunities() {
        return this.opportunities;
    }

    getStats() {
        return this.stats;
    }

    stop() {
        if (this.scanInterval) clearInterval(this.scanInterval);
        console.log('[SAME-MARKET] Stopped');
    }
}

export default SameMarketArb;
