/**
 * Arbitrage calculations with fee adjustments
 * 
 * Fee Structure:
 * - Kalshi: 0% trading fee (built into spread)
 * - Polymarket: ~1% trading fee + ~0.5% gas = ~1.5% total
 * 
 * We use conservative estimates to ensure real profitability
 */

const FEES = {
    polymarket: 0.02,  // 2% conservative (1% fee + gas + slippage)
    kalshi: 0.00,      // 0% (no fees)
};

export function calculateArbitrage(match) {
    const { polymarket, kalshi } = match;

    // Strategy 1: Buy YES on Polymarket + Buy NO on Kalshi
    const polyYesCost = polymarket.yesPrice * (1 + FEES.polymarket);
    const kalshiNoCost = kalshi.noPrice * (1 + FEES.kalshi);
    const strategy1Cost = polyYesCost + kalshiNoCost;
    const strategy1Profit = 100 - strategy1Cost;

    // Strategy 2: Buy YES on Kalshi + Buy NO on Polymarket
    const kalshiYesCost = kalshi.yesPrice * (1 + FEES.kalshi);
    const polyNoCost = polymarket.noPrice * (1 + FEES.polymarket);
    const strategy2Cost = kalshiYesCost + polyNoCost;
    const strategy2Profit = 100 - strategy2Cost;

    let bestStrategy = null;

    if (strategy1Profit > 0 && strategy1Profit >= strategy2Profit) {
        bestStrategy = {
            type: 'STRATEGY_1',
            description: `Buy YES on Polymarket (${polymarket.yesPrice.toFixed(2)}¢ + 2% fee), Buy NO on Kalshi (${kalshi.noPrice.toFixed(2)}¢)`,
            polymarketSide: 'YES',
            kalshiSide: 'NO',
            rawCost: polymarket.yesPrice + kalshi.noPrice,
            totalCostWithFees: strategy1Cost,
            grossProfit: 100 - (polymarket.yesPrice + kalshi.noPrice),
            netProfit: strategy1Profit,
            profit: strategy1Profit, // For backwards compatibility
        };
    } else if (strategy2Profit > 0) {
        bestStrategy = {
            type: 'STRATEGY_2',
            description: `Buy YES on Kalshi (${kalshi.yesPrice.toFixed(2)}¢), Buy NO on Polymarket (${polymarket.noPrice.toFixed(2)}¢ + 2% fee)`,
            polymarketSide: 'NO',
            kalshiSide: 'YES',
            rawCost: kalshi.yesPrice + polymarket.noPrice,
            totalCostWithFees: strategy2Cost,
            grossProfit: 100 - (kalshi.yesPrice + polymarket.noPrice),
            netProfit: strategy2Profit,
            profit: strategy2Profit, // For backwards compatibility
        };
    }

    if (!bestStrategy) return null;

    return {
        outcome: polymarket.title,
        similarity: match.similarity,
        ...bestStrategy,
        polymarketOutcome: polymarket,
        kalshiOutcome: kalshi,
    };
}

export function findArbitrageOpportunities(matches, minProfit = 1) {
    const opportunities = [];
    for (const match of matches) {
        const arb = calculateArbitrage(match);
        if (arb && arb.profit >= minProfit) opportunities.push(arb);
    }
    opportunities.sort((a, b) => b.profit - a.profit);
    return opportunities;
}

export function getBestOpportunity(opportunities) {
    return opportunities.length > 0 ? opportunities[0] : null;
}

/**
 * Calculate ROI percentage
 */
export function calculateROI(opportunity) {
    if (!opportunity) return 0;
    return (opportunity.netProfit / opportunity.totalCostWithFees) * 100;
}
