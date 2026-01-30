/**
 * Multi-Category Market Scanner
 * Discovers ALL matching markets across Polymarket & Kalshi
 * Uses authenticated Kalshi API + Polymarket CLOB API
 */

import { generateKalshiRestHeaders, loadKalshiCredentials } from './kalshi-auth.js';

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_API = 'https://clob.polymarket.com';
const POLY_GAMMA = 'https://gamma-api.polymarket.com';

// Cross-platform event mappings we know about
const KNOWN_PAIRS = [
    // Politics & Government
    { poly: 'who-will-trump-nominate-as-fed-chair', kalshiSeries: 'KXFEDCHAIRNOM', category: 'politics' },
    { poly: 'will-there-be-another-us-government-shutdown-by-january-31', kalshiSeries: 'KXGOVSHUT', category: 'politics' },
    { poly: 'fed-decision-in-march-885', kalshiSeries: 'KXFEDDECISION', category: 'economics' },
    { poly: 'presidential-election-winner-2028', kalshiSeries: 'KXPRES', category: 'politics' },
    { poly: 'democratic-presidential-nominee-2028', kalshiSeries: 'KXDEM', category: 'politics' },
    { poly: 'republican-presidential-nominee-2028', kalshiSeries: 'KXREP', category: 'politics' },
    
    // Crypto  
    { poly: 'what-price-will-bitcoin-hit-in-january', kalshiSeries: 'KXBTC', category: 'crypto' },
    { poly: 'bitcoin-above-on-january-30', kalshiSeries: 'KXBTCD', category: 'crypto' },
    
    // Economics
    { poly: 'us-recession-2026', kalshiSeries: 'KXRECESSION', category: 'economics' },
    { poly: 'us-gdp-q1-2026', kalshiSeries: 'KXGDP', category: 'economics' },
    { poly: 'january-2026-cpi', kalshiSeries: 'KXCPI', category: 'economics' },
    
    // Geopolitics
    { poly: 'us-strikes-iran-by', kalshiSeries: 'KXUSSTRIKE', category: 'geopolitics' },
];

export class MultiScanner {
    constructor() {
        try {
            this.kalshiCreds = loadKalshiCredentials();
        } catch (e) {
            console.warn('[MULTI-SCAN] No Kalshi creds:', e.message);
            this.kalshiCreds = null;
        }
    }

    /**
     * Fetch from Kalshi authenticated REST API
     */
    async kalshiFetch(path) {
        if (!this.kalshiCreds) throw new Error('No Kalshi credentials');
        
        const headers = generateKalshiRestHeaders(
            this.kalshiCreds.keyId,
            this.kalshiCreds.privateKey,
            'GET',
            `/trade-api/v2${path}`
        );
        
        const res = await fetch(`${KALSHI_API}${path}`, { headers });
        if (!res.ok) throw new Error(`Kalshi API ${res.status}: ${await res.text()}`);
        return res.json();
    }

    /**
     * Fetch all Kalshi series (market templates)
     */
    async fetchKalshiSeries() {
        try {
            const data = await this.kalshiFetch('/series');
            console.log(`[MULTI-SCAN] Kalshi: ${data.series?.length || 0} series found`);
            return data.series || [];
        } catch (e) {
            console.error('[MULTI-SCAN] Kalshi series error:', e.message);
            return [];
        }
    }

