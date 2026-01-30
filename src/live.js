/**
 * Live Bot — Main entry point
 * Dual WebSocket: Polymarket + Kalshi real-time feeds
 * Paper trading + live dashboard
 */

import pmxt from 'pmxtjs';
import WebSocket from 'ws';
import { PaperTrader } from './paper-trader.js';
import { MarketScanner } from './market-scanner.js';
import { createDashboard } from './dashboard.js';
import { sendAlert } from './alerts.js';
import { config } from '../config.js';

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // Re-scan every 5 min

class LiveBot {
    constructor() {
        this.config = {
            ...config,
            alertThresholdCents: 2.0,
            totalFeeCents: 0,       // Paper mode: gross spreads
            realFeeCents: 4.0,      // Display-only: what real fees would be
            minProfitCents: 0.3,    // Trade on any gross spread > 0.3¢
        };

        this.polymarket = new pmxt.polymarket({ privateKey: this.config.polymarketPrivateKey });
        this.kalshi = new pmxt.kalshi({ apiKey: this.config.kalshiApiKey, apiSecret: this.config.kalshiApiSecret });

        this.scanner = new MarketScanner(this.config);
        this.trader = new PaperTrader({
            initialBalance: 1000,
            contractSize: 100,
            totalFeeCents: this.config.totalFeeCents
        });

        // State
        this.polyPrices = new Map();
        this.kalshiPrices = new Map();
        this.marketMappings = [];
        this.currentOpportunities = [];
        this.lastUpdate = null;
        this.polyWs = null;
        this.kalshiWs = null;
        this.kalshiMsgId = 1;
        this.dashboard = null;
        this.polyConnected = false;
        this.kalshiConnected = false;
    }

    async start() {
        console.log('╔════════════════════════════════════════════╗');
        console.log('║   🎯 ARB BOT — DUAL WEBSOCKET LIVE MODE   ║');
        console.log('║   Poly WS + Kalshi WS • Paper Trading     ║');
        console.log('╚════════════════════════════════════════════╝\n');

        // 1. Scan & map markets
        await this.scanMarkets();

        // 2. Start dashboard
        this.dashboard = createDashboard(this, this.trader, { port: 3456 });

        // 3. Connect BOTH WebSockets
        this.connectPolyWS();
        this.connectKalshiWS();

        // 4. Re-scan periodically
        setInterval(() => this.scanMarkets(), SCAN_INTERVAL_MS);

        // 5. Tick every 10s — check exits, broadcast state
        setInterval(() => this.tick(), 10000);

        // 6. Kalshi REST fallback every 30s (in case WS misses something)
        setInterval(() => this.pollKalshiFallback(), 30000);

        console.log('\n[LIVE] Bot running. Dashboard live.\n');
    }

    // ── Market Discovery ────────────────────────────────────

    async scanMarkets() {
        try {
            console.log('\n[SCAN] Discovering markets...');

            const polyId = this.extractSlug(this.config.polymarketUrl);
            const kalshiId = this.extractSlug(this.config.kalshiUrl);

            const [polyMarkets, kalshiMarkets] = await Promise.all([
                this.polymarket.getMarketsBySlug(polyId).catch(() => []),
                this.kalshi.getMarketsBySlug(kalshiId).catch(() => [])
            ]);

            this.marketMappings = this.buildMappings(polyMarkets, kalshiMarkets);
            console.log(`[SCAN] Mapped ${this.marketMappings.length} pairs`);

            await this.discoverAdditionalMarkets();

            // Re-subscribe WebSockets to new markets
            if (this.polyConnected) this.subscribePolyMarkets();
            if (this.kalshiConnected) this.subscribeKalshiMarkets();

        } catch (e) {
            console.error('[SCAN] Error:', e.message);
        }
    }

    async discoverAdditionalMarkets() {
        const additionalPairs = [
            { poly: 'will-trump-be-president-on-march-31', kalshi: 'KXTRUMPPRES' },
            { poly: 'bitcoin-100k', kalshi: 'KXBTC' },
            { poly: 'us-recession-2026', kalshi: 'KXRECESSION' },
            { poly: 'fed-funds-rate', kalshi: 'KXFEDRATE' },
        ];

        for (const pair of additionalPairs) {
            try {
                const [polyM, kalshiM] = await Promise.all([
                    this.polymarket.getMarketsBySlug(pair.poly).catch(() => null),
                    this.kalshi.getMarketsBySlug(pair.kalshi).catch(() => null)
                ]);
                if (polyM && kalshiM) {
                    for (const m of this.buildMappings(polyM, kalshiM)) {
                        if (!this.marketMappings.find(e => e.name === m.name)) {
                            this.marketMappings.push(m);
                        }
                    }
                }
            } catch (e) { /* skip */ }
        }

        console.log(`[SCAN] Total mappings: ${this.marketMappings.length}`);
    }

