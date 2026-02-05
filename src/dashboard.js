/**
 * Real-Time Dashboard Server
 * Express + WebSocket — live prices, paper trades, P&L
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDailyStats, getRecentNearMisses } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboard(bot, trader, config = {}) {
    const port = config.port || 3456;
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    // Health check — responds immediately, no dependencies
    app.get('/health', (req, res) => {
        res.json({ ok: true, uptime: process.uptime() });
    });

    // Serve static files
    app.use(express.static(path.join(__dirname, '..', 'public')));

    // API endpoints
    app.get('/api/portfolio', (req, res) => {
        res.json(trader.getPortfolioSummary());
    });

    app.get('/api/opportunities', (req, res) => {
        res.json({
            opportunities: bot.currentOpportunities || [],
            lastUpdate: bot.lastUpdate || null
        });
    });

    app.get('/api/prices', (req, res) => {
        const prices = {};
        for (const [key, val] of bot.polyPrices || new Map()) {
            prices[`poly-${key}`] = val;
        }
        for (const [key, val] of bot.kalshiPrices || new Map()) {
            prices[`kalshi-${key}`] = val;
        }
        res.json(prices);
    });

    app.post('/api/reset', (req, res) => {
        trader.reset();
        res.json({ ok: true, message: 'Portfolio reset' });
    });

    // Alert system status
    app.get('/api/alerts', (req, res) => {
        res.json({
            webhookAlerts: bot.alerts?.getStatus() || { enabled: false },
            emailAlerts: bot.email?.getStatus() || { enabled: false },
        });
    });

    // Circuit breaker status
    app.get('/api/circuit-breaker', (req, res) => {
        const cb = bot.circuitBreaker;
        if (!cb) {
            return res.json({ error: 'Circuit breaker not initialized' });
        }
        res.json(cb.getStatus());
    });

    // Circuit breaker reset
    app.post('/api/circuit-breaker/reset', (req, res) => {
        const cb = bot.circuitBreaker;
        if (!cb) {
            return res.status(404).json({ error: 'Circuit breaker not initialized' });
        }
        cb.reset();
        res.json({ ok: true, status: cb.getStatus() });
    });

    // Daily report endpoint — summary of bot activity
    app.get('/api/report', (req, res) => {
        const portfolio = trader.getPortfolioSummary();

        // Calculate uptime
        const startedAt = portfolio.startedAt ? new Date(portfolio.startedAt) : null;
        const uptimeMs = startedAt ? Date.now() - startedAt.getTime() : 0;
        const uptimeHours = Math.round(uptimeMs / 3600000 * 10) / 10;

        // Cross-platform opportunities
        const xpOpps = bot.currentOpportunities || [];
        const profitableXP = xpOpps.filter(o => o.isProfitable);

        // Build text summary
        const executionMode = bot.isLiveMode ? '🔴 LIVE' : '📄 PAPER';
        const proxyConfigured = !!(bot.liveExecutor?.proxyUrl && bot.liveExecutor?.proxyToken);

        const lines = [];
        lines.push(`🎯 Arb Bot Daily Report — ${executionMode}`);
        lines.push(`Uptime: ${uptimeHours}h | Started: ${startedAt?.toISOString()?.slice(0, 16) || 'unknown'}`);
        lines.push(`Proxy: ${proxyConfigured ? '✅ configured' : '❌ not configured'}`);
        lines.push('');
        
        // Portfolio
        lines.push(`💰 Portfolio: $${portfolio.totalValue} (${portfolio.netPnL >= 0 ? '+' : ''}$${portfolio.netPnL})`);
        lines.push(`   Trades: ${portfolio.totalTrades} | Win rate: ${portfolio.winRate}% | Open: ${portfolio.openPositions}`);
        
        // Cross-platform arb stats
        lines.push('');
        lines.push(`📊 Cross-Platform Arb: ${xpOpps.length} pairs scanned, ${profitableXP.length} profitable`);

        // Top opportunities
        if (profitableXP.length > 0) {
            lines.push('');
            lines.push('🔥 Top Opportunities:');
            for (const opp of profitableXP.slice(0, 5)) {
                const net = opp.netProfit ?? (opp.grossSpread - (opp.fees || 0));
                lines.push(`  ${opp.name?.substring(0, 50)} | Net: ${net.toFixed(1)}¢`);
            }
        }

        // Active positions
        if (portfolio.positions && portfolio.positions.length > 0) {
            lines.push('');
            lines.push('📌 Open Positions:');
            for (const pos of portfolio.positions.slice(0, 5)) {
                lines.push(`  ${pos.name?.substring(0, 50)} | ${pos.side} @ ${pos.entryPrice}¢`);
            }
        }

        res.json({
            text: lines.join('\n'),
            mode: bot.isLiveMode ? 'live' : 'paper',
            proxyConfigured,
            portfolio,
            crossPlatform: { pairs: xpOpps.length, profitable: profitableXP.length },
            liveExecutor: bot.liveExecutor?.getStatus() || null,
            uptime: { hours: uptimeHours, since: startedAt?.toISOString() },
            generatedAt: new Date().toISOString(),
        });
    });

    // Auto-redemption status
    app.get('/api/auto-redeem', (req, res) => {
        res.json(bot.autoRedeemer?.getStatus() || { running: false, stats: {} });
    });

    // Order manager status
    app.get('/api/order-manager', (req, res) => {
        res.json(bot.orderManager?.getStatus() || { pending: 0, stats: {} });
    });

    // Resolution watcher status (settlement lag opportunities)
    app.get('/api/resolution-watcher', (req, res) => {
        res.json(bot.resolutionWatcher?.getStatus() || { running: false, opportunities: [], stats: {} });
    });

    // Live executor status & audit log
    app.get('/api/live-executor', (req, res) => {
        res.json(bot.liveExecutor?.getStatus() || { mode: 'paper', stats: {} });
    });

    // Execution config — single view of mode, proxy, safety settings
    app.get('/api/execution-config', (req, res) => {
        const executor = bot.liveExecutor;
        res.json({
            mode: bot.isLiveMode ? 'live' : 'paper',
            dryRun: executor ? executor.dryRun : true,
            proxyConfigured: !!(executor?.proxyUrl && executor?.proxyToken),
            proxyUrl: executor?.proxyUrl ? executor.proxyUrl.replace(/\/proxy.*/, '/...') : null,
            kalshiCredsLoaded: !!executor?.kalshiCreds,
            minOrderDollars: executor?.minOrderDollars || 1.10,
            circuitBreaker: bot.circuitBreaker?.getStatus() || null,
        });
    });

    // Daily stats — last 30 days
    app.get('/api/stats/daily', (req, res) => {
        const stats = getDailyStats(30);
        if (stats === null) {
            return res.status(503).json({ error: 'SQLite unavailable' });
        }
        res.json({ stats });
    });

    // Near misses — last 50
    app.get('/api/near-misses', (req, res) => {
        const misses = getRecentNearMisses(50);
        if (misses === null) {
            return res.status(503).json({ error: 'SQLite unavailable' });
        }
        res.json({ nearMisses: misses });
    });

    // WebSocket broadcast
    const broadcast = (type, data) => {
        const msg = JSON.stringify({ type, data, timestamp: Date.now() });
        wss.clients.forEach(client => {
            if (client.readyState === 1) client.send(msg);
        });
    };

    wss.on('connection', (ws) => {
        // Send initial state
        ws.send(JSON.stringify({
            type: 'init',
            data: {
                portfolio: trader.getPortfolioSummary(),
                opportunities: bot.currentOpportunities || [],
                circuitBreaker: bot.circuitBreaker?.getStatus() || null,
            },
            timestamp: Date.now()
        }));
    });

    const ready = new Promise((resolve, reject) => {
        server.listen(port, '0.0.0.0', () => {
            console.log(`[DASHBOARD] Live at http://localhost:${port}`);
            console.log(`[DASHBOARD] Network: http://0.0.0.0:${port}`);
            resolve();
        });
        server.on('error', reject);
    });

    return { app, server, wss, broadcast, ready };
}

export default createDashboard;
