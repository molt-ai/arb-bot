/**
 * Multi-Market Scanner
 * Discovers all matching markets across Polymarket and Kalshi
 * Finds tradeable pairs automatically
 */

import pmxt from 'pmxtjs';

export class MarketScanner {
    constructor(config = {}) {
        this.polymarket = new pmxt.polymarket({ privateKey: config.polymarketPrivateKey });
        this.kalshi = new pmxt.kalshi({ apiKey: config.kalshiApiKey, apiSecret: config.kalshiApiSecret });
        this.matchThreshold = config.matchThreshold || 0.55;
        this.minVolume = config.minVolume || 5000; // $50 minimum volume
        this.pairs = [];
    }

    /**
     * Fetch all active markets from both platforms
     */
    async fetchAllMarkets() {
        console.log('[SCANNER] Fetching all active markets...');
        
        const [polyEvents, kalshiEvents] = await Promise.all([
            this.fetchPolymarketEvents(),
            this.fetchKalshiEvents()
        ]);
        
        console.log(`[SCANNER] Found ${polyEvents.length} Poly events, ${kalshiEvents.length} Kalshi events`);
        return { polyEvents, kalshiEvents };
    }

    async fetchPolymarketEvents() {
        try {
            // Fetch active/open events
            const events = await this.polymarket.getActiveEvents({ limit: 200 });
            return (events || []).filter(e => e.markets?.length > 0 || e.outcomes?.length > 0);
        } catch (e) {
            console.error('[SCANNER] Poly fetch error:', e.message);
            // Fallback: try fetching popular categories
            return await this.fetchPolyCategorized();
        }
    }

    async fetchPolyCategorized() {
        const categories = ['politics', 'crypto', 'sports', 'science', 'economics', 'culture'];
        const all = [];
        
        for (const cat of categories) {
            try {
                const events = await this.polymarket.getEventsByCategory?.(cat) || [];
                all.push(...events);
            } catch (e) { /* skip category */ }
        }
        
        return all;
    }

    async fetchKalshiEvents() {
        try {
            const events = await this.kalshi.getActiveEvents?.({ limit: 200 });
            return events || [];
        } catch (e) {
            console.error('[SCANNER] Kalshi fetch error:', e.message);
            // Fallback: try series-based fetch
            return await this.fetchKalshiSeries();
        }
    }

    async fetchKalshiSeries() {
        const popular = [
            'KXFEDCHAIRNOM', 'KXSCOTUS', 'KXBTC', 'KXETH',
            'KXGDP', 'KXCPI', 'KXFEDRATE', 'KXUNEMPLOY',
            'KXELECTION', 'KXPRES', 'KXSENATE'
        ];
        
        const all = [];
        for (const series of popular) {
            try {
                const markets = await this.kalshi.getMarketsBySeries?.(series) || [];
                all.push(...markets);
            } catch (e) { /* skip series */ }
        }
        
        return all;
    }

    /**
     * Match markets across platforms using fuzzy name matching
     */
    matchMarkets(polyEvents, kalshiEvents) {
        console.log('[SCANNER] Matching markets across platforms...');
        const matches = [];
        
        // Build normalized name index for Kalshi
        const kalshiIndex = kalshiEvents.map(e => ({
            event: e,
            normalizedTitle: this.normalize(e.title || e.question || ''),
            normalizedMarkets: (e.markets || [e]).map(m => ({
                market: m,
                normalized: this.normalize(m.title || m.question || m.outcomes?.[0]?.label || '')
            }))
        }));
        
        for (const polyEvent of polyEvents) {
            const polyTitle = this.normalize(polyEvent.title || polyEvent.question || '');
            const polyMarkets = (polyEvent.markets || [polyEvent]).map(m => ({
                market: m,
                normalized: this.normalize(m.title || m.question || m.outcomes?.[0]?.label || '')
            }));
            
            for (const kalshiItem of kalshiIndex) {
                // First check event-level match
                const eventSimilarity = this.similarity(polyTitle, kalshiItem.normalizedTitle);
                
                if (eventSimilarity > this.matchThreshold) {
                    // Match individual markets within the event
                    for (const pm of polyMarkets) {
                        for (const km of kalshiItem.normalizedMarkets) {
                            const marketSim = this.similarity(pm.normalized, km.normalized);
                            
                            if (marketSim > this.matchThreshold) {
                                matches.push({
                                    name: pm.market.title || pm.market.question || pm.market.outcomes?.[0]?.label || polyTitle,
                                    similarity: Math.max(eventSimilarity, marketSim),
                                    polyMarket: pm.market,
                                    kalshiMarket: km.market,
                                    category: polyEvent.category || 'unknown'
                                });
                            }
                        }
                    }
                }
            }
        }
        
        // Deduplicate and sort by similarity
        const unique = this.deduplicateMatches(matches);
        console.log(`[SCANNER] Found ${unique.length} matched market pairs`);
        
        return unique;
    }

