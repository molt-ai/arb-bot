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
        
        // Minimum guaranteed profit after fees to enter (cents per contract)
        this.minNetProfit = config.minNetProfit || 1.0; // At least 1¢/contract profit
        
        this.state = this.loadState();
        this.trades = this.loadTrades();
    }

    /**
     * KALSHI FEE — Formula-based per contract
     * Source: https://defirate.com/learn/prediction-market-fees/
     * Formula: ceil(0.07 × contracts × price × (1-price)) for standard markets
     * Price is in 0-1 range (probability). Fee peaks at 50/50 (~1.75¢/contract).
     * 
     * For S&P 500 / Nasdaq-100 markets: multiplier is 0.035 (halved).
     * We return fee in CENTS per single contract.
     */
    calcKalshiFee(priceCents, opts = {}) {
        const p = priceCents / 100; // convert cents to probability (0-1)
        const multiplier = opts.isIndex ? 0.035 : 0.07;
        // Per-contract fee: multiplier * p * (1-p) gives DOLLARS
        // Convert to cents (our internal unit)
        // Note: ceil() applies to total order, not per-contract. We return raw per-contract.
        const feeDollarsPerContract = multiplier * p * (1 - p);
        return feeDollarsPerContract * 100; // cents per contract
    }

    /**
     * POLYMARKET FEE — Depends on market type
     * 
     * 1. Long-term / political / event markets: 0% trading fee
     *    (This covers ALL cross-platform arb markets)
     * 
     * 2. 15-minute crypto up/down markets (taker fee):
     *    Formula: shares × price × 0.25 × (price × (1-price))²
     *    Max effective rate: ~1.56% at 50/50 odds
     *    Drops to near-zero at extreme odds
     * 
     * 3. Polymarket US (regulated): 0.10% taker fee (10 bps)
     *    We don't use this — we're on global Polymarket via proxy
     * 
     * Returns fee in CENTS per single contract.
     */
    calcPolyFee(priceCents, opts = {}) {
        if (opts.isCrypto15Min) {
            // 15-minute crypto market taker fee
            const p = priceCents / 100;
            // Formula from Polymarket docs: shares * price * 0.25 * (price * (1-price))^2
            // For 1 share at the given price:
            const feePerShare = p * 0.25 * Math.pow(p * (1 - p), 2);
            return feePerShare * 100; // convert to cents
        }
        // Long-term / political / event markets = FREE
        return 0;
    }

    /**
     * Calculate total fees for a cross-platform arb trade
     * Returns total fee in cents per contract
     * 
     * @param {number} polyPrice - Poly side price in cents (0-100)
     * @param {number} kalshiPrice - Kalshi side price in cents (0-100)
     * @param {object} opts - { isCrypto15Min, isIndex }
     */
    calcFees(polyPrice, kalshiPrice, opts = {}) {
        const polyFee = this.calcPolyFee(polyPrice, opts);
        const kalshiFee = this.calcKalshiFee(kalshiPrice, opts);
        return polyFee + kalshiFee;
    }

    /**
     * Calculate guaranteed profit per contract if held to resolution
     * This is the core arb math:
     *   profit = 100¢ (guaranteed payout) - totalCost - fees
     * 
     * @param {number} polyPrice - cents
     * @param {number} kalshiPrice - cents
     * @param {object} opts - { isCrypto15Min, isIndex }
     */
    calcResolutionProfit(polyPrice, kalshiPrice, opts = {}) {
        const totalCost = polyPrice + kalshiPrice;
        const grossSpread = 100 - totalCost;
        const fees = this.calcFees(polyPrice, kalshiPrice, opts);
        const netProfit = grossSpread - fees;
        
        return {
            totalCost,
            grossSpread,
            fees,
            netProfit,
            isProfitable: netProfit >= this.minNetProfit,
            feeBreakdown: {
                poly: this.calcPolyFee(polyPrice, opts),
                kalshi: this.calcKalshiFee(kalshiPrice, opts),
            }
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

        // Skip if either price is 0 or near-0 (no real liquidity)
        if (polyPrice <= 2 || kalshiPrice <= 2) return null;

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
     * Auto-resolve expired positions (simulate platform payout).
     * Only exit early if spread has massively reversed (stop-loss).
     */
    checkExits(currentOpportunities) {
        const closedTrades = [];
        const now = Date.now();

        for (const pos of [...this.state.positions]) {
            // AUTO-RESOLVE: if position has expired, simulate resolution payout
            if (pos.expiresAt) {
                const expiryTime = new Date(pos.expiresAt).getTime();
                // Give 2 minutes grace period after expiry for resolution
                if (expiryTime > 0 && now > expiryTime + 2 * 60 * 1000) {
                    const trade = this.resolvePosition(pos.name);
                    if (trade) {
                        console.log(`🏁 AUTO-RESOLVED: ${pos.name} | Net: ${trade.netPnl >= 0 ? '+' : ''}$${(trade.netPnl/100).toFixed(2)}`);
                        closedTrades.push(trade);
                    }
                    continue;
                }
            }

            // Stop-loss check for non-expired positions
            const opp = currentOpportunities.find(o => o.name === pos.name);
            if (opp) {
                let currentTotal;
                if (pos.polySide === 'YES') {
                    currentTotal = opp.polyYes + opp.kalshiNo;
                } else if (pos.polySide === 'YES+NO') {
                    // Same-market arb — no stop-loss needed, hold to resolution
                    continue;
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
        const positionCost = this.state.positions.reduce((s, p) => s + (p.totalCost || 0), 0);
        // Expected payout if all positions resolve (100¢ per contract)
        const expectedPayout = this.state.positions.reduce((s, p) => s + (100 * (p.contracts || 0)), 0);
        const expectedProfit = this.state.positions.reduce((s, p) => s + (p.expectedNetProfit || 0), 0);
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
