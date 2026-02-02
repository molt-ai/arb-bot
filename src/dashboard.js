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

    // New strategy endpoints
    app.get('/api/crypto-speed', (req, res) => {
        res.json({
            stats: bot.cryptoSpeed?.getStats() || {},
            binance: bot.binanceFeed?.getSnapshot() || {},
        });
    });

    app.get('/api/same-market', (req, res) => {
        res.json({
            stats: bot.sameMarketArb?.getStats() || {},
            opportunities: bot.sameMarketArb?.getOpportunities() || [],
        });
    });

    app.get('/api/combinatorial', (req, res) => {
        res.json(bot.combinatorialArb?.getState() || { stats: {}, opportunities: [] });
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

    // Chainlink price feed data
    app.get('/api/chainlink', (req, res) => {
        const cl = bot.chainlinkFeed;
        if (!cl) {
            return res.json({ connected: false, prices: {} });
        }
        const snapshot = cl.getSnapshot();
        // Also compute divergence against exchange prices
        const divergence = {};
        for (const ticker of ['BTC', 'ETH', 'SOL']) {
            const exchangePrice = bot.binanceFeed?.getPrice(ticker) || 0;
            if (exchangePrice > 0) {
                divergence[ticker] = cl.getDivergence(ticker, exchangePrice);
            }
        }
        res.json({ ...snapshot, divergence });
    });

    // Daily report endpoint — summary of bot activity
    app.get('/api/report', (req, res) => {
        const portfolio = trader.getPortfolioSummary();
        const combo = bot.combinatorialArb?.getState() || { stats: {}, opportunities: [] };
        const crypto = bot.cryptoSpeed?.getStats() || {};
        const sameMarket = bot.sameMarketArb?.getStats() || {};
        const binance = bot.binanceFeed?.getSnapshot() || {};

        // Calculate uptime
        const startedAt = portfolio.startedAt ? new Date(portfolio.startedAt) : null;
        const uptimeMs = startedAt ? Date.now() - startedAt.getTime() : 0;
        const uptimeHours = Math.round(uptimeMs / 3600000 * 10) / 10;

        // Cross-platform opportunities
        const xpOpps = bot.currentOpportunities || [];
        const profitableXP = xpOpps.filter(o => o.isProfitable);

        // Build text summary
        const lines = [];
        lines.push(`🎯 Arb Bot Daily Report`);
        lines.push(`Uptime: ${uptimeHours}h | Started: ${startedAt?.toISOString()?.slice(0, 16) || 'unknown'}`);
        lines.push('');
        
        // Portfolio
        lines.push(`💰 Portfolio: $${portfolio.totalValue} (${portfolio.netPnL >= 0 ? '+' : ''}$${portfolio.netPnL})`);
        lines.push(`   Trades: ${portfolio.totalTrades} | Win rate: ${portfolio.winRate}% | Open: ${portfolio.openPositions}`);
        
        // Strategy breakdown
        lines.push('');
        lines.push('📊 Strategy Status:');
        lines.push(`  XP Arb: ${xpOpps.length} pairs scanned, ${profitableXP.length} profitable`);
        lines.push(`  Crypto Speed: ${crypto.evaluations || 0} evals, ${crypto.signals || 0} signals, ${crypto.trades || 0} trades`);
        lines.push(`  Same-Market: ${sameMarket.scans || 0} scans, ${sameMarket.found || 0} found`);
        lines.push(`  Combinatorial: ${combo.stats.scans || 0} scans, ${combo.stats.opportunitiesFound || 0} opps, ${combo.stats.trades || 0} trades`);
        
        // Live crypto prices
        if (binance.BTC) {
            lines.push('');
            lines.push(`₿ BTC: $${binance.BTC.price?.toLocaleString() || '?'}`);
            if (binance.ETH) lines.push(`Ξ ETH: $${binance.ETH.price?.toLocaleString() || '?'}`);
            if (binance.SOL) lines.push(`◎ SOL: $${binance.SOL.price?.toLocaleString() || '?'}`);
        }

        // Chainlink price feed status
        const chainlink = bot.chainlinkFeed?.getSnapshot() || {};
        if (chainlink.prices?.BTC?.price) {
            lines.push('');
            lines.push(`🔗 Chainlink: BTC $${chainlink.prices.BTC.price.toLocaleString()} (${chainlink.connected ? '🟢 live' : '🔴 offline'})`);
            // Show divergence if both prices available
            if (binance.BTC?.price && chainlink.prices.BTC.price) {
                const div = bot.chainlinkFeed?.getDivergence('BTC', binance.BTC.price) || {};
                if (div.divergencePct !== null) {
                    lines.push(`   Exchange vs Chainlink: ${div.divergencePct > 0 ? '+' : ''}${div.divergencePct.toFixed(3)}% ($${div.divergenceUsd?.toFixed(2)})`);
                }
            }
        }
        
        // Active opportunities
        if (combo.opportunities.length > 0) {
            lines.push('');
            lines.push('🔥 Active Opportunities:');
            for (const opp of combo.opportunities.slice(0, 3)) {
                lines.push(`  ${opp.type}: ${opp.edge}¢ edge — ${opp.reason?.substring(0, 60)}`);
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
            portfolio,
            strategies: {
                crossPlatform: { pairs: xpOpps.length, profitable: profitableXP.length },
                cryptoSpeed: crypto,
                sameMarket: sameMarket,
                combinatorial: combo.stats,
            },
            cryptoPrices: binance,
            chainlink: bot.chainlinkFeed?.getSnapshot() || {},
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
                chainlink: bot.chainlinkFeed?.getSnapshot() || {},
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
