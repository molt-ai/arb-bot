/**
 * WebSocket-based Real-Time Arbitrage Bot
 * 
 * Uses Polymarket WebSocket for real-time prices + faster Kalshi polling
 * Alerts instantly when spreads cross threshold
 */

import WebSocket from 'ws';
import pmxt from 'pmxtjs';
import { sendAlert } from './alerts.js';

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const KALSHI_POLL_MS = 5000; // Poll Kalshi every 5 seconds

export class RealtimeArbBot {
    constructor(config) {
        this.config = config;
        this.kalshi = new pmxt.kalshi({ 
            apiKey: config.kalshiApiKey, 
            apiSecret: config.kalshiApiSecret 
        });
        this.polymarket = new pmxt.polymarket({ 
            privateKey: config.polymarketPrivateKey 
        });
        
        // Price caches
        this.polyPrices = new Map();  // tokenId -> {yes, no, lastUpdate}
        this.kalshiPrices = new Map(); // ticker -> {yes, no, lastUpdate}
        
        // Market mappings (Fed Chair candidates)
        this.marketMappings = [];
        this.ws = null;
        this.kalshiInterval = null;
        this.alertCooldown = new Map(); // Prevent alert spam
    }

    async initialize() {
        console.log('[INIT] Fetching market data to build mappings...');
        
        // Get markets from both platforms
        const polyId = this.extractMarketId(this.config.polymarketUrl, 'polymarket');
        const kalshiId = this.extractMarketId(this.config.kalshiUrl, 'kalshi');
        
        const [polyMarkets, kalshiMarkets] = await Promise.all([
            this.polymarket.getMarketsBySlug(polyId),
            this.kalshi.getMarketsBySlug(kalshiId)
        ]);
        
        // Build mappings between Poly token IDs and Kalshi tickers
        this.buildMappings(polyMarkets, kalshiMarkets);
        
        console.log(`[INIT] Mapped ${this.marketMappings.length} markets`);
        this.marketMappings.forEach(m => {
            console.log(`  - ${m.name}: Poly(${m.polyTokenId?.slice(0,8)}...) <-> Kalshi(${m.kalshiTicker})`);
        });
    }

    extractMarketId(url, platform) {
        if (platform === 'polymarket') {
            const match = url.match(/event\/([^/?]+)/);
            return match ? match[1] : null;
        } else {
            const parts = url.split('/');
            return parts[parts.length - 1].toUpperCase();
        }
    }

    buildMappings(polyMarkets, kalshiMarkets) {
        // Normalize names for matching
        const normalize = (name) => name.toLowerCase()
            .replace(/[^a-z\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        
        for (const poly of polyMarkets) {
            const polyName = normalize(poly.outcomes?.[0]?.label || poly.question || '');
            
            for (const kalshi of kalshiMarkets) {
                const kalshiName = normalize(kalshi.outcomes?.[0]?.label || kalshi.title || '');
                
                // Check for name overlap (at least 2 words in common)
                const polyWords = polyName.split(' ').filter(w => w.length > 2);
                const kalshiWords = kalshiName.split(' ').filter(w => w.length > 2);
                const commonWords = polyWords.filter(w => kalshiWords.includes(w));
                
                if (commonWords.length >= 2 || polyName.includes(kalshiName) || kalshiName.includes(polyName)) {
                    const yesOutcome = poly.outcomes?.find(o => 
                        o.label?.toLowerCase().includes('yes') || o.side === 'yes'
                    );
                    
                    this.marketMappings.push({
                        name: poly.outcomes?.[0]?.label || poly.question,
                        polyMarketId: poly.id,
                        polyTokenId: yesOutcome?.id || poly.outcomes?.[0]?.id,
                        kalshiTicker: kalshi.id,
                        kalshiMarketId: kalshi.id
                    });
                    break;
                }
            }
        }
    }

    connectPolyWebSocket() {
        console.log('[WS] Connecting to Polymarket WebSocket...');
        
        this.ws = new WebSocket(POLY_WS_URL);
        
        this.ws.on('open', () => {
            console.log('[WS] Connected to Polymarket');
            
            // Subscribe to all mapped token IDs
            const tokenIds = this.marketMappings
                .map(m => m.polyTokenId)
                .filter(Boolean);
            
            if (tokenIds.length > 0) {
                const subscribeMsg = {
                    type: 'MARKET',
                    assets_ids: tokenIds
                };
                this.ws.send(JSON.stringify(subscribeMsg));
                console.log(`[WS] Subscribed to ${tokenIds.length} tokens`);
            }
        });
        
        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handlePolyMessage(msg);
            } catch (e) {
                // Ignore parse errors (heartbeats, etc.)
            }
        });
        
        this.ws.on('close', () => {
            console.log('[WS] Disconnected, reconnecting in 5s...');
            setTimeout(() => this.connectPolyWebSocket(), 5000);
        });
        
