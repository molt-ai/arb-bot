/**
 * Paper Trading Engine
 * Simulates trades with fake money and tracks P&L
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADE_LOG_PATH = path.join(__dirname, '..', 'data', 'trades.json');
const STATE_PATH = path.join(__dirname, '..', 'data', 'portfolio.json');

export class PaperTrader {
    constructor(config = {}) {
        this.initialBalance = config.initialBalance || 1000; // $10 per side in cents
        this.contractSize = config.contractSize || 100; // contracts per trade
        this.maxPositionPer = config.maxPositionPer || 200; // max cents per position
        this.totalFeeCents = config.totalFeeCents || 4.0;
        
        // Load or initialize state
        this.state = this.loadState();
        this.trades = this.loadTrades();
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_PATH)) {
                return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
            }
        } catch (e) { /* ignore */ }
        
        return {
            polyBalance: this.initialBalance * 100, // in cents
            kalshiBalance: this.initialBalance * 100,
            startedAt: new Date().toISOString(),
            positions: [],
            totalTrades: 0,
            totalPnL: 0,
            wins: 0,
            losses: 0,
            bestTrade: null,
            worstTrade: null
        };
    }

    loadTrades() {
        try {
            if (fs.existsSync(TRADE_LOG_PATH)) {
                return JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
            }
        } catch (e) { /* ignore */ }
        return [];
    }

    save() {
        const dataDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        
        fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
        fs.writeFileSync(TRADE_LOG_PATH, JSON.stringify(this.trades, null, 2));
    }

    /**
     * Execute a paper trade for an arbitrage opportunity
     * Returns trade details or null if can't execute
     */
    executeTrade(opportunity) {
        const { name, profit, strategy, polyYes, polyNo, kalshiYes, kalshiNo } = opportunity;
        
        // Determine what we're buying
        let polyPrice, kalshiPrice, polySide, kalshiSide;
        
        if (strategy === 1) {
            // Buy Poly YES + Kalshi NO
            polyPrice = polyYes;
            kalshiPrice = kalshiNo;
            polySide = 'YES';
            kalshiSide = 'NO';
        } else {
            // Buy Poly NO + Kalshi YES
            polyPrice = polyNo;
            kalshiPrice = kalshiYes;
            polySide = 'NO';
            kalshiSide = 'YES';
        }
        
        // Calculate contracts we can afford
        const polyCost = polyPrice * this.contractSize;
        const kalshiCost = kalshiPrice * this.contractSize;
        const totalCost = polyCost + kalshiCost;
        
        // Check if we have enough balance
        if (polyCost > this.state.polyBalance || kalshiCost > this.state.kalshiBalance) {
            return null; // Can't afford
        }
        
        // Check if we already have a position in this market
        if (this.state.positions.find(p => p.name === name)) {
            return null; // Already positioned
        }
        
        // Execute
        this.state.polyBalance -= polyCost;
        this.state.kalshiBalance -= kalshiCost;
        
        const position = {
            id: `trade-${Date.now()}`,
            name,
            strategy,
            polySide,
            kalshiSide,
            polyPrice,
            kalshiPrice,
            contracts: this.contractSize,
            totalCost,
            expectedProfit: profit * this.contractSize,
            entryTime: new Date().toISOString(),
            entryTimestamp: Date.now()
        };
        
        this.state.positions.push(position);
        this.state.totalTrades++;
        
        const trade = {
            ...position,
            type: 'ENTRY',
        };
        this.trades.push(trade);
        this.save();
        
        return trade;
    }

    /**
     * Close a position (when spread disappears or reverses)
     * Simulates both contracts resolving
     */
    closePosition(name, currentPrices) {
        const posIdx = this.state.positions.findIndex(p => p.name === name);
        if (posIdx === -1) return null;
        
        const position = this.state.positions[posIdx];
        
        // Calculate exit value
        // In arb, one side wins and pays $1 (100¢), other pays $0
        // But since we don't know outcome yet, we simulate selling at current prices
        let polyExitPrice, kalshiExitPrice;
        
        if (position.polySide === 'YES') {
            polyExitPrice = currentPrices.polyYes || position.polyPrice;
            kalshiExitPrice = currentPrices.kalshiNo || position.kalshiPrice;
        } else {
            polyExitPrice = currentPrices.polyNo || position.polyPrice;
            kalshiExitPrice = currentPrices.kalshiYes || position.kalshiPrice;
        }
        
        const exitValue = (polyExitPrice + kalshiExitPrice) * position.contracts;
        const fees = this.totalFeeCents * position.contracts;
        const pnl = exitValue - position.totalCost - fees;
        
        // Return balance
        this.state.polyBalance += polyExitPrice * position.contracts;
        this.state.kalshiBalance += kalshiExitPrice * position.contracts;
        
        // Update stats
        this.state.totalPnL += pnl;
        if (pnl > 0) this.state.wins++;
        else this.state.losses++;
        
        if (!this.state.bestTrade || pnl > this.state.bestTrade.pnl) {
            this.state.bestTrade = { name, pnl, date: new Date().toISOString() };
        }
        if (!this.state.worstTrade || pnl < this.state.worstTrade.pnl) {
            this.state.worstTrade = { name, pnl, date: new Date().toISOString() };
        }
        
        // Remove position
        this.state.positions.splice(posIdx, 1);
        
        const trade = {
            id: position.id,
            name,
            type: 'EXIT',
            polySide: position.polySide,
            kalshiSide: position.kalshiSide,
            entryPolyPrice: position.polyPrice,
            entryKalshiPrice: position.kalshiPrice,
            exitPolyPrice: polyExitPrice,
            exitKalshiPrice: kalshiExitPrice,
            contracts: position.contracts,
            pnl,
            holdTime: Date.now() - position.entryTimestamp,
            exitTime: new Date().toISOString()
        };
        
        this.trades.push(trade);
        this.save();
        
        return trade;
    }

    /**
     * Check if any open positions should be closed
     * Close if spread has disappeared or reversed
     */
    checkExits(currentOpportunities) {
        const closedTrades = [];
        
        for (const position of [...this.state.positions]) {
            const stillOpen = currentOpportunities.find(
                o => o.name === position.name && o.strategy === position.strategy
            );
            
            // Close if opportunity no longer exists or profit dropped below threshold
            if (!stillOpen || stillOpen.profit < 0.1) {
                const prices = stillOpen || {
                    polyYes: position.polyPrice,
                    polyNo: 100 - position.polyPrice,
                    kalshiYes: position.kalshiPrice,
                    kalshiNo: 100 - position.kalshiPrice
                };
                
                const trade = this.closePosition(position.name, prices);
                if (trade) closedTrades.push(trade);
            }
        }
        
        return closedTrades;
    }

    getPortfolioSummary() {
        const totalBalance = this.state.polyBalance + this.state.kalshiBalance;
        const initialTotal = this.initialBalance * 200; // both sides in cents
        const positionValue = this.state.positions.reduce((sum, p) => sum + p.totalCost, 0);
        
        return {
            polyBalance: (this.state.polyBalance / 100).toFixed(2),
            kalshiBalance: (this.state.kalshiBalance / 100).toFixed(2),
            totalCash: ((totalBalance) / 100).toFixed(2),
            positionsValue: (positionValue / 100).toFixed(2),
            totalValue: ((totalBalance + positionValue) / 100).toFixed(2),
            initialValue: (initialTotal / 100).toFixed(2),
            totalPnL: (this.state.totalPnL / 100).toFixed(2),
            totalPnLCents: this.state.totalPnL.toFixed(2),
            totalTrades: this.state.totalTrades,
            wins: this.state.wins,
            losses: this.state.losses,
            winRate: this.state.totalTrades > 0 
                ? ((this.state.wins / (this.state.wins + this.state.losses)) * 100).toFixed(1) 
                : '0.0',
            openPositions: this.state.positions.length,
            positions: this.state.positions,
            bestTrade: this.state.bestTrade,
            worstTrade: this.state.worstTrade,
            startedAt: this.state.startedAt,
            recentTrades: this.trades.slice(-20).reverse()
        };
    }

    reset() {
        this.state = {
            polyBalance: this.initialBalance * 100,
            kalshiBalance: this.initialBalance * 100,
            startedAt: new Date().toISOString(),
            positions: [],
            totalTrades: 0,
            totalPnL: 0,
            wins: 0,
            losses: 0,
            bestTrade: null,
            worstTrade: null
        };
        this.trades = [];
        this.save();
    }
}

export default PaperTrader;