    extractSlug(url) {
        if (url.includes('polymarket')) {
            return url.match(/event\/([^/?]+)/)?.[1] || null;
        }
        const parts = url.split('/');
        return parts[parts.length - 1].toUpperCase();
    }

    buildMappings(polyMarkets, kalshiMarkets) {
        const mappings = [];
        const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

        for (const poly of polyMarkets || []) {
            const polyName = norm(poly.outcomes?.[0]?.label || poly.question || '');

            for (const kalshi of kalshiMarkets || []) {
                const kalshiName = norm(kalshi.outcomes?.[0]?.label || kalshi.title || '');

                const pw = polyName.split(' ').filter(w => w.length > 2);
                const kw = kalshiName.split(' ').filter(w => w.length > 2);
                const common = pw.filter(w => kw.includes(w));

                if (common.length >= 2 || polyName.includes(kalshiName) || kalshiName.includes(polyName)) {
                    const yesOut = poly.outcomes?.find(o =>
                        o.label?.toLowerCase().includes('yes') || o.side === 'yes'
                    );

                    mappings.push({
                        name: poly.outcomes?.[0]?.label || poly.question,
                        polyMarketId: poly.id,
                        polyTokenId: yesOut?.id || poly.outcomes?.[0]?.id,
                        kalshiTicker: kalshi.ticker || kalshi.id,
                        polyMarket: poly,
                        kalshiMarket: kalshi
                    });
                    break;
                }
            }
        }
        return mappings;
    }

    // ── Polymarket WebSocket ────────────────────────────────

    connectPolyWS() {
        console.log('[POLY-WS] Connecting...');
        this.polyWs = new WebSocket(POLY_WS_URL);

        this.polyWs.on('open', () => {
            console.log('[POLY-WS] ✅ Connected');
            this.polyConnected = true;
            this.subscribePolyMarkets();
        });

        this.polyWs.on('message', (data) => {
            try {
                this.handlePolyMessage(JSON.parse(data.toString()));
            } catch (e) { /* ignore */ }
        });

        this.polyWs.on('close', () => {
            console.log('[POLY-WS] Disconnected, reconnecting in 5s...');
            this.polyConnected = false;
            setTimeout(() => this.connectPolyWS(), 5000);
        });

        this.polyWs.on('error', (err) => console.error('[POLY-WS] Error:', err.message));
    }

    subscribePolyMarkets() {
        const tokenIds = this.marketMappings.map(m => m.polyTokenId).filter(Boolean);
        if (tokenIds.length > 0 && this.polyWs?.readyState === 1) {
            this.polyWs.send(JSON.stringify({ type: 'MARKET', assets_ids: tokenIds }));
            console.log(`[POLY-WS] Subscribed to ${tokenIds.length} tokens`);
        }
    }

    handlePolyMessage(msg) {
        const tokenId = msg.asset_id;
        if (!tokenId) return;

        const mapping = this.marketMappings.find(m => m.polyTokenId === tokenId);
        if (!mapping) return;

        const yesPrice = msg.price ? msg.price * 100 : null;
        if (yesPrice !== null) {
            this.polyPrices.set(tokenId, {
                yes: yesPrice,
                no: 100 - yesPrice,
                lastUpdate: Date.now(),
                source: 'ws'
            });
            this.evaluateSpread(mapping);
        }
    }

    // ── Kalshi WebSocket ────────────────────────────────────

    connectKalshiWS() {
        // Try production first, then demo, then fall back to REST
        const endpoints = [
            { url: KALSHI_WS_URL, label: 'production' },
            { url: 'wss://demo-api.kalshi.co/trade-api/ws/v2', label: 'demo' },
        ];
        this._kalshiWsAttempt = (this._kalshiWsAttempt || 0);
        const endpoint = endpoints[this._kalshiWsAttempt % endpoints.length];

        console.log(`[KALSHI-WS] Connecting to ${endpoint.label}...`);
        this.kalshiWs = new WebSocket(endpoint.url);

        this.kalshiWs.on('open', () => {
            console.log(`[KALSHI-WS] ✅ Connected (${endpoint.label})`);
            this.kalshiConnected = true;
            this._kalshiWsAttempt = 0; // reset on success
            this.subscribeKalshiMarkets();
        });

        this.kalshiWs.on('message', (raw) => {
            try {
                this.handleKalshiMessage(JSON.parse(raw.toString()));
            } catch (e) { /* ignore */ }
        });

        this.kalshiWs.on('close', (code) => {
            this.kalshiConnected = false;
            this._kalshiWsAttempt++;

            if (this._kalshiWsAttempt >= endpoints.length * 2) {
                // Both endpoints failed twice — fall back to REST polling
                console.log(`[KALSHI-WS] All endpoints failed. Using REST polling (5s).`);
                this.kalshiRestMode = true;
                this.startKalshiPolling();
            } else {
                const next = endpoints[this._kalshiWsAttempt % endpoints.length];
                console.log(`[KALSHI-WS] Failed (code ${code}), trying ${next.label} in 3s...`);
                setTimeout(() => this.connectKalshiWS(), 3000);
            }
        });

        this.kalshiWs.on('error', (err) => {
            // Suppress repeated error logs
            if (!this._kalshiErrorLogged) {
                console.error('[KALSHI-WS] Error:', err.message);
                this._kalshiErrorLogged = true;
                setTimeout(() => { this._kalshiErrorLogged = false; }, 30000);
            }
        });
    }