    /**
     * Extract tradeable pairs with prices from matched markets
     */
    extractPairs(matches) {
        const pairs = [];
        
        for (const match of matches) {
            try {
                const polyOutcomes = this.extractOutcomes(match.polyMarket, 'polymarket');
                const kalshiOutcomes = this.extractOutcomes(match.kalshiMarket, 'kalshi');
                
                if (!polyOutcomes || !kalshiOutcomes) continue;
                
                // Calculate arb spread
                // Strategy 1: Poly YES + Kalshi NO
                const strat1 = 100 - polyOutcomes.yesPrice - kalshiOutcomes.noPrice;
                // Strategy 2: Poly NO + Kalshi YES  
                const strat2 = 100 - polyOutcomes.noPrice - kalshiOutcomes.yesPrice;
                
                const bestProfit = Math.max(strat1, strat2);
                const strategy = strat1 > strat2 ? 1 : 2;
                
                pairs.push({
                    name: match.name,
                    category: match.category,
                    similarity: match.similarity,
                    polyMarketId: match.polyMarket.id,
                    kalshiMarketId: match.kalshiMarket.id,
                    polyTokenId: polyOutcomes.yesId,
                    polyYes: polyOutcomes.yesPrice,
                    polyNo: polyOutcomes.noPrice,
                    kalshiYes: kalshiOutcomes.yesPrice,
                    kalshiNo: kalshiOutcomes.noPrice,
                    grossProfit: bestProfit,
                    netProfit: bestProfit - 4.0, // minus fees
                    strategy,
                    volume: (match.polyMarket.volume || 0) + (match.kalshiMarket.volume || 0)
                });
            } catch (e) {
                // Skip malformed markets
            }
        }
        
        // Sort by net profit descending
        pairs.sort((a, b) => b.netProfit - a.netProfit);
        this.pairs = pairs;
        
        return pairs;
    }

    extractOutcomes(market, platform) {
        if (!market.outcomes || market.outcomes.length < 2) return null;
        
        const yes = market.outcomes.find(o => 
            o.label?.toLowerCase().includes('yes') || o.side === 'yes'
        ) || market.outcomes[0];
        
        const no = market.outcomes.find(o => 
            o.label?.toLowerCase().includes('no') || o.side === 'no'
        ) || market.outcomes[1];
        
        const yesPrice = Number(((yes.price || 0) * 100).toFixed(2));
        const noPrice = Number(((no.price || 0) * 100).toFixed(2));
        
        if (yesPrice <= 0 && noPrice <= 0) return null;
        
        return {
            yesPrice,
            noPrice,
            yesId: yes.id,
            noId: no.id
        };
    }

    /**
     * Full scan: fetch, match, extract, return sorted opportunities
     */
    async scan() {
        const { polyEvents, kalshiEvents } = await this.fetchAllMarkets();
        const matches = this.matchMarkets(polyEvents, kalshiEvents);
        const pairs = this.extractPairs(matches);
        
        const profitable = pairs.filter(p => p.netProfit > 0);
        
        console.log(`[SCANNER] ${pairs.length} total pairs, ${profitable.length} profitable (after fees)`);
        
        return {
            totalPairs: pairs.length,
            profitable: profitable.length,
            pairs,
            scannedAt: new Date().toISOString()
        };
    }

    // --- Utility functions ---

    normalize(text) {
        return text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    similarity(a, b) {
        if (!a || !b) return 0;
        
        const aWords = new Set(a.split(' ').filter(w => w.length > 2));
        const bWords = new Set(b.split(' ').filter(w => w.length > 2));
        
        if (aWords.size === 0 || bWords.size === 0) return 0;
        
        let common = 0;
        for (const word of aWords) {
            if (bWords.has(word)) common++;
        }
        
        // Jaccard similarity
        const union = new Set([...aWords, ...bWords]).size;
        return common / union;
    }

    deduplicateMatches(matches) {
        const seen = new Set();
        return matches.filter(m => {
            const key = `${m.polyMarket.id}-${m.kalshiMarket.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort((a, b) => b.similarity - a.similarity);
    }
}

export default MarketScanner;
