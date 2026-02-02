/**
 * Alert System for Arb Bot
 * Sends notifications via webhook (Clawdbot, Slack, Discord, etc.)
 * 
 * Configure via environment variables:
 *   ALERT_WEBHOOK_URL — POST endpoint that receives { text, level, source }
 *   ALERT_IMESSAGE_NUMBER — if set, uses Clawdbot iMessage relay
 *   ALERT_COOLDOWN_MS — min time between same-type alerts (default: 60s)
 */

const LEVELS = { INFO: 'info', WARN: 'warn', CRITICAL: 'critical' };

export class AlertManager {
    constructor(opts = {}) {
        this.webhookUrl = opts.webhookUrl || process.env.ALERT_WEBHOOK_URL || null;
        this.cooldownMs = opts.cooldownMs || parseInt(process.env.ALERT_COOLDOWN_MS || '60000');
        this.enabled = opts.enabled ?? true;
        
        // Track last alert time per type to avoid spamming
        this.lastAlertTime = new Map();
        
        // Stats
        this.stats = {
            totalSent: 0,
            totalSuppressed: 0,
            lastSentAt: null,
            errors: 0,
            byLevel: { info: 0, warn: 0, critical: 0 },
        };

        // Queue for batch sending
        this.queue = [];
        this.flushTimer = null;
        this.flushIntervalMs = opts.flushIntervalMs || 5000; // batch every 5s
    }

    /**
     * Send an alert. Respects cooldown per alert type.
     * @param {string} type - Alert type key (e.g. 'trade_executed', 'circuit_breaker')
     * @param {string} message - Human-readable message
     * @param {string} level - 'info', 'warn', 'critical'
     */
    async send(type, message, level = LEVELS.INFO) {
        if (!this.enabled) return;

        // Critical alerts bypass cooldown
        if (level !== LEVELS.CRITICAL) {
            const lastTime = this.lastAlertTime.get(type) || 0;
            if (Date.now() - lastTime < this.cooldownMs) {
                this.stats.totalSuppressed++;
                return;
            }
        }

        this.lastAlertTime.set(type, Date.now());
        
        const alert = {
            type,
            message,
            level,
            timestamp: new Date().toISOString(),
            source: 'arb-bot',
        };

        // Queue it
        this.queue.push(alert);
        
        // If critical, flush immediately
        if (level === LEVELS.CRITICAL) {
            await this.flush();
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
        }
    }

    async flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.queue.length === 0) return;

        const alerts = [...this.queue];
        this.queue = [];

        // Build consolidated message
        const lines = alerts.map(a => {
            const icon = a.level === 'critical' ? '🚨' : a.level === 'warn' ? '⚠️' : 'ℹ️';
            return `${icon} ${a.message}`;
        });
        const text = lines.join('\n');

        // Send via webhook
        if (this.webhookUrl) {
            try {
                const resp = await fetch(this.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text,
                        alerts,
                        level: alerts.some(a => a.level === 'critical') ? 'critical' :
                               alerts.some(a => a.level === 'warn') ? 'warn' : 'info',
                    }),
                    signal: AbortSignal.timeout(5000),
                });
                if (resp.ok) {
                    this.stats.totalSent += alerts.length;
                    this.stats.lastSentAt = new Date().toISOString();
                    for (const a of alerts) {
                        this.stats.byLevel[a.level] = (this.stats.byLevel[a.level] || 0) + 1;
                    }
                } else {
                    this.stats.errors++;
                    console.error(`[ALERT] Webhook returned ${resp.status}`);
                }
            } catch (e) {
                this.stats.errors++;
                console.error(`[ALERT] Webhook error: ${e.message}`);
            }
        }

        // Always log to console
        console.log(`[ALERT] ${text}`);
    }

    // Convenience methods
    async tradeExecuted(trade) {
        const net = (trade.expectedNetProfit / 100).toFixed(3);
        const cost = (trade.totalCost / 100).toFixed(2);
        await this.send('trade_executed',
            `Trade: ${trade.name} | S${trade.strategy} ${trade.polySide}/${trade.kalshiSide} | Cost: $${cost} | Expected: +$${net}`,
            LEVELS.INFO
        );
    }

    async tradeFailed(name, error) {
        await this.send('trade_failed',
            `Trade FAILED: ${name} — ${error}`,
            LEVELS.WARN
        );
    }

    async circuitBreakerTripped(reason) {
        await this.send('circuit_breaker',
            `🛑 CIRCUIT BREAKER TRIPPED: ${reason}. All trading halted.`,
            LEVELS.CRITICAL
        );
    }

    async circuitBreakerReset() {
        await this.send('circuit_breaker_reset',
            `✅ Circuit breaker reset. Trading resumed.`,
            LEVELS.INFO
        );
    }

    async positionRedeemed(name, pnl) {
        const pnlStr = (pnl / 100).toFixed(3);
        await this.send('position_redeemed',
            `Position resolved: ${name} | P&L: ${pnl >= 0 ? '+' : ''}$${pnlStr}`,
            LEVELS.INFO
        );
    }

    async dailySummary(portfolio) {
        const lines = [
            `📊 Daily Summary`,
            `P&L: ${portfolio.netPnL >= 0 ? '+' : ''}$${portfolio.netPnL}`,
            `Trades: ${portfolio.totalTrades} | Win: ${portfolio.winRate}%`,
            `Open: ${portfolio.openPositions} | Fees: $${portfolio.totalFeesPaid}`,
            `Balance: $${portfolio.totalCash}`,
        ];
        await this.send('daily_summary', lines.join('\n'), LEVELS.INFO);
    }

    async botStarted() {
        await this.send('bot_started', '🟢 Arb bot started', LEVELS.INFO);
    }

    async botStopped(reason = 'normal') {
        await this.send('bot_stopped', `🔴 Arb bot stopped: ${reason}`, LEVELS.WARN);
    }

    async bigOpportunity(opp) {
        const net = opp.netProfit?.toFixed(1) || '?';
        await this.send('big_opportunity',
            `💰 Big opportunity: ${opp.name} | ${net}¢/contract net profit`,
            LEVELS.INFO
        );
    }

    getStatus() {
        return {
            enabled: this.enabled,
            hasWebhook: !!this.webhookUrl,
            queueLength: this.queue.length,
            ...this.stats,
        };
    }

    stop() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // Flush remaining
        this.flush().catch(() => {});
    }
}

export const ALERT_LEVELS = LEVELS;
export default AlertManager;
