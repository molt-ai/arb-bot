/**
 * Email Alert System
 * Sends critical alerts via Gmail SMTP using Nodemailer
 * 
 * Setup:
 *   1. Go to https://myaccount.google.com/apppasswords
 *   2. Generate an "App password" for "Mail"
 *   3. Set env vars: GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_EMAIL_TO
 * 
 * Only sends for significant events (trades, circuit breaker, daily summary).
 * Batches non-critical alerts to avoid spam.
 */

import nodemailer from 'nodemailer';

export class EmailAlerts {
    constructor(opts = {}) {
        this.from = opts.from || process.env.GMAIL_USER;
        this.to = opts.to || process.env.ALERT_EMAIL_TO || this.from;
        this.appPassword = opts.appPassword || process.env.GMAIL_APP_PASSWORD;
        this.enabled = !!(this.from && this.appPassword);

        this.transporter = null;
        if (this.enabled) {
            this.transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: this.from,
                    pass: this.appPassword,
                },
            });
        }

        // Batch queue for non-critical alerts
        this.queue = [];
        this.batchTimer = null;
        this.batchIntervalMs = opts.batchIntervalMs || 5 * 60 * 1000; // batch every 5 min

        // Stats
        this.stats = {
            sent: 0,
            errors: 0,
            lastSentAt: null,
            queued: 0,
        };
    }

    /**
     * Send an email immediately (for critical alerts)
     */
    async sendNow(subject, body) {
        if (!this.enabled || !this.transporter) {
            console.log(`[EMAIL] Not configured — would send: ${subject}`);
            return false;
        }

        try {
            await this.transporter.sendMail({
                from: `"Arb Bot" <${this.from}>`,
                to: this.to,
                subject: `🎯 ${subject}`,
                text: body,
                html: this._formatHtml(subject, body),
            });
            this.stats.sent++;
            this.stats.lastSentAt = new Date().toISOString();
            console.log(`[EMAIL] Sent: ${subject}`);
            return true;
        } catch (e) {
            this.stats.errors++;
            console.error(`[EMAIL] Error: ${e.message}`);
            return false;
        }
    }

    /**
     * Queue a non-critical alert for batching
     */
    enqueue(subject, body) {
        this.queue.push({ subject, body, time: new Date().toISOString() });
        this.stats.queued = this.queue.length;

        // Start batch timer if not running
        if (!this.batchTimer) {
            this.batchTimer = setTimeout(() => this.flushQueue(), this.batchIntervalMs);
        }
    }

    /**
     * Flush queued alerts into a single digest email
     */
    async flushQueue() {
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        if (this.queue.length === 0) return;

        const items = [...this.queue];
        this.queue = [];
        this.stats.queued = 0;

        const subject = `Arb Bot — ${items.length} alert${items.length > 1 ? 's' : ''}`;
        const body = items.map(i =>
            `[${new Date(i.time).toLocaleTimeString()}] ${i.subject}\n${i.body}`
        ).join('\n\n---\n\n');

        await this.sendNow(subject, body);
    }

    // ── Convenience Methods ──────────────────────────────

    async tradeExecuted(trade) {
        const cost = (trade.totalCost / 100).toFixed(2);
        const net = (trade.expectedNetProfit / 100).toFixed(3);
        const subject = `Trade: ${trade.name}`;
        const body = [
            `Market: ${trade.name}`,
            `Strategy: S${trade.strategy} — ${trade.polySide} (Poly) / ${trade.kalshiSide} (Kalshi)`,
            `Cost: $${cost} | Expected Net: +$${net}`,
            `Contracts: ${trade.contracts}`,
            `Time: ${new Date().toLocaleString()}`,
        ].join('\n');
        this.enqueue(subject, body);
    }

    async circuitBreakerTripped(reason) {
        // Critical — send immediately
        await this.sendNow(
            '🛑 CIRCUIT BREAKER TRIPPED',
            `Trading has been HALTED.\n\nReason: ${reason}\nTime: ${new Date().toLocaleString()}\n\nDashboard: https://molt-arb-bot.fly.dev`
        );
    }

    async circuitBreakerReset() {
        this.enqueue('Circuit Breaker Reset', 'Trading has resumed.');
    }

    async dailySummary(portfolio) {
        const subject = `Daily Summary — P&L: $${portfolio.netPnL}`;
        const body = [
            `📊 Daily Summary — ${new Date().toLocaleDateString()}`,
            ``,
            `P&L: ${parseFloat(portfolio.netPnL) >= 0 ? '+' : ''}$${portfolio.netPnL}`,
            `Total Trades: ${portfolio.totalTrades}`,
            `Win Rate: ${portfolio.winRate}%`,
            `Open Positions: ${portfolio.openPositions}`,
            `Fees Paid: $${portfolio.totalFeesPaid}`,
            `Balance: $${portfolio.totalCash}`,
            ``,
            `Dashboard: https://molt-arb-bot.fly.dev`,
        ].join('\n');
        await this.sendNow(subject, body);
    }

    async botStarted() {
        await this.sendNow('Bot Started', `Arb bot is now running.\nTime: ${new Date().toLocaleString()}\nDashboard: https://molt-arb-bot.fly.dev`);
    }

    async botStopped(reason) {
        // Critical — send immediately
        await this.sendNow('🔴 Bot Stopped', `Arb bot has stopped.\nReason: ${reason}\nTime: ${new Date().toLocaleString()}`);
    }

    async bigOpportunity(opp) {
        const subject = `💰 Opportunity: ${opp.name}`;
        const body = `${opp.name}\nNet profit: ${opp.netProfit?.toFixed(1)}¢/contract\n${opp.description || ''}`;
        this.enqueue(subject, body);
    }

    // ── Helpers ──────────────────────────────────────────

    _formatHtml(subject, body) {
        const lines = body.split('\n').map(l => `<p style="margin:4px 0;font-family:monospace;font-size:14px;">${l.replace(/</g, '&lt;')}</p>`).join('');
        return `
        <div style="background:#0a0a0f;color:#e0e0e8;padding:20px;border-radius:8px;max-width:600px;font-family:system-ui;">
            <h2 style="color:#7c8aff;margin-bottom:16px;">🎯 ${subject}</h2>
            ${lines}
            <hr style="border-color:#2a2a3a;margin:16px 0;">
            <p style="font-size:12px;color:#666;"><a href="https://molt-arb-bot.fly.dev" style="color:#7c8aff;">Open Dashboard</a></p>
        </div>`;
    }

    getStatus() {
        return {
            enabled: this.enabled,
            from: this.from || null,
            to: this.to || null,
            queued: this.queue.length,
            ...this.stats,
        };
    }

    stop() {
        this.flushQueue().catch(() => {});
    }
}

export default EmailAlerts;
