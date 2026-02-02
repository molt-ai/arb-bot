/**
 * Auto-Redemption Engine
 * Periodically checks for resolved positions and redeems them.
 * 
 * In prediction market arb, positions are held until market resolution.
 * This module automates the redemption process by:
 * 1. Checking if a position's market has expired (past expiresAt + grace period)
 * 2. Calling trader.resolvePosition() to simulate the guaranteed payout
 * 3. Logging and tracking all redemptions for the dashboard
 */

export class AutoRedeemer {
    constructor(polyClient, kalshiClient, trader, opts = {}) {
        this.poly = polyClient;
        this.kalshi = kalshiClient;
        this.trader = trader;
        this.intervalMs = opts.intervalMs || 5 * 60 * 1000; // 5 minutes
        this.gracePeriodMs = opts.gracePeriodMs || 2 * 60 * 1000; // 2 min after expiry
        this.timer = null;

        // Stats
        this.stats = {
            totalChecks: 0,
            totalRedeemed: 0,
            totalValueRedeemed: 0,    // cents
            totalProfitRedeemed: 0,   // cents (net P&L from redeemed positions)
            errors: 0,
            lastCheckAt: null,
            lastRedemptionAt: null,
            redemptionLog: [],        // Recent redemptions (last 50)
        };
    }

    /**
     * Start the periodic auto-redemption loop
     */
    start() {
        if (this.timer) return;
        console.log(`[AUTO-REDEEM] ✅ Started — checking every ${this.intervalMs / 1000}s, grace period ${this.gracePeriodMs / 1000}s`);
        // Run immediately, then on interval
        this.checkAndRedeem().catch(e => console.error('[AUTO-REDEEM] Initial check error:', e.message));
        this.timer = setInterval(() => {
            this.checkAndRedeem().catch(e => console.error('[AUTO-REDEEM] Check error:', e.message));
        }, this.intervalMs);
    }

    /**
     * Stop the periodic loop
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log('[AUTO-REDEEM] Stopped');
        }
    }

    /**
     * Check all open positions and redeem any that have resolved
     * @returns {{ checked: number, redeemed: number, errors: number, details: Array }}
     */
    async checkAndRedeem() {
        const now = Date.now();
        this.stats.totalChecks++;
        this.stats.lastCheckAt = new Date().toISOString();

        const positions = this.trader.state.positions || [];
        const summary = { checked: 0, redeemed: 0, errors: 0, details: [] };

        for (const pos of [...positions]) {
            summary.checked++;

            try {
                const shouldRedeem = this._isResolved(pos, now);
                if (!shouldRedeem) continue;

                // Redeem via paper trader's resolvePosition
                const trade = this.trader.resolvePosition(pos.name);
                if (trade) {
                    summary.redeemed++;
                    this.stats.totalRedeemed++;
                    this.stats.totalValueRedeemed += trade.payout || 0;
                    this.stats.totalProfitRedeemed += trade.netPnl || 0;
                    this.stats.lastRedemptionAt = new Date().toISOString();

                    const detail = {
                        name: pos.name,
                        payout: trade.payout,
                        netPnl: trade.netPnl,
                        holdTimeMs: trade.holdTime,
                        redeemedAt: new Date().toISOString(),
                    };
                    summary.details.push(detail);

                    // Keep last 50 redemptions in log
                    this.stats.redemptionLog.unshift(detail);
                    if (this.stats.redemptionLog.length > 50) {
                        this.stats.redemptionLog.length = 50;
                    }

                    const holdMin = Math.round((trade.holdTime || 0) / 60000);
                    const netStr = trade.netPnl >= 0
                        ? `+$${(trade.netPnl / 100).toFixed(2)}`
                        : `-$${(Math.abs(trade.netPnl) / 100).toFixed(2)}`;
                    console.log(`🏦 AUTO-REDEEMED: ${pos.name} | Payout: $${(trade.payout / 100).toFixed(2)} | Net: ${netStr} | Held: ${holdMin}min`);
                }
            } catch (e) {
                summary.errors++;
                this.stats.errors++;
                console.error(`[AUTO-REDEEM] Error redeeming ${pos.name}:`, e.message);
            }
        }

        if (summary.redeemed > 0) {
            console.log(`[AUTO-REDEEM] Batch complete: ${summary.checked} checked, ${summary.redeemed} redeemed, ${summary.errors} errors`);
        }

        return summary;
    }

    /**
     * Determine if a position should be redeemed based on expiry time
     * @param {object} pos - Position from trader.state.positions
     * @param {number} now - Current timestamp in ms
     * @returns {boolean}
     */
    _isResolved(pos, now) {
        if (!pos.expiresAt) return false;

        const expiryTime = new Date(pos.expiresAt).getTime();
        if (isNaN(expiryTime) || expiryTime <= 0) return false;

        // Position is considered resolved if current time > expiresAt + grace period
        return now > expiryTime + this.gracePeriodMs;
    }

    /**
     * Get status for the dashboard
     */
    getStatus() {
        const openPositions = this.trader.state.positions?.length || 0;
        const expiringSoon = (this.trader.state.positions || []).filter(pos => {
            if (!pos.expiresAt) return false;
            const msToExpiry = new Date(pos.expiresAt).getTime() - Date.now();
            return msToExpiry > 0 && msToExpiry < 30 * 60 * 1000; // Within 30 minutes
        }).length;

        return {
            running: this.timer !== null,
            intervalMs: this.intervalMs,
            gracePeriodMs: this.gracePeriodMs,
            openPositions,
            expiringSoon,
            stats: {
                totalChecks: this.stats.totalChecks,
                totalRedeemed: this.stats.totalRedeemed,
                totalValueRedeemed: (this.stats.totalValueRedeemed / 100).toFixed(2),
                totalProfitRedeemed: (this.stats.totalProfitRedeemed / 100).toFixed(2),
                errors: this.stats.errors,
                lastCheckAt: this.stats.lastCheckAt,
                lastRedemptionAt: this.stats.lastRedemptionAt,
            },
            recentRedemptions: this.stats.redemptionLog.slice(0, 10).map(r => ({
                ...r,
                payout: (r.payout / 100).toFixed(2),
                netPnl: (r.netPnl / 100).toFixed(2),
                holdTimeMin: Math.round((r.holdTimeMs || 0) / 60000),
            })),
        };
    }
}

export default AutoRedeemer;
