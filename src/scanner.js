/**
 * Market Scanner
 * Discovers arbitrage opportunities across all matching markets on Polymarket and Kalshi
 */

import pmxt from 'pmxtjs';
import { matchOutcomes } from './matcher.js';
import { findArbitrageOpportunities, calculateROI } from './arbitrage.js';
import fs from 'fs';

// Known matching market pairs (manually curated)
// Format: { name, polymarketSlug, kalshiSlug }
const KNOWN_PAIRS = [
    {
        name: 'Fed Chair Nominee',
        polymarketSlug: 'who-will-trump-nominate-as-fed-chair',
        kalshiSlug: 'kxfedchairnom',
    },
    {
        name: 'Trump Cabinet - Treasury',
        polymarketSlug: 'who-will-trump-nominate-for-secretary-of-treasury',
        kalshiSlug: 'kxtreasury',
    },
    {
        name: 'Trump Cabinet - Defense',
        polymarketSlug: 'who-will-trump-nominate-for-secretary-of-defense',
        kalshiSlug: 'kxdefense',
    },
    // Add more pairs as discovered
];

/**
 * Scan all known market pairs for arbitrage opportunities
 */
export async function scanAllMarkets(config = {}) {
    const polymarket = new pmxt.polymarket({ privateKey: config.polymarketPrivateKey });
    const kalshi = new pmxt.kalshi({ apiKey: config.kalshiApiKey, apiSecret: config.kalshiApiSecret });
    
    const allOpportunities = [];
    const scanResults = [];
    
    for (const pair of KNOWN_PAIRS) {
        try {
            console.log(`[SCANNING] ${pair.name}...`);
            
            const [polymarketMarkets, kalshiMarkets] = await Promise.all([
                polymarket.getMarketsBySlug(pair.polymarketSlug).catch(() => []),
                kalshi.getMarketsBySlug(pair.kalshiSlug).catch(() => []),
            ]);
            
            if (!polymarketMarkets.length || !kalshiMarkets.length) {
                console.log(`  [SKIP] Missing data for ${pair.name}`);
                continue;
            }
            
            const polyOutcomes = parseOutcomes(polymarketMarkets, 'polymarket');
            const kalshiOutcomes = parseOutcomes(kalshiMarkets, 'kalshi');
            
            const matches = matchOutcomes(polyOutcomes, kalshiOutcomes, 0.6);
            const opportunities = findArbitrageOpportunities(matches, 0);
            
            scanResults.push({
                name: pair.name,
                polymarketCount: polyOutcomes.length,
                kalshiCount: kalshiOutcomes.length,
                matchCount: matches.length,
                opportunities: opportunities.length,
                bestProfit: opportunities.length > 0 ? Math.max(...opportunities.map(o => o.profit)) : 0,
            });
            
            allOpportunities.push(...opportunities.map(o => ({
                ...o,
                marketName: pair.name,
            })));
            
        } catch (error) {
            console.log(`  [ERROR] ${pair.name}: ${error.message}`);
        }
    }
    
    // Sort all opportunities by profit
    allOpportunities.sort((a, b) => b.profit - a.profit);
    
    return { opportunities: allOpportunities, scanResults };
}

/**
 * Parse market outcomes (copy from bot.js for standalone use)
 */
function parseOutcomes(markets, platform) {
    return markets
        .filter(m => m.outcomes && m.outcomes.length >= 2)
        .map(market => {
            const yesOutcome = market.outcomes.find(o => o.label?.toLowerCase().includes('yes') || o.side === 'yes');
            const noOutcome = market.outcomes.find(o => o.label?.toLowerCase().includes('no') || o.side === 'no');
            
            const title = yesOutcome ? yesOutcome.label : market.outcomes[0].label;
            const yesId = yesOutcome ? yesOutcome.id : market.outcomes[0].id;
            const noId = noOutcome ? noOutcome.id : market.outcomes[1].id;
            
            const yesPrice = yesOutcome
                ? Number((yesOutcome.price * 100).toFixed(2))
                : Number((market.outcomes[0].price * 100).toFixed(2));
            
            const noPrice = noOutcome
                ? Number((noOutcome.price * 100).toFixed(2))
                : Number((market.outcomes[1].price * 100).toFixed(2));
            
            return {
                title,
                marketId: market.id,
                yesId,
                noId,
                yesPrice,
                noPrice,
                platform,
                volume: market.volume || 0,
            };
        });
}

/**
 * Generate a report of all opportunities
 */
export function generateReport(opportunities, scanResults) {
    const timestamp = new Date().toISOString();
    
    let report = `# Arbitrage Scan Report\n`;
    report += `Generated: ${timestamp}\n\n`;
    
    report += `## Summary\n`;
    report += `| Market | Poly Outcomes | Kalshi Outcomes | Matches | Opportunities | Best Profit |\n`;
    report += `|--------|---------------|-----------------|---------|---------------|-------------|\n`;
    
    for (const result of scanResults) {
        report += `| ${result.name} | ${result.polymarketCount} | ${result.kalshiCount} | ${result.matchCount} | ${result.opportunities} | ${result.bestProfit.toFixed(2)}¢ |\n`;
    }
    
    report += `\n## Top Opportunities\n`;
    
    const topOps = opportunities.filter(o => o.profit > 0).slice(0, 20);
    
    if (topOps.length === 0) {
        report += `No profitable opportunities found.\n`;
    } else {
        report += `| Rank | Market | Outcome | Profit | ROI | Strategy |\n`;
        report += `|------|--------|---------|--------|-----|----------|\n`;
        
        topOps.forEach((opp, i) => {
            const roi = calculateROI(opp);
            report += `| ${i + 1} | ${opp.marketName || 'Unknown'} | ${opp.outcome} | ${opp.profit.toFixed(2)}¢ | ${roi.toFixed(1)}% | ${opp.description.substring(0, 50)}... |\n`;
        });
    }
    
    return report;
}

/**
 * Save report to file
 */
export function saveReport(report, filename = './scan-report.md') {
    fs.writeFileSync(filename, report);
    console.log(`[SAVED] Report saved to ${filename}`);
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
    console.log('Starting market scan...\n');
    
    const { opportunities, scanResults } = await scanAllMarkets({});
    const report = generateReport(opportunities, scanResults);
    
    console.log('\n' + report);
    saveReport(report);
}

export default { scanAllMarkets, generateReport, saveReport, KNOWN_PAIRS };
