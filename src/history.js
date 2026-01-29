/**
 * History Tracker
 * Records arbitrage opportunities over time for analysis
 */

import fs from 'fs';
import path from 'path';

const HISTORY_DIR = './history';
const HISTORY_FILE = path.join(HISTORY_DIR, 'opportunities.jsonl');

/**
 * Ensure history directory exists
 */
function ensureDir() {
    if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
}

/**
 * Record an opportunity snapshot
 */
export function recordOpportunity(opportunity, context = {}) {
    ensureDir();
    
    const record = {
        timestamp: new Date().toISOString(),
        outcome: opportunity.outcome,
        profit: opportunity.profit,
        netProfit: opportunity.netProfit,
        rawCost: opportunity.rawCost,
        totalCostWithFees: opportunity.totalCostWithFees,
        polymarketYes: opportunity.polymarketOutcome?.yesPrice,
        polymarketNo: opportunity.polymarketOutcome?.noPrice,
        kalshiYes: opportunity.kalshiOutcome?.yesPrice,
        kalshiNo: opportunity.kalshiOutcome?.noPrice,
        volume: opportunity.totalVolume,
        strategy: opportunity.type,
        ...context,
    };
    
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(HISTORY_FILE, line);
}

/**
 * Record multiple opportunities at once
 */
export function recordSnapshot(opportunities, marketName = 'unknown') {
    for (const opp of opportunities) {
        recordOpportunity(opp, { marketName });
    }
}

/**
 * Load history for analysis
 */
export function loadHistory(limit = 1000) {
    ensureDir();
    
    if (!fs.existsSync(HISTORY_FILE)) {
        return [];
    }
    
    const content = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l);
    
    const records = lines.slice(-limit).map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(r => r !== null);
    
    return records;
}

/**
 * Get statistics from history
 */
export function getStats() {
    const records = loadHistory();
    
    if (records.length === 0) {
        return { count: 0, avgProfit: 0, maxProfit: 0, outcomes: [] };
    }
    
    const profits = records.map(r => r.profit).filter(p => p > 0);
    const outcomes = [...new Set(records.map(r => r.outcome))];
    
    return {
        count: records.length,
        profitableCount: profits.length,
        avgProfit: profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0,
        maxProfit: profits.length > 0 ? Math.max(...profits) : 0,
        minProfit: profits.length > 0 ? Math.min(...profits) : 0,
        outcomes: outcomes.length,
        firstRecord: records[0]?.timestamp,
        lastRecord: records[records.length - 1]?.timestamp,
    };
}

/**
 * Get profit trend (last N records grouped by hour)
 */
export function getProfitTrend(hours = 24) {
    const records = loadHistory();
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    
    const recent = records.filter(r => new Date(r.timestamp).getTime() > cutoff);
    
    // Group by hour
    const hourlyData = {};
    for (const record of recent) {
        const hour = new Date(record.timestamp).toISOString().slice(0, 13);
        if (!hourlyData[hour]) {
            hourlyData[hour] = { profits: [], count: 0 };
        }
        hourlyData[hour].profits.push(record.profit);
        hourlyData[hour].count++;
    }
    
    // Calculate hourly averages
    return Object.entries(hourlyData).map(([hour, data]) => ({
        hour,
        avgProfit: data.profits.reduce((a, b) => a + b, 0) / data.profits.length,
        maxProfit: Math.max(...data.profits),
        count: data.count,
    })).sort((a, b) => a.hour.localeCompare(b.hour));
}

export default {
    recordOpportunity,
    recordSnapshot,
    loadHistory,
    getStats,
    getProfitTrend,
};