        this.ws.on('error', (err) => {
            console.error('[WS] Error:', err.message);
        });
    }

    handlePolyMessage(msg) {
        // Handle different message types from Polymarket
        if (msg.event_type === 'book' || msg.event_type === 'price_change') {
            const tokenId = msg.asset_id;
            const mapping = this.marketMappings.find(m => m.polyTokenId === tokenId);
            
            if (mapping) {
                // Extract best bid/ask prices
                const yesPrice = msg.price ? msg.price * 100 : null;
                const noPrice = yesPrice ? (100 - yesPrice) : null;
                
                if (yesPrice !== null) {
                    this.polyPrices.set(tokenId, {
                        yes: yesPrice,
                        no: noPrice,
                        lastUpdate: Date.now()
                    });
                    
                    // Check for arb immediately
                    this.checkArbitrage(mapping);
                }
            }
        }
    }

    async pollKalshi() {
        try {
            const kalshiId = this.extractMarketId(this.config.kalshiUrl, 'kalshi');
            const markets = await this.kalshi.getMarketsBySlug(kalshiId);
            
            for (const market of markets) {
                const yesOutcome = market.outcomes?.find(o => 
                    o.label?.toLowerCase().includes('yes') || o.side === 'yes'
                );
                const noOutcome = market.outcomes?.find(o => 
                    o.label?.toLowerCase().includes('no') || o.side === 'no'
                );
                
                const yesPrice = (yesOutcome?.price || market.outcomes?.[0]?.price || 0) * 100;
                const noPrice = (noOutcome?.price || market.outcomes?.[1]?.price || 0) * 100;
                
                this.kalshiPrices.set(market.id, {
                    yes: yesPrice,
                    no: noPrice,
                    lastUpdate: Date.now()
                });
                
                // Check arb for this market
                const mapping = this.marketMappings.find(m => m.kalshiTicker === market.id);
                if (mapping) {
                    this.checkArbitrage(mapping);
                }
            }
        } catch (e) {
            console.error('[KALSHI] Poll error:', e.message);
        }
    }

    checkArbitrage(mapping) {
        const poly = this.polyPrices.get(mapping.polyTokenId);
        const kalshi = this.kalshiPrices.get(mapping.kalshiTicker);
        
        if (!poly || !kalshi) return;
        
        // Strategy 1: Buy Poly YES + Kalshi NO
        const strat1Profit = 100 - poly.yes - kalshi.no - this.config.totalFeeCents;
        
        // Strategy 2: Buy Poly NO + Kalshi YES
        const strat2Profit = 100 - poly.no - kalshi.yes - this.config.totalFeeCents;
        
        const bestProfit = Math.max(strat1Profit, strat2Profit);
        const bestStrategy = strat1Profit > strat2Profit ? 1 : 2;
        
        if (bestProfit >= this.config.minProfitCents) {
            this.handleOpportunity({
                name: mapping.name,
                profit: bestProfit,
                strategy: bestStrategy,
                polyYes: poly.yes,
                polyNo: poly.no,
                kalshiYes: kalshi.yes,
                kalshiNo: kalshi.no
            });
        }
    }

    async handleOpportunity(opp) {
        const key = `${opp.name}-${opp.strategy}`;
        const lastAlert = this.alertCooldown.get(key) || 0;
        const now = Date.now();
        
        // Cooldown: 60 seconds between alerts for same opportunity
        if (now - lastAlert < 60000) return;
        
        this.alertCooldown.set(key, now);
        
        const stratDesc = opp.strategy === 1 
            ? `Poly YES (${opp.polyYes.toFixed(1)}¢) + Kalshi NO (${opp.kalshiNo.toFixed(1)}¢)`
            : `Poly NO (${opp.polyNo.toFixed(1)}¢) + Kalshi YES (${opp.kalshiYes.toFixed(1)}¢)`;
        
        console.log(`\n🚨 [ARB FOUND] ${opp.name}`);
        console.log(`   Strategy: ${stratDesc}`);
        console.log(`   Net Profit: ${opp.profit.toFixed(2)}¢ per contract\n`);
        
        // Send alert
        if (opp.profit >= this.config.alertThresholdCents) {
            await sendAlert({
                outcome: opp.name,
                profit: opp.profit,
                description: stratDesc
            });
        }
    }

    async start() {
        await this.initialize();
        
        console.log('\n[START] Real-time arbitrage monitoring...');
        console.log(`  - Polymarket: WebSocket (real-time)`);
        console.log(`  - Kalshi: Polling every ${KALSHI_POLL_MS/1000}s`);
        console.log(`  - Alert threshold: ${this.config.alertThresholdCents}¢`);
        console.log(`  - Min profit: ${this.config.minProfitCents}¢\n`);
        
        // Connect to Polymarket WebSocket
        this.connectPolyWebSocket();
        
        // Start Kalshi polling
        await this.pollKalshi();
        this.kalshiInterval = setInterval(() => this.pollKalshi(), KALSHI_POLL_MS);
        
        // Status log every 30 seconds
        setInterval(() => {
            const polyCount = this.polyPrices.size;
            const kalshiCount = this.kalshiPrices.size;
            console.log(`[STATUS] Poly: ${polyCount} prices | Kalshi: ${kalshiCount} prices | WS: ${this.ws?.readyState === 1 ? 'connected' : 'disconnected'}`);
        }, 30000);
    }

    stop() {
        if (this.ws) this.ws.close();
        if (this.kalshiInterval) clearInterval(this.kalshiInterval);
        console.log('[STOPPED]');
    }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
    // Import config from main config file
    const { config: baseConfig } = await import('../config.js');
    
    const config = {
        ...baseConfig,
        alertThresholdCents: parseFloat(process.env.ALERT_THRESHOLD_CENTS) || 2.0,
        totalFeeCents: parseFloat(process.env.TOTAL_FEE_CENTS) || 4.0,
    };
    
    const bot = new RealtimeArbBot(config);
    
    process.on('SIGINT', () => {
        bot.stop();
        process.exit(0);
    });
    
    bot.start().catch(console.error);
}

export default RealtimeArbBot;
