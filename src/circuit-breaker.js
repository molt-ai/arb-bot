/**
 * Circuit Breaker — Risk control system for the arb bot
 * 
 * Trips (halts all trading) when:
 *   - Daily loss exceeds threshold
 *   - Too many consecutive execution errors
 *   - Position limits exceeded
 * 
 * Auto-resets daily loss at midnight UTC.
 * Manual reset available for other trip conditions.
 */

export class CircuitBreaker {
    constructor(config = {}) {
        this.maxPositionPerMarket = config.maxPositionPerMarket ?? 50;
        this.maxTotalPosition = config.maxTotalPosition ?? 200;
        this.maxDailyLoss = config.maxDailyLoss ?? 5000;           // cents ($50)
        this.maxConsecutiveErrors = config.maxConsecutiveErrors ?? 5;
        this.cooldownMs = config.cooldownMs ?? 60000;              // 1 minute

        // State
        this.isTripped = false;
        this.tripReason = null;
        this.trippedAt = null;
        this.consecutiveErrors = 0;
        this.dailyLoss = 0;
        this.dailyTradeCount = 0;
        this.totalTrips = 0;
        this.lastResetDate = this._utcDateString();

        // Schedule midnight UTC reset check every 60s
        this._midnightInterval = setInterval(() => this._checkMidnightReset(), 60000);
    }

    /**
     * Check if a trade is allowed
     * @param {object} opportunity — must have { name, contracts } or similar
     * @param {object} context — { currentPositions: Map<market, contracts>, totalContracts: number }
     * @returns {{ allowed: boolean, reason: string }}
     */
    check(opportunity, context = {}) {
        // Check cooldown — if tripped, wait for cooldown before allowing anything
        if (this.isTripped) {
            const elapsed = Date.now() - this.trippedAt;
            if (elapsed < this.cooldownMs) {
                return {
                    allowed: false,
                    reason: `Circuit breaker tripped: ${this.tripReason} (cooldown ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s remaining)`
                };
            }
            // Cooldown expired but still tripped — require manual reset for loss/error trips
            return {
                allowed: false,
                reason: `Circuit breaker tripped: ${this.tripReason} (requires manual reset)`
            };
        }

        // Check daily loss limit
        if (this.dailyLoss >= this.maxDailyLoss) {
            this._trip(`Daily loss limit reached: ${(this.dailyLoss / 100).toFixed(2)} >= $${(this.maxDailyLoss / 100).toFixed(2)}`);
            return { allowed: false, reason: this.tripReason };
        }

        // Check consecutive errors
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
            this._trip(`${this.consecutiveErrors} consecutive execution errors`);
            return { allowed: false, reason: this.tripReason };
        }

        // Check position limits if context provided
        if (context.currentPositions && opportunity.name) {
            const marketContracts = context.currentPositions.get(opportunity.name) || 0;
            const tradeContracts = opportunity.contracts || 10;

            if (marketContracts + tradeContracts > this.maxPositionPerMarket) {
                return {
                    allowed: false,
                    reason: `Position limit per market: ${marketContracts} + ${tradeContracts} > ${this.maxPositionPerMarket}`
                };
            }
        }

        if (context.totalContracts !== undefined) {
            const tradeContracts = opportunity.contracts || 10;
            if (context.totalContracts + tradeContracts > this.maxTotalPosition) {
                return {
                    allowed: false,
                    reason: `Total position limit: ${context.totalContracts} + ${tradeContracts} > ${this.maxTotalPosition}`
                };
            }
        }

        return { allowed: true, reason: 'ok' };
    }

    /**
     * Record a successful trade execution — resets consecutive error counter
     */
    recordSuccess() {
        this.consecutiveErrors = 0;
        this.dailyTradeCount++;
    }

    /**
     * Record a failed trade execution — may trip the breaker
     * @param {Error|string} error
     */
    recordError(error) {
        this.consecutiveErrors++;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[CIRCUIT-BREAKER] Error #${this.consecutiveErrors}: ${msg}`);

        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
            this._trip(`${this.consecutiveErrors} consecutive execution errors (last: ${msg})`);
        }
    }

    /**
     * Record a loss — tracks daily cumulative loss
     * @param {number} amountCents — positive number representing loss in cents
     */
    recordLoss(amountCents) {
        if (amountCents > 0) {
            this.dailyLoss += amountCents;
            if (this.dailyLoss >= this.maxDailyLoss) {
                this._trip(`Daily loss limit: $${(this.dailyLoss / 100).toFixed(2)} >= $${(this.maxDailyLoss / 100).toFixed(2)}`);
            }
        }
    }

    /**
     * Manually reset the circuit breaker
     */
    reset() {
        this.isTripped = false;
        this.tripReason = null;
        this.trippedAt = null;
        this.consecutiveErrors = 0;
        console.log('[CIRCUIT-BREAKER] ✅ Manually reset');
    }

    /**
     * Full daily reset — clears loss tracking too
     */
    resetDaily() {
        this.dailyLoss = 0;
        this.dailyTradeCount = 0;
        this.lastResetDate = this._utcDateString();
        // Also reset trip if it was loss-based
        if (this.isTripped && this.tripReason?.includes('Daily loss')) {
            this.isTripped = false;
            this.tripReason = null;
            this.trippedAt = null;
            console.log('[CIRCUIT-BREAKER] 🔄 Daily loss reset — breaker cleared');
        }
        console.log('[CIRCUIT-BREAKER] 📅 Daily counters reset (midnight UTC)');
    }

    /**
     * Get full status for dashboard
     */
    getStatus() {
        return {
            isTripped: this.isTripped,
            tripReason: this.tripReason,
            trippedAt: this.trippedAt ? new Date(this.trippedAt).toISOString() : null,
            consecutiveErrors: this.consecutiveErrors,
            maxConsecutiveErrors: this.maxConsecutiveErrors,
            dailyLoss: this.dailyLoss,
            dailyLossDollars: (this.dailyLoss / 100).toFixed(2),
            maxDailyLoss: this.maxDailyLoss,
            maxDailyLossDollars: (this.maxDailyLoss / 100).toFixed(2),
            dailyTradeCount: this.dailyTradeCount,
            totalTrips: this.totalTrips,
            maxPositionPerMarket: this.maxPositionPerMarket,
            maxTotalPosition: this.maxTotalPosition,
            cooldownMs: this.cooldownMs,
            lastResetDate: this.lastResetDate,
        };
    }

    /**
     * Clean up interval on shutdown
     */
    destroy() {
        if (this._midnightInterval) {
            clearInterval(this._midnightInterval);
            this._midnightInterval = null;
        }
    }

    // ── Internal ────────────────────────────────────────────

    _trip(reason) {
        if (!this.isTripped) {
            this.isTripped = true;
            this.tripReason = reason;
            this.trippedAt = Date.now();
            this.totalTrips++;
            console.error(`\n🚨🚨🚨 CIRCUIT BREAKER TRIPPED 🚨🚨🚨`);
            console.error(`   Reason: ${reason}`);
            console.error(`   All trading halted. Manual reset required.\n`);
        }
    }

    _checkMidnightReset() {
        const today = this._utcDateString();
        if (today !== this.lastResetDate) {
            this.resetDaily();
        }
    }

    _utcDateString() {
        return new Date().toISOString().slice(0, 10);
    }
}

export default CircuitBreaker;