    startKalshiPolling() {
        if (this._kalshiPollInterval) return;
        console.log('[KALSHI-REST] Starting 5s polling as fallback');
        this._kalshiPollInterval = setInterval(() => this.pollKalshiFallback(), 5000);
        this.pollKalshiFallback(); // immediate first poll
    }

    subscribeKalshiMarkets() {
        if (!this.kalshiWs || this.kalshiWs.readyState !== 1) return;

        const tickers = this.marketMappings.map(m => m.kalshiTicker).filter(Boolean);
        if (tickers.length === 0) return;

        // Subscribe to ticker channel — public, no auth needed
        const sub = {
            id: this.kalshiMsgId++,
            cmd: 'subscribe',
            params: {
                channels: ['ticker'],
                market_tickers: tickers
            }
        };
        this.kalshiWs.send(JSON.stringify(sub));
        console.log(`[KALSHI-WS] Subscribed to ${tickers.length} tickers`);

        // Also subscribe to trade feed for extra signals
        const tradeSub = {
            id: this.kalshiMsgId++,
            cmd: 'subscribe',
            params: {
                channels: ['trade'],
                market_tickers: tickers
            }
        };
        this.kalshiWs.send(JSON.stringify(tradeSub));
    }

    handleKalshiMessage(msg) {
        const type = msg.type;

        if (type === 'ticker' || type === 'ticker_v2') {
            const data = msg.msg;
            if (!data?.market_ticker) return;

            const ticker = data.market_ticker;
            const yesBid = data.yes_bid ?? null;
            const yesAsk = data.yes_ask ?? null;
            // Kalshi prices are already in cents (1-99)
            const yesPrice = yesBid !== null ? yesBid : (yesAsk !== null ? yesAsk : null);
            const noPrice = yesPrice !== null ? (100 - yesPrice) : null;

            if (yesPrice !== null) {
                this.kalshiPrices.set(ticker, {
                    yes: yesPrice,
                    no: noPrice,
                    yesBid,
                    yesAsk,
                    lastUpdate: Date.now(),
                    source: 'ws'
                });

                const mapping = this.marketMappings.find(m => m.kalshiTicker === ticker);
                if (mapping) this.evaluateSpread(mapping);
            }
        } else if (type === 'trade') {
            const data = msg.msg;
            if (!data?.market_ticker) return;
            // Update with last trade price
            const ticker = data.market_ticker;
            const yesPrice = data.yes_price ?? null;
            if (yesPrice !== null) {
                const existing = this.kalshiPrices.get(ticker) || {};
                this.kalshiPrices.set(ticker, {
                    ...existing,
                    yes: yesPrice,
                    no: 100 - yesPrice,
                    lastTrade: yesPrice,
                    lastUpdate: Date.now(),
                    source: 'ws-trade'
                });
                const mapping = this.marketMappings.find(m => m.kalshiTicker === ticker);
                if (mapping) this.evaluateSpread(mapping);
            }
        } else if (type === 'error') {
            console.error(`[KALSHI-WS] Error ${msg.msg?.code}: ${msg.msg?.msg}`);
        }
    }

    // ── Kalshi REST Fallback ────────────────────────────────

    async pollKalshiFallback() {
        try {
            const kalshiId = this.extractSlug(this.config.kalshiUrl);
            const markets = await this.kalshi.getMarketsBySlug(kalshiId);

            for (const market of markets || []) {
                const ticker = market.ticker || market.id;
                const existing = this.kalshiPrices.get(ticker);

                // Only update if WS hasn't updated in 30s
                if (existing?.source === 'ws' && (Date.now() - existing.lastUpdate) < 30000) continue;

                const yes = market.outcomes?.find(o => o.label?.toLowerCase().includes('yes') || o.side === 'yes');
                const no = market.outcomes?.find(o => o.label?.toLowerCase().includes('no') || o.side === 'no');

                this.kalshiPrices.set(ticker, {
                    yes: (yes?.price || market.outcomes?.[0]?.price || 0) * 100,
                    no: (no?.price || market.outcomes?.[1]?.price || 0) * 100,
                    lastUpdate: Date.now(),
                    source: 'rest-fallback'
                });

                const mapping = this.marketMappings.find(m => m.kalshiTicker === ticker);
                if (mapping) this.evaluateSpread(mapping);
            }
        } catch (e) {
            // Fallback error is non-critical
        }
    }