    /**
     * Fetch active Kalshi events for a series
     */
    async fetchKalshiEvents(seriesTicker) {
        try {
            const data = await this.kalshiFetch(`/events?series_ticker=${seriesTicker}&status=open`);
            return data.events || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Fetch active Kalshi markets for an event
     */
    async fetchKalshiMarkets(eventTicker) {
        try {
            const data = await this.kalshiFetch(`/markets?event_ticker=${eventTicker}&status=open`);
            return data.markets || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Fetch all active Kalshi markets (paginated)
     */
    async fetchAllKalshiMarkets() {
        const allMarkets = [];
        let cursor = null;
        let page = 0;
        
        try {
            do {
                const path = cursor 
                    ? `/markets?status=open&limit=200&cursor=${cursor}`
                    : '/markets?status=open&limit=200';
                const data = await this.kalshiFetch(path);
                
                if (data.markets?.length) {
                    allMarkets.push(...data.markets);
                }
                cursor = data.cursor || null;
                page++;
            } while (cursor && page < 10); // Max 2000 markets
            
            console.log(`[MULTI-SCAN] Kalshi: ${allMarkets.length} active markets total`);
        } catch (e) {
            console.error('[MULTI-SCAN] Kalshi markets error:', e.message);
        }
        
        return allMarkets;
    }

    /**
     * Fetch trending Polymarket events
     */
    async fetchPolymarketEvents() {
        try {
            const res = await fetch(`${POLY_GAMMA}/events?active=true&closed=false&order=volume&ascending=false&limit=100`);
            const events = await res.json();
            console.log(`[MULTI-SCAN] Polymarket: ${events?.length || 0} active events`);
            return events || [];
        } catch (e) {
            console.error('[MULTI-SCAN] Poly events error:', e.message);
            return [];
        }
    }

    /**
     * Fetch Polymarket markets for an event slug
     */
    async fetchPolymarketBySlug(slug) {
        try {
            const res = await fetch(`${POLY_GAMMA}/events?slug=${slug}`);
            const events = await res.json();
            return events?.[0]?.markets || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Full scan: discover all cross-platform opportunities
     */
    async scan() {
        console.log('\n[MULTI-SCAN] ═══════════════════════════════════════');
        console.log('[MULTI-SCAN] Scanning all cross-platform markets...\n');

        const results = {
            pairs: [],
            kalshiOnly: [],
            polyOnly: [],
            scannedAt: new Date().toISOString()
        };

        // 1. Fetch all data in parallel
        const [kalshiMarkets, polyEvents] = await Promise.all([
            this.fetchAllKalshiMarkets(),
            this.fetchPolymarketEvents()
        ]);

        // 2. Try known pairs first
        console.log(`\n[MULTI-SCAN] Checking ${KNOWN_PAIRS.length} known cross-platform pairs...`);
        
        for (const pair of KNOWN_PAIRS) {
            const polyMarkets = await this.fetchPolymarketBySlug(pair.poly).catch(() => []);
            const kalshiEvts = await this.fetchKalshiEvents(pair.kalshiSeries).catch(() => []);
            
            if (polyMarkets.length > 0 && kalshiEvts.length > 0) {
                // Get Kalshi markets for the events
                for (const evt of kalshiEvts) {
                    const kMarkets = await this.fetchKalshiMarkets(evt.event_ticker).catch(() => []);
                    
                    const matched = this.matchOutcomes(polyMarkets, kMarkets, pair.category);
                    results.pairs.push(...matched);
                }
            } else if (polyMarkets.length > 0) {
                results.polyOnly.push({ slug: pair.poly, category: pair.category, markets: polyMarkets.length });
            } else if (kalshiEvts.length > 0) {
                results.kalshiOnly.push({ series: pair.kalshiSeries, category: pair.category, events: kalshiEvts.length });
            }
        }

        // 3. Fuzzy match remaining markets
        console.log(`\n[MULTI-SCAN] Fuzzy matching ${polyEvents.length} Poly events against ${kalshiMarkets.length} Kalshi markets...`);
        
        const additionalPairs = this.fuzzyMatchAll(polyEvents, kalshiMarkets);
        
        // Filter out already-found pairs
        const existingNames = new Set(results.pairs.map(p => p.name));
        for (const pair of additionalPairs) {
            if (!existingNames.has(pair.name)) {
                results.pairs.push(pair);
                existingNames.add(pair.name);
            }
        }

        console.log(`\n[MULTI-SCAN] ═══════════════════════════════════════`);
        console.log(`[MULTI-SCAN] Results:`);
        console.log(`  Cross-platform pairs: ${results.pairs.length}`);
        console.log(`  Poly-only events: ${results.polyOnly.length}`);
        console.log(`  Kalshi-only events: ${results.kalshiOnly.length}`);
        console.log(`[MULTI-SCAN] ═══════════════════════════════════════\n`);

        return results;
    }

    /**
     * Match individual outcomes across platforms
     */
    matchOutcomes(polyMarkets, kalshiMarkets, category) {
        const pairs = [];
        const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

        for (const pm of polyMarkets) {
            const polyQ = norm(pm.question || pm.groupItemTitle || '');
            const polyOutcome = norm(pm.outcomes?.[0] || '');
            
            for (const km of kalshiMarkets) {
                const kalshiQ = norm(km.title || km.subtitle || '');
                const kalshiTicker = km.ticker;
                
                const sim = this.similarity(polyQ, kalshiQ);
                
                if (sim > 0.4) {
                    // Extract prices
                    const polyYes = pm.outcomePrices ? parseFloat(pm.outcomePrices[0]) * 100 : null;
                    const polyNo = pm.outcomePrices ? parseFloat(pm.outcomePrices[1]) * 100 : null;
                    const kalshiYes = km.yes_bid != null ? km.yes_bid : (km.last_price != null ? km.last_price : null);
                    const kalshiNo = kalshiYes != null ? (100 - kalshiYes) : null;
                    
                    pairs.push({
                        name: pm.question || pm.groupItemTitle || kalshiQ,
                        category,
                        similarity: sim,
                        polySlug: pm.slug || pm.conditionId,
                        polyTokenId: pm.clobTokenIds?.[0] || pm.tokenId,
                        polyMarketId: pm.id || pm.conditionId,
                        kalshiTicker,
                        kalshiEventTicker: km.event_ticker,
                        polyYes,
                        polyNo,
                        kalshiYes,
                        kalshiNo,
                        polyVolume: pm.volume || 0,
                        kalshiVolume: km.volume || 0,
                    });
                    break; // Best match found
                }
            }
        }

        return pairs;
    }

    /**
     * Fuzzy match all events across platforms
     */
    fuzzyMatchAll(polyEvents, kalshiMarkets) {
        const pairs = [];
        const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        
        // Build Kalshi index
        const kalshiIndex = kalshiMarkets.map(km => ({
            market: km,
            normalized: norm(km.title || km.subtitle || '')
        }));

        for (const event of polyEvents) {
            const eventTitle = norm(event.title || '');
            
            for (const pm of event.markets || []) {
                const polyQ = norm(pm.question || pm.groupItemTitle || '');
                const searchStr = polyQ || eventTitle;
                
                let bestMatch = null;
                let bestSim = 0;

                for (const ki of kalshiIndex) {
                    const sim = this.similarity(searchStr, ki.normalized);
                    if (sim > bestSim && sim > 0.35) {
                        bestSim = sim;
                        bestMatch = ki.market;
                    }
                }

                if (bestMatch) {
                    const polyYes = pm.outcomePrices ? parseFloat(pm.outcomePrices[0]) * 100 : null;
                    const polyNo = pm.outcomePrices ? parseFloat(pm.outcomePrices[1]) * 100 : null;
                    const kalshiYes = bestMatch.yes_bid ?? bestMatch.last_price ?? null;
                    const kalshiNo = kalshiYes != null ? (100 - kalshiYes) : null;

                    pairs.push({
                        name: pm.question || pm.groupItemTitle || event.title,
                        category: event.tags?.[0] || 'unknown',
                        similarity: bestSim,
                        polySlug: pm.slug || pm.conditionId,
                        polyTokenId: pm.clobTokenIds?.[0] || pm.tokenId,
                        polyMarketId: pm.id || pm.conditionId,
                        kalshiTicker: bestMatch.ticker,
                        kalshiEventTicker: bestMatch.event_ticker,
                        polyYes,
                        polyNo,
                        kalshiYes,
                        kalshiNo,
                        polyVolume: parseFloat(pm.volume || 0),
                        kalshiVolume: bestMatch.volume || 0,
                    });
                }
            }
        }

        return pairs;
    }

    similarity(a, b) {
        if (!a || !b) return 0;
        const aWords = new Set(a.split(' ').filter(w => w.length > 2));
        const bWords = new Set(b.split(' ').filter(w => w.length > 2));
        if (aWords.size === 0 || bWords.size === 0) return 0;
        let common = 0;
        for (const w of aWords) { if (bWords.has(w)) common++; }
        return common / new Set([...aWords, ...bWords]).size;
    }
}

// CLI mode: run standalone scan
if (process.argv[1]?.includes('multi-scanner')) {
    const scanner = new MultiScanner();
    scanner.scan().then(results => {
        console.log('\n📊 Cross-Platform Pairs Found:\n');
        for (const p of results.pairs.sort((a, b) => b.similarity - a.similarity)) {
            const grossSpread = (p.polyYes != null && p.kalshiNo != null) 
                ? (100 - p.polyYes - p.kalshiNo).toFixed(1) + '¢'
                : '?';
            console.log(`  ${p.category.padEnd(12)} | ${p.name.substring(0, 50).padEnd(50)} | sim: ${p.similarity.toFixed(2)} | spread: ${grossSpread}`);
        }
    }).catch(console.error);
}

export default MultiScanner;
