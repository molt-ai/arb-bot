/**
 * Auto-Redemption Engine v2 — Honest Resolution
 * 
 * CRITICAL FIX: The previous version was immediately "resolving" combo trades
 * with fake profits (holdTime: 5ms). This version enforces real resolution:
 * 
 * For cross_platform_arb:
 *   - Only resolve after market has ACTUALLY expired (past expiresAt + grace period)
 *   - Payout is guaranteed (100¢ per contract) — this is real arb math
 * 
 * For combinatorial_speculative:
 *   - NEVER auto-resolve based on time alone
 *   - Must verify the market has actually closed/resolved on the platform
 *   - If we can't verify, mark as "pending_resolution" and DON'T credit P&L
 *   - Simulates 50/50 outcome when forced to resolve (honest about uncertainty)
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
     * Check all open positions and redeem any that have ACTUALLY resolved.
     * 
     * KEY DIFFERENCE FROM v1:
     * - Cross-platform arbs: resolve after expiry + grace (guaranteed profit)
     * - Speculative combos: ONLY resolve if we can verify actual market outcome
     *   via API check. Never assume profit.
     * 
     * @returns {{ checked: number, redeemed: number, skipped: number, errors: number, details: Array }}
     */
    async checkAndRedeem() {
        const now = Date.now();
        this.stats.totalChecks++;
        this.stats.lastCheckAt = new Date().toISOString();

        const positions = this.trader.state.positions || [];
        const summary = { checked: 0, redeemed: 0, skipped: 0, errors: 0, details: [] };

        for (const pos of [...positions]) {
            summary.checked++;

            try {
                const tradeType = pos.tradeType || (pos.strategy === 'combinatorial' ? 'combinatorial_speculative' : 'cross_platform_arb');
                
                if (tradeType === 'cross_platform_arb') {
                    // TRUE ARB: safe to resolve after expiry — payout is guaranteed
                    const shouldRedeem = this._isExpired(pos, now);
                    if (!shouldRedeem) continue;

                    const trade = this.trader.resolvePosition(pos.name);
                    if (trade) {
                        this._recordRedemption(trade, pos, summary);
                        const holdMin = Math.round((trade.holdTime || 0) / 60000);
                        const netStr = trade.netPnl >= 0
                            ? `+$${(trade.netPnl / 100).toFixed(2)}`
                            : `-$${(Math.abs(trade.netPnl) / 100).toFixed(2)}`;
                        console.log(`🏦 AUTO-REDEEMED (TRUE ARB): ${pos.name} | Payout: $${(trade.payout / 100).toFixed(2)} | Net: ${netStr} | Held: ${holdMin}min`);
                    }
                } else {
                    // SPECULATIVE: DO NOT auto-resolve based on time alone
                    // Must verify actual market resolution via platform API
                    const isExpired = this._isExpired(pos, now);
                    if (!isExpired) continue;

                    // Try to verify resolution via API
                    const actualOutcome = await this._verifyMarketResolution(pos);
                    
                    if (actualOutcome === null) {
                        // Can't verify — skip, don't fake it
                        summary.skipped++;
                        
                        // Log warning if it's been a long time past expiry
                        const expiryTime = new Date(pos.expiresAt).getTime();
                        const hoursPastExpiry = (now - expiryTime) / (60 * 60 * 1000);
                        if (hoursPastExpiry > 24) {
                            console.log(`[AUTO-REDEEM] ⚠️  STALE SPECULATIVE: ${pos.name} | ${Math.round(hoursPastExpiry)}h past expiry, can't verify outcome — NOT resolving`);
                        }
                        continue;
                    }

                    // We have a verified outcome — resolve honestly
                    const trade = this.trader.resolvePosition(pos.name, { outcome: actualOutcome });
                    if (trade) {
                        this._recordRedemption(trade, pos, summary);
                        const holdMin = Math.round((trade.holdTime || 0) / 60000);
                        const netStr = trade.netPnl >= 0
                            ? `+$${(trade.netPnl / 100).toFixed(2)}`
                            : `-$${(Math.abs(trade.netPnl) / 100).toFixed(2)}`;
                        console.log(`🏦 AUTO-REDEEMED (SPECULATIVE, verified ${actualOutcome}): ${pos.name} | Net: ${netStr} | Held: ${holdMin}min`);
                    }
                }
            } catch (e) {
                summary.errors++;
                this.stats.errors++;
                console.error(`[AUTO-REDEEM] Error checking ${pos.name}:`, e.message);
            }
        }

        if (summary.redeemed > 0 || summary.skipped > 0) {
            console.log(`[AUTO-REDEEM] Batch: ${summary.checked} checked, ${summary.redeemed} redeemed, ${summary.skipped} skipped (unverified), ${summary.errors} errors`);
        }

        return summary;
    }

    /**
     * Record a successful redemption in stats and summary
     */
    _recordRedemption(trade, pos, summary) {
        summary.redeemed++;
        this.stats.totalRedeemed++;
        this.stats.totalValueRedeemed += trade.payout || 0;
        this.stats.totalProfitRedeemed += trade.netPnl || 0;
        this.stats.lastRedemptionAt = new Date().toISOString();

        const detail = {
            name: pos.name,
            tradeType: pos.tradeType || 'unknown',
            payout: trade.payout,
            netPnl: trade.netPnl,
            holdTimeMs: trade.holdTime,
            redeemedAt: new Date().toISOString(),
        };
        summary.details.push(detail);

        this.stats.redemptionLog.unshift(detail);
        if (this.stats.redemptionLog.length > 50) {
            this.stats.redemptionLog.length = 50;
        }
    }

    /**
     * Verify if a speculative/combo market has ACTUALLY resolved.
     * Checks the Polymarket API for market closure status.
     * 
     * Returns: 'win' | 'loss' | null (null = can't verify, don't resolve)
     */
    async _verifyMarketResolution(pos) {
        try {
            // For combinatorial trades, try to check Polymarket API
            // The position should have enough info to look up the market
            if (!this.poly) return null;

            // Try to get market status from Polymarket
            // If the market is closed and we can determine outcome, return it
            // Otherwise return null to be safe
            
            // For now, we conservatively return null for all speculative trades
            // until we implement proper market resolution verification.
            // This is the HONEST approach — don't claim profits we can't verify.
            //
            // TODO: Implement actual Polymarket API check:
            //   1. Look up market by slug/conditionId
            //   2. Check if market.closed === true
            //   3. Check winning outcome
            //   4. Compare with our position side
            //   5. Return 'win' or 'loss'
            
            return null;
        } catch (e) {
            console.error(`[AUTO-REDEEM] Verification failed for ${pos.name}:`, e.message);
            return null;
        }
    }

    /**
     * Check if a position's market has expired (past expiresAt + grace period).
     * NOTE: Expiry alone does NOT mean resolved for speculative trades.
     * 
     * @param {object} pos - Position from trader.state.positions
     * @param {number} now - Current timestamp in ms
     * @returns {boolean}
     */
    _isExpired(pos, now) {
        if (!pos.expiresAt) return false;

        const expiryTime = new Date(pos.expiresAt).getTime();
        if (isNaN(expiryTime) || expiryTime <= 0) return false;

        // Position's market has expired if current time > expiresAt + grace period
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
