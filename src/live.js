/**
 * Live Bot — Main entry point
 * Combines: WebSocket feeds + Market Scanner + Paper Trader + Dashboard
 */

import pmxt from 'pmxtjs';
import WebSocket from 'ws';
import { PaperTrader } from './paper-trader.js';
import { MarketScanner } from './market-scanner.js';
import { createDashboard } from './dashboard.js';
import { sendAlert } from './alerts.js';
import { config } from '../config.js';

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const KALSHI_POLL_MS = 5000;
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // Re-scan for new markets every 5 min

class LiveBot {
    constructor() {
        this.config = {
            ...config,
            alertThresholdCents: 2.0,
            totalFeeCents: 0, // Paper mode: track gross spreads, show fees separately
            realFeeCents: 4.0, // Display-only: what fees WOULD be
            minProfitCents: 0.3, // Trade on any gross spread > 0.3¢
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
        this.ws = null;
        this.dashboard = null;
    }

    async start() {
        console.log('╔════════════════════════════════════════╗');
        console.log('║   🎯 ARB BOT — LIVE MODE              ║');
        console.log('║   Paper Trading • Real-Time Prices     ║');
        console.log('╚════════════════════════════════════════╝\n');

        // 1. Initial market scan
        await this.scanMarkets();

        // 2. Start dashboard
        this.dashboard = createDashboard(this, this.trader, { port: 3456 });

        // 3. Connect to Polymarket WebSocket
        this.connectPolyWS();

        // 4. Start Kalshi polling
        await this.pollKalshi();
        setInterval(() => this.pollKalshi(), KALSHI_POLL_MS);

        // 5. Re-scan markets periodically
        setInterval(() => this.scanMarkets(), SCAN_INTERVAL_MS);

        // 6. Status + check trades every 10s
        setInterval(() => this.tick(), 10000);

        console.log('\n[LIVE] Bot is running. Dashboard is live.\n');
    }

    async scanMarkets() {
        try {
            console.log('\n[SCAN] Discovering markets...');
            
            // Use the known Fed Chair markets + try to discover more
            const polyId = this.extractSlug(this.config.polymarketUrl);
            const kalshiId = this.extractSlug(this.config.kalshiUrl);
            
            const [polyMarkets, kalshiMarkets] = await Promise.all([
                this.polymarket.getMarketsBySlug(polyId).catch(() => []),
                this.kalshi.getMarketsBySlug(kalshiId).catch(() => [])
            ]);
            
            // Build mappings
            this.marketMappings = this.buildMappings(polyMarkets, kalshiMarkets);
            console.log(`[SCAN] Mapped ${this.marketMappings.length} market pairs\n`);
            
            // Try to discover additional market categories
            await this.discoverAdditionalMarkets();
            
        } catch (e) {
            console.error('[SCAN] Error:', e.message);
        }
    }

    async discoverAdditionalMarkets() {
        // Try popular cross-platform event slugs
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
                    const newMappings = this.buildMappings(polyM, kalshiM);
                    // Add non-duplicate mappings
                    for (const m of newMappings) {
                        if (!this.marketMappings.find(existing => existing.name === m.name)) {
                            this.marketMappings.push(m);
                        }
                    }
                }
            } catch (e) { /* skip */ }
        }
        
        if (this.marketMappings.length > 0) {
            console.log(`[SCAN] Total mappings after discovery: ${this.marketMappings.length}`);
        }
    }

    extractSlug(url) {
        if (url.includes('polymarket')) {
            const match = url.match(/event\/([^/?]+)/);
            return match ? match[1] : null;
        } else {
            const parts = url.split('/');
            return parts[parts.length - 1].toUpperCase();
        }
    }

    buildMappings(polyMarkets, kalshiMarkets) {
        const mappings = [];
        const normalize = (s) => s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
        
        for (const poly of polyMarkets || []) {
            const polyName = normalize(poly.outcomes?.[0]?.label || poly.question || '');
            
            for (const kalshi of kalshiMarkets || []) {
                const kalshiName = normalize(kalshi.outcomes?.[0]?.label || kalshi.title || '');
                
                const polyWords = polyName.split(' ').filter(w => w.length > 2);
                const kalshiWords = kalshiName.split(' ').filter(w => w.length > 2);
                const common = polyWords.filter(w => kalshiWords.includes(w));
                
                if (common.length >= 2 || polyName.includes(kalshiName) || kalshiName.includes(polyName)) {
                    const yesOut = poly.outcomes?.find(o => o.label?.toLowerCase().includes('yes') || o.side === 'yes');
                    
                    mappings.push({
                        name: poly.outcomes?.[0]?.label || poly.question,
                        polyMarketId: poly.id,
                        polyTokenId: yesOut?.id || poly.outcomes?.[0]?.id,
                        kalshiTicker: kalshi.id,
                        polyMarket: poly,
                        kalshiMarket: kalshi
                    });
                    break;
                }
            }
        }
        
        return mappings;
    }

    connectPolyWS() {
        console.log('[WS] Connecting to Polymarket...');
        this.ws = new WebSocket(POLY_WS_URL);
        
        this.ws.on('open', () => {
            console.log('[WS] Connected');
            const tokenIds = this.marketMappings.map(m => m.polyTokenId).filter(Boolean);
            if (tokenIds.length > 0) {
                this.ws.send(JSON.stringify({ type: 'MARKET', assets_ids: tokenIds }));
                console.log(`[WS] Subscribed to ${tokenIds.length} tokens`);
            }
        });
        
        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handlePolyUpdate(msg);
            } catch (e) { /* ignore */ }
        });
        
        this.ws.on('close', () => {
            console.log('[WS] Disconnected, reconnecting in 5s...');
            setTimeout(() => this.connectPolyWS(), 5000);
        });
        
        this.ws.on('error', (err) => console.error('[WS] Error:', err.message));
    }

    handlePolyUpdate(msg) {
        const tokenId = msg.asset_id;
        if (!tokenId) return;
        
        const mapping = this.marketMappings.find(m => m.polyTokenId === tokenId);
        if (!mapping) return;
        
        const yesPrice = msg.price ? msg.price * 100 : null;
        if (yesPrice !== null) {
            this.polyPrices.set(tokenId, {
                yes: yesPrice,
                no: 100 - yesPrice,
                lastUpdate: Date.now()
            });
            this.checkOpportunity(mapping);
        }
    }

    async pollKalshi() {
        try {
            const kalshiId = this.extractSlug(this.config.kalshiUrl);
            const markets = await this.kalshi.getMarketsBySlug(kalshiId);
            
            for (const market of markets || []) {
                const yes = market.outcomes?.find(o => o.label?.toLowerCase().includes('yes') || o.side === 'yes');
                const no = market.outcomes?.find(o => o.label?.toLowerCase().includes('no') || o.side === 'no');
                
                this.kalshiPrices.set(market.id, {
                    yes: (yes?.price || market.outcomes?.[0]?.price || 0) * 100,
                    no: (no?.price || market.outcomes?.[1]?.price || 0) * 100,
                    lastUpdate: Date.now()
                });
                
                const mapping = this.marketMappings.find(m => m.kalshiTicker === market.id);
                if (mapping) this.checkOpportunity(mapping);
            }
        } catch (e) {
            console.error('[KALSHI] Poll error:', e.message);
        }
    }

    checkOpportunity(mapping) {
        const poly = this.polyPrices.get(mapping.polyTokenId);
        const kalshi = this.kalshiPrices.get(mapping.kalshiTicker);
        if (!poly || !kalshi) return;
        
        const strat1 = 100 - poly.yes - kalshi.no - this.config.totalFeeCents;
        const strat2 = 100 - poly.no - kalshi.yes - this.config.totalFeeCents;
        
        const bestProfit = Math.max(strat1, strat2);
        const strategy = strat1 > strat2 ? 1 : 2;
        
        // Update opportunities list
        const existing = this.currentOpportunities.findIndex(o => o.name === mapping.name);
        const opp = {
            name: mapping.name,
            profit: bestProfit,
            netProfit: bestProfit,
            strategy,
            polyYes: poly.yes,
            polyNo: poly.no,
            kalshiYes: kalshi.yes,
            kalshiNo: kalshi.no,
            lastUpdate: Date.now()
        };
        
        if (existing >= 0) {
            this.currentOpportunities[existing] = opp;
        } else {
            this.currentOpportunities.push(opp);
        }
        
        // Sort by profit
        this.currentOpportunities.sort((a, b) => b.netProfit - a.netProfit);
        this.lastUpdate = new Date().toISOString();
        
        // Paper trade if profitable
        if (bestProfit >= this.config.minProfitCents) {
            const trade = this.trader.executeTrade(opp);
            if (trade) {
                console.log(`📈 [PAPER TRADE] Entered ${trade.name} | Strategy ${trade.strategy} | Cost: ${(trade.totalCost/100).toFixed(2)}¢ | Expected: +${(trade.expectedProfit/100).toFixed(2)}¢`);
                
                // Broadcast to dashboard
                if (this.dashboard) {
                    this.dashboard.broadcast('trade', trade);
                    this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
                }
            }
        }
        
        // Alert for big opportunities
        if (bestProfit >= this.config.alertThresholdCents) {
            const stratDesc = strategy === 1
                ? `Poly YES (${poly.yes.toFixed(1)}¢) + Kalshi NO (${kalshi.no.toFixed(1)}¢)`
                : `Poly NO (${poly.no.toFixed(1)}¢) + Kalshi YES (${kalshi.yes.toFixed(1)}¢)`;
            
            sendAlert({
                outcome: mapping.name,
                profit: bestProfit,
                description: stratDesc
            }).catch(() => {});
        }
    }

    tick() {
        // Check if any positions should be closed
        const closedTrades = this.trader.checkExits(this.currentOpportunities);
        
        for (const trade of closedTrades) {
            const pnlStr = trade.pnl >= 0 ? `+${(trade.pnl/100).toFixed(2)}` : `${(trade.pnl/100).toFixed(2)}`;
            console.log(`📉 [PAPER EXIT] ${trade.name} | P&L: ${pnlStr}¢ | Hold: ${Math.round(trade.holdTime/1000)}s`);
            
            if (this.dashboard) {
                this.dashboard.broadcast('trade', trade);
                this.dashboard.broadcast('portfolio', this.trader.getPortfolioSummary());
            }
        }
        
        // Broadcast current state
        if (this.dashboard) {
            this.dashboard.broadcast('opportunities', this.currentOpportunities);
        }
        
        // Status log
        const portfolio = this.trader.getPortfolioSummary();
        const wsState = this.ws?.readyState === 1 ? '🟢' : '🔴';
        console.log(`[${new Date().toLocaleTimeString()}] ${wsState} WS | ${this.currentOpportunities.length} opps | ${portfolio.openPositions} positions | P&L: $${portfolio.totalPnL} | Trades: ${portfolio.totalTrades}`);
    }

    stop() {
        if (this.ws) this.ws.close();
        if (this.dashboard?.server) this.dashboard.server.close();
        console.log('\n[STOPPED]');
    }
}

// Start
const bot = new LiveBot();

process.on('SIGINT', () => {
    bot.stop();
    process.exit(0);
});

bot.start().catch(console.error);