    // ── Spread Evaluation ───────────────────────────────────

    evaluateSpread(mapping) {
        const poly = this.polyPrices.get(mapping.polyTokenId);
        const kalshi = this.kalshiPrices.get(mapping.kalshiTicker);
        if (!poly || !kalshi) return;

        const fees = this.config.totalFeeCents;
        const strat1 = 100 - poly.yes - kalshi.no - fees;
        const strat2 = 100 - poly.no - kalshi.yes - fees;

        const bestProfit = Math.max(strat1, strat2);
        const strategy = strat1 > strat2 ? 1 : 2;

        // Real fees for display
        const grossSpread = Math.max(
            100 - poly.yes - kalshi.no,
            100 - poly.no - kalshi.yes
        );

        // Update opportunities
        const opp = {
            name: mapping.name,
            profit: bestProfit,
            netProfit: bestProfit,
            grossSpread,
            afterFees: grossSpread - this.config.realFeeCents,
            strategy,
            polyYes: poly.yes,
            polyNo: poly.no,
            kalshiYes: kalshi.yes,
            kalshiNo: kalshi.no,
            polySource: poly.source,
            kalshiSource: kalshi.source,
            lastUpdate: Date.now()
        };

        const idx = this.currentOpportunities.findIndex(o => o.name === mapping.name);
        if (idx >= 0) {
            this.currentOpportunities[idx] = opp;
        } else {
            this.currentOpportunities.push(opp);
        }
        this.currentOpportunities.sort((a, b) => b.netProfit - a.netProfit);
        this.lastUpdate = new Date().toISOString();

        // Paper trade
        if (bestProfit >= this.config.minProfitCents) {
            const trade = this.trader.executeTrade(opp);
            if (trade) {
                console.log(`📈 ENTER ${trade.name} | S${trade.strategy} | Cost: ${(trade.totalCost/100).toFixed(2)}¢ | Exp: +${(trade.expectedProfit/100).toFixed(2)}¢ | Gross: ${grossSpread.toFixed(1)}¢ (−${this.config.realFeeCents}¢ fees)`);
                if (this.dashboard) {
                    this.dashboard.broadcast('trade', trade);
                    this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
                }
            }
        }

        // Alert big opportunities
        if (bestProfit >= this.config.alertThresholdCents) {
            const desc = strategy === 1
                ? `Poly YES (${poly.yes.toFixed(1)}¢) + Kalshi NO (${kalshi.no.toFixed(1)}¢)`
                : `Poly NO (${poly.no.toFixed(1)}¢) + Kalshi YES (${kalshi.yes.toFixed(1)}¢)`;
            sendAlert({ outcome: mapping.name, profit: bestProfit, description: desc }).catch(() => {});
        }
    }

    // ── Tick (every 10s) ────────────────────────────────────

    tick() {
        // Exit positions when spread disappears
        const closed = this.trader.checkExits(this.currentOpportunities);
        for (const trade of closed) {
            const pnl = trade.pnl >= 0 ? `+${(trade.pnl/100).toFixed(2)}` : `${(trade.pnl/100).toFixed(2)}`;
            console.log(`📉 EXIT  ${trade.name} | P&L: ${pnl}¢ | Hold: ${Math.round(trade.holdTime/1000)}s`);
            if (this.dashboard) {
                this.dashboard.broadcast('trade', trade);
                this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
            }
        }

        if (this.dashboard) {
            this.dashboard.broadcast('opportunities', this.currentOpportunities);
        }

        const p = this.trader.getPortfolioSummary();
        const pWs = this.polyConnected ? '🟢' : '🔴';
        const kWs = this.kalshiConnected ? '🟢' : '🔴';
        console.log(`[${new Date().toLocaleTimeString()}] Poly ${pWs} Kalshi ${kWs} | ${this.currentOpportunities.length} opps | ${p.openPositions} pos | P&L: $${p.totalPnL} | Trades: ${p.totalTrades}`);
    }

    stop() {
        if (this.polyWs) this.polyWs.close();
        if (this.kalshiWs) this.kalshiWs.close();
        if (this.dashboard?.server) this.dashboard.server.close();
        console.log('\n[STOPPED]');
    }
}

// ── Start ───────────────────────────────────────────────
const bot = new LiveBot();
process.on('SIGINT', () => { bot.stop(); process.exit(0); });
bot.start().catch(console.error);
