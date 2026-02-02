/**
 * Order Manager — Timeout & Cancellation Wrapper
 * 
 * Wraps trade execution with timeout handling.
 * Currently for paper trading, this enforces timing discipline.
 * For future live trading, will wrap real API calls with AbortController.
 * 
 * Key behaviors:
 * - Paper mode: logs execution timing, always succeeds (no real network)
 * - Live mode (future): wraps API calls, cancels on timeout via AbortController
 * - Tracks all in-flight orders for dashboard visibility
 */

export class OrderManager {
    constructor(opts = {}) {
        this.timeoutMs = opts.timeoutMs || 10000; // 10 second default timeout
        this.pendingOrders = new Map();            // tradeId → { startedAt, status }
        this.nextId = 1;

        // Stats
        this.stats = {
            totalExecuted: 0,
            totalSucceeded: 0,
            totalTimedOut: 0,
            totalFailed: 0,
            avgExecutionMs: 0,
            maxExecutionMs: 0,
            minExecutionMs: Infinity,
            recentOrders: [],   // Last 50 orders with timing info
        };
    }

    /**
     * Execute a trade function with timeout protection
     * 
     * @param {Function} tradeFn - Async function that executes the trade, returns result
     * @param {string} [tradeId] - Optional identifier for the trade
     * @returns {Promise<{ status: string, tradeId: string, result?: any, elapsedMs: number }>}
     */
    async executeWithTimeout(tradeFn, tradeId) {
        const id = tradeId || `order-${this.nextId++}`;
        const startedAt = Date.now();

        // Track in pending orders
        this.pendingOrders.set(id, {
            tradeId: id,
            startedAt,
            status: 'pending',
        });

        this.stats.totalExecuted++;

        try {
            const result = await Promise.race([
                this._executeTrade(tradeFn, id),
                this._createTimeout(id),
            ]);

            const elapsedMs = Date.now() - startedAt;

            if (result._timedOut) {
                // Timeout fired first
                this.stats.totalTimedOut++;
                this.pendingOrders.delete(id);

                const orderRecord = {
                    tradeId: id,
                    status: 'timeout',
                    elapsedMs,
                    timestamp: new Date().toISOString(),
                };
                this._recordOrder(orderRecord);

                console.log(`⏰ ORDER TIMEOUT: ${id} after ${elapsedMs}ms (limit: ${this.timeoutMs}ms)`);
                return { status: 'timeout', tradeId: id, result: null, elapsedMs };
            }

            // Trade succeeded
            this.stats.totalSucceeded++;
            this._updateTimingStats(elapsedMs);
            this.pendingOrders.delete(id);

            const orderRecord = {
                tradeId: id,
                status: 'success',
                elapsedMs,
                timestamp: new Date().toISOString(),
            };
            this._recordOrder(orderRecord);

            return { status: 'success', tradeId: id, result: result.value, elapsedMs };

        } catch (err) {
            const elapsedMs = Date.now() - startedAt;
            this.stats.totalFailed++;
            this.pendingOrders.delete(id);

            const orderRecord = {
                tradeId: id,
                status: 'error',
                error: err.message,
                elapsedMs,
                timestamp: new Date().toISOString(),
            };
            this._recordOrder(orderRecord);

            console.error(`❌ ORDER ERROR: ${id} after ${elapsedMs}ms — ${err.message}`);
            return { status: 'error', tradeId: id, result: null, elapsedMs, error: err.message };
        }
    }

    /**
     * Wrap the actual trade function execution
     * @private
     */
    async _executeTrade(tradeFn, tradeId) {
        const value = await tradeFn();
        return { value, _timedOut: false };
    }

    /**
     * Create a timeout promise that resolves with a timeout marker
     * @private
     */
    _createTimeout(tradeId) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                resolve({ _timedOut: true, tradeId });
            }, this.timeoutMs);

            // Store timer ref so we could cancel if needed
            const pending = this.pendingOrders.get(tradeId);
            if (pending) pending._timer = timer;
        });
    }

    /**
     * Update running timing statistics
     * @private
     */
    _updateTimingStats(elapsedMs) {
        const prev = this.stats.avgExecutionMs;
        const n = this.stats.totalSucceeded;
        // Running average
        this.stats.avgExecutionMs = prev + (elapsedMs - prev) / n;
        this.stats.maxExecutionMs = Math.max(this.stats.maxExecutionMs, elapsedMs);
        if (elapsedMs < this.stats.minExecutionMs) {
            this.stats.minExecutionMs = elapsedMs;
        }
    }

    /**
     * Record an order in the recent history
     * @private
     */
    _recordOrder(record) {
        this.stats.recentOrders.unshift(record);
        if (this.stats.recentOrders.length > 50) {
            this.stats.recentOrders.length = 50;
        }
    }

    /**
     * Get status for dashboard
     */
    getStatus() {
        return {
            timeoutMs: this.timeoutMs,
            pending: this.pendingOrders.size,
            pendingOrders: Array.from(this.pendingOrders.values()).map(o => ({
                tradeId: o.tradeId,
                status: o.status,
                elapsedMs: Date.now() - o.startedAt,
            })),
            stats: {
                totalExecuted: this.stats.totalExecuted,
                totalSucceeded: this.stats.totalSucceeded,
                totalTimedOut: this.stats.totalTimedOut,
                totalFailed: this.stats.totalFailed,
                successRate: this.stats.totalExecuted > 0
                    ? ((this.stats.totalSucceeded / this.stats.totalExecuted) * 100).toFixed(1)
                    : '0.0',
                avgExecutionMs: Math.round(this.stats.avgExecutionMs),
                maxExecutionMs: this.stats.maxExecutionMs,
                minExecutionMs: this.stats.minExecutionMs === Infinity ? 0 : this.stats.minExecutionMs,
            },
            recentOrders: this.stats.recentOrders.slice(0, 10),
        };
    }
}

export default OrderManager;
