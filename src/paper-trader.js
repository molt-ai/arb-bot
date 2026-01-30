/**
 * Paper Trading Engine v2
 * Realistic fee model + resolution-based arb
 * 
 * HOW PREDICTION MARKET ARB WORKS:
 * - Buy YES on Platform A + NO on Platform B
 * - Total cost must be < 100¢ (minus fees)
 * - At resolution, ONE side pays $1 guaranteed
 * - Profit = 100¢ - totalCost - fees (regardless of outcome)
 * - HOLD TO RESOLUTION — don't flip on price swings
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADE_LOG_PATH = path.join(__dirname, '..', 'data', 'trades.json');
const STATE_PATH = path.join(__dirname, '..', 'data', 'portfolio.json');

export class PaperTrader {
    constructor(config = {}) {
        this.initialBalance = config.initialBalance || 500; // $500 per side
        this.contractSize = config.contractSize || 10;       // 10 contracts per trade ($)
        this.maxOpenPositions = config.maxOpenPositions || 15;
        
        // Realistic fee model (cents per contract)
        this.polyFeePct = config.polyFeePct || 0.02;   // ~2% on Poly (bid-ask spread)
        this.kalshiFeePct = config.kalshiFeePct || 0.03; // ~3% on Kalshi (exchange fee + spread)
        this.totalFeeCents = config.totalFeeCents ?? null; // if set, overrides pct-based fees
        
        // Minimum guaranteed profit after fees to enter (cents per contract)
        this.minNetProfit = config.minNetProfit || 1.0; // At least 1¢/contract profit
        
        this.state = this.loadState();
        this.trades = this.loadTrades();
    }

    /**
     * Calculate fees for a given trade
     * Returns total fee in cents per contract
     */
    calcFees(polyPrice, kalshiPrice) {
        if (this.totalFeeCents !== null) return this.totalFeeCents;
        
        // Fee is % of potential profit on each side
        // Poly: fee on profit if YES wins = (100 - polyPrice) * polyFeePct
        // Kalshi: fee on profit if NO wins = (100 - kalshiPrice) * kalshiFeePct
        // Worst case: pay fees on BOTH sides (conservative estimate)
        const polyFee = (100 - polyPrice) * this.polyFeePct;
        const kalshiFee = (100 - kalshiPrice) * this.kalshiFeePct;
        
        // In reality you only pay fee on the winning side, but be conservative
        return polyFee + kalshiFee;
    }

    /**
     * Calculate guaranteed profit per contract if held to resolution
     * This is the core arb math:
     *   profit = 100¢ (guaranteed payout) - totalCost - fees
     */
    calcResolutionProfit(polyPrice, kalshiPrice) {
        const totalCost = polyPrice + kalshiPrice;
        const grossSpread = 100 - totalCost;
        const fees = this.calcFees(polyPrice, kalshiPrice);
        const netProfit = grossSpread - fees;
        
        return {
            totalCost,
            grossSpread,
            fees,
            netProfit,
            isProfitable: netProfit >= this.minNetProfit
        };
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_PATH)) {
                const loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
                // Preserve loaded state but ensure new fields exist
                return {
                    ...this._defaultState(),
                    ...loaded
                };
            }
        } catch (e) { /* ignore */ }
        return this._defaultState();
    }

    _defaultState() {
        return {
            polyBalance: this.initialBalance * 100,   // cents
            kalshiBalance: this.initialBalance * 100,
            startedAt: new Date().toISOString(),
            positions: [],
            totalTrades: 0,
            grossPnL: 0,      // before fees
            netPnL: 0,        // after fees
            totalFeesPaid: 0,
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
     * Execute a paper trade — only if profitable after fees on resolution
     */
    executeTrade(opportunity) {
        const { name, strategy, polyYes, polyNo, kalshiYes, kalshiNo, expiresAt } = opportunity;

        // Determine sides
        let polyPrice, kalshiPrice, polySide, kalshiSide;
        if (strategy === 1) {
            polyPrice = polyYes; kalshiPrice = kalshiNo;
            polySide = 'YES'; kalshiSide = 'NO';
        } else {
            polyPrice = polyNo; kalshiPrice = kalshiYes;
            polySide = 'NO'; kalshiSide = 'YES';
        }

        // Check if profitable after fees (resolution arb math)
        const arb = this.calcResolutionProfit(polyPrice, kalshiPrice);
        if (!arb.isProfitable) return null;

        // Check limits
        if (this.state.positions.find(p => p.name === name)) return null;
        if (this.state.positions.length >= this.maxOpenPositions) return null;

        const polyCost = polyPrice * this.contractSize;
        const kalshiCost = kalshiPrice * this.contractSize;
        const totalCost = polyCost + kalshiCost;
        const totalFees = arb.fees * this.contractSize;

        if (polyCost > this.state.polyBalance || kalshiCost > this.state.kalshiBalance) return null;

        // Execute
        this.state.polyBalance -= polyCost;
        this.state.kalshiBalance -= kalshiCost;
        this.state.totalTrades++;

        const now = new Date();
        const position = {
            id: `t-${Date.now()}`,
            name,
            strategy,
            polySide,
            kalshiSide,
            polyPrice,
            kalshiPrice,
            contracts: this.contractSize,
            totalCost,
            grossSpread: arb.grossSpread,
            fees: totalFees,
            expectedNetProfit: arb.netProfit * this.contractSize,
            expiresAt: expiresAt || null,
            entryTime: now.toISOString(),
            entryTimestamp: Date.now()
        };

        this.state.positions.push(position);

        const trade = { ...position, type: 'ENTRY', timestamp: now.toISOString() };
        this.trades.push(trade);
        this.save();
        return trade;
    }

    /**
     * Simulate resolution of a position
     * In real arb: one side pays $1, other pays $0
     * Since we don't know outcome, simulate both and take guaranteed profit
     */
    resolvePosition(name) {
        const posIdx = this.state.positions.findIndex(p => p.name === name);
        if (posIdx === -1) return null;

        const pos = this.state.positions[posIdx];
        
        // Guaranteed payout = 100¢ per contract (one side wins)
        const payout = 100 * pos.contracts;
        const fees = pos.fees;
        const grossPnl = payout - pos.totalCost;
        const netPnl = grossPnl - fees;

        // Return payout to balances (split evenly for simplicity)
        this.state.polyBalance += Math.floor(payout / 2);
        this.state.kalshiBalance += Math.ceil(payout / 2);

        this.state.grossPnL += grossPnl;
        this.state.netPnL += netPnl;
        this.state.totalFeesPaid += fees;
        if (netPnl > 0) this.state.wins++; else this.state.losses++;

        if (!this.state.bestTrade || netPnl > this.state.bestTrade.pnl) {
            this.state.bestTrade = { name, pnl: netPnl, date: new Date().toISOString() };
        }
        if (!this.state.worstTrade || netPnl < this.state.worstTrade.pnl) {
            this.state.worstTrade = { name, pnl: netPnl, date: new Date().toISOString() };
        }

        this.state.positions.splice(posIdx, 1);

        const now = new Date();
        const trade = {
            id: pos.id,
            name,
            type: 'RESOLVE',
            polySide: pos.polySide,
            kalshiSide: pos.kalshiSide,
            contracts: pos.contracts,
            totalCost: pos.totalCost,
            payout,
            fees,
            grossPnl,
            netPnl,
            holdTime: Date.now() - pos.entryTimestamp,
            exitTime: now.toISOString(),
            timestamp: now.toISOString()
        };

        this.trades.push(trade);
        this.save();
        return trade;
    }

    /**
     * Close position early by selling at current market prices
     * (Worse than resolution — use only if market is about to delist or emergency)
     */
    closePositionEarly(name, currentPrices) {
        const posIdx = this.state.positions.findIndex(p => p.name === name);
        if (posIdx === -1) return null;

        const pos = this.state.positions[posIdx];

        let polyExit, kalshiExit;
        if (pos.polySide === 'YES') {
            polyExit = currentPrices.polyYes || pos.polyPrice;
            kalshiExit = currentPrices.kalshiNo || pos.kalshiPrice;
        } else {
            polyExit = currentPrices.polyNo || pos.polyPrice;
            kalshiExit = currentPrices.kalshiYes || pos.kalshiPrice;
        }

        const exitValue = (polyExit + kalshiExit) * pos.contracts;
        const fees = pos.fees; // fees already calculated at entry
        const grossPnl = exitValue - pos.totalCost;
        const netPnl = grossPnl - fees;

        this.state.polyBalance += polyExit * pos.contracts;
        this.state.kalshiBalance += kalshiExit * pos.contracts;
        this.state.grossPnL += grossPnl;
        this.state.netPnL += netPnl;
        this.state.totalFeesPaid += fees;
        if (netPnl > 0) this.state.wins++; else this.state.losses++;

        if (!this.state.bestTrade || netPnl > this.state.bestTrade.pnl) {
            this.state.bestTrade = { name, pnl: netPnl, date: new Date().toISOString() };
        }
        if (!this.state.worstTrade || netPnl < this.state.worstTrade.pnl) {
            this.state.worstTrade = { name, pnl: netPnl, date: new Date().toISOString() };
        }

        this.state.positions.splice(posIdx, 1);

        const now = new Date();
        const trade = {
            id: pos.id,
            name,
            type: 'EARLY_EXIT',
            polySide: pos.polySide,
            kalshiSide: pos.kalshiSide,
            entryPoly: pos.polyPrice,
            entryKalshi: pos.kalshiPrice,
            exitPoly: polyExit,
            exitKalshi: kalshiExit,
            contracts: pos.contracts,
            grossPnl,
            netPnl,
            fees,
            holdTime: Date.now() - pos.entryTimestamp,
            exitTime: now.toISOString(),
            timestamp: now.toISOString()
        };

        this.trades.push(trade);
        this.save();
        return trade;
    }

    /**
     * Check exits — for resolution arb, we HOLD positions.
     * Only exit early if spread has massively reversed (stop-loss).
     */
    checkExits(currentOpportunities) {
        const closedTrades = [];

        for (const pos of [...this.state.positions]) {
            const opp = currentOpportunities.find(o => o.name === pos.name);

            // Only early-exit if current total cost is now > 102¢ (massive reversal)
            // This is a stop-loss — normally we hold to resolution
            if (opp) {
                let currentTotal;
                if (pos.polySide === 'YES') {
                    currentTotal = opp.polyYes + opp.kalshiNo;
                } else {
                    currentTotal = opp.polyNo + opp.kalshiYes;
                }
                
                // Stop-loss: if current prices imply > 5¢ loss per contract
                if (currentTotal > 105) {
                    const trade = this.closePositionEarly(pos.name, opp);
                    if (trade) closedTrades.push(trade);
                }
            }
        }

        return closedTrades;
    }

    getPortfolioSummary() {
        const totalCash = this.state.polyBalance + this.state.kalshiBalance;
        const positionCost = this.state.positions.reduce((s, p) => s + p.totalCost, 0);
        // Expected payout if all positions resolve (100¢ per contract)
        const expectedPayout = this.state.positions.reduce((s, p) => s + (100 * p.contracts), 0);
        const expectedProfit = this.state.positions.reduce((s, p) => s + p.expectedNetProfit, 0);
        const totalValue = totalCash + expectedPayout;
        const initialTotal = this.initialBalance * 200;

        return {
            polyBalance: (this.state.polyBalance / 100).toFixed(2),
            kalshiBalance: (this.state.kalshiBalance / 100).toFixed(2),
            totalCash: (totalCash / 100).toFixed(2),
            positionCost: (positionCost / 100).toFixed(2),
            expectedPayout: (expectedPayout / 100).toFixed(2),
            expectedProfit: (expectedProfit / 100).toFixed(2),
            totalValue: (totalValue / 100).toFixed(2),
            initialValue: (initialTotal / 100).toFixed(2),
            grossPnL: (this.state.grossPnL / 100).toFixed(2),
            netPnL: (this.state.netPnL / 100).toFixed(2),
            totalFeesPaid: (this.state.totalFeesPaid / 100).toFixed(2),
            totalTrades: this.state.totalTrades,
            wins: this.state.wins,
            losses: this.state.losses,
            winRate: (this.state.wins + this.state.losses) > 0
                ? ((this.state.wins / (this.state.wins + this.state.losses)) * 100).toFixed(1)
                : '0.0',
            openPositions: this.state.positions.length,
            positions: this.state.positions,
            bestTrade: this.state.bestTrade,
            worstTrade: this.state.worstTrade,
            startedAt: this.state.startedAt,
            recentTrades: this.trades.slice(-30).reverse()
        };
    }

    reset() {
        this.state = this._defaultState();
        this.trades = [];
        this.save();
    }
}

export default PaperTrader;
