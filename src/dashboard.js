/**
 * Real-Time Dashboard Server
 * Express + WebSocket — live prices, paper trades, P&L
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboard(bot, trader, config = {}) {
    const port = config.port || 3456;
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

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
                opportunities: bot.currentOpportunities || []
            },
            timestamp: Date.now()
        }));
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`[DASHBOARD] Live at http://localhost:${port}`);
        console.log(`[DASHBOARD] Network: http://192.168.86.23:${port}`);
    });

    return { app, server, wss, broadcast };
}

export default createDashboard;
