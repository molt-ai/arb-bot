/**
 * Combinatorial Arb Strategy
 * 
 * Finds pricing violations between logically related prediction markets.
 * Uses the entity matcher to detect relationships:
 *   - Implication: "Trump wins" implies "Republican wins" → P(R) must be ≥ P(T)
 *   - Inverse: "Shutdown" + "No shutdown" → prices must sum to ~$1
 *   - Equivalent: same market on Polymarket with different phrasing → should be same price
 *   - Threshold: "BTC > 100k" implies "BTC > 95k" → higher target must be cheaper
 * 
 * Smart scanning: groups markets by event first, then matches within groups.
 * O(n) per event, not O(n²) across all markets.
 */

import { EntityMatcher, findCombinatorialArbs } from './entity-matcher.js';

const POLY_GAMMA = 'https://gamma-api.polymarket.com';

export class CombinatorialArb {
    constructor(trader, options = {}) {
        this.trader = trader;
        this.options = {
            scanIntervalMs: options.scanIntervalMs || 60_000,   // Scan every 60s
            minEdgeCents: options.minEdgeCents || 3,            // Min 3¢ edge
            maxMarketsPerGroup: options.maxMarketsPerGroup || 30, // Cap pairwise comparisons
            maxDaysToExpiry: options.maxDaysToExpiry || 14,
            useEmbeddings: options.useEmbeddings ?? false,       // Off by default (saves RAM on Fly)
            ...options,
        };
        
        // Use sync matching by default (fast, no model loading)
        // Structural extraction + token similarity catches most arb patterns
        this.matcher = new EntityMatcher({
            useEmbeddings: this.options.useEmbeddings,
            matchThreshold: 0.5, // Lower threshold — we want to catch more, filter by edge
        });
        
        this.stats = {
            scans: 0,
            groupsChecked: 0,
            pairsCompared: 0,
            opportunitiesFound: 0,
            trades: 0,
        };
        
        this.activeOpportunities = [];
        this._interval = null;
    }

    async start() {
        console.log('[COMBO-ARB] Starting combinatorial arb strategy...');
        console.log(`[COMBO-ARB] Min edge: ${this.options.minEdgeCents}¢ | Scan: ${this.options.scanIntervalMs / 1000}s | Embeddings: ${this.options.useEmbeddings ? 'ON' : 'OFF'}`);
        
        if (this.options.useEmbeddings) {
            await this.matcher.warmup();
        }
        
        // Initial scan
        await this.scan();
        
        // Periodic scan
        this._interval = setInterval(() => this.scan(), this.options.scanIntervalMs);
    }

    stop() {
        if (this._interval) clearInterval(this._interval);
        console.log('[COMBO-ARB] Stopped');
    }

    async scan() {
        this.stats.scans++;
        const start = Date.now();
        
        try {
            // 1. Fetch active events with their markets
            const eventGroups = await this._fetchMarketGroups();
            
            // 2. Within each event group, find related market pairs
            const allOpps = [];
            
            for (const group of eventGroups) {
                if (group.markets.length < 2) continue;
                this.stats.groupsChecked++;
                
                const opps = await this._scanGroup(group);
                allOpps.push(...opps);
            }
            
            // 3. Also scan across events that share a domain/entity
            const crossEventOpps = await this._scanCrossEvent(eventGroups);
            allOpps.push(...crossEventOpps);
            
            // 4. Deduplicate and rank
            const uniqueOpps = this._deduplicateOpps(allOpps);
            this.activeOpportunities = uniqueOpps;
            
            const elapsed = Date.now() - start;
            
            if (uniqueOpps.length > 0) {
                this.stats.opportunitiesFound += uniqueOpps.length;
                console.log(`[COMBO-ARB] Found ${uniqueOpps.length} opportunities in ${elapsed}ms (${this.stats.pairsCompared} pairs checked):`);
                for (const opp of uniqueOpps.slice(0, 5)) {
                    console.log(`  💰 ${opp.type} | Edge: ${opp.edge}¢ | ${opp.reason.substring(0, 80)}`);
                }
                
                // Execute paper trades for profitable opportunities
                for (const opp of uniqueOpps) {
                    if (opp.edge >= this.options.minEdgeCents) {
                        this._executePaperTrade(opp);
                    }
                }
            } else if (this.stats.scans % 10 === 0) {
                // Log every 10th scan to avoid noise
                console.log(`[COMBO-ARB] Scan #${this.stats.scans}: ${eventGroups.length} groups, ${this.stats.pairsCompared} pairs, 0 opps (${elapsed}ms)`);
            }
            
        } catch (e) {
            console.error('[COMBO-ARB] Scan error:', e.message);
        }
    }

    /**
     * Fetch active markets grouped by event from Polymarket.
     * Each event contains multiple related markets (e.g., all candidates in an election).
     */
    async _fetchMarketGroups() {
        const maxExpiryMs = Date.now() + this.options.maxDaysToExpiry * 24 * 60 * 60 * 1000;
        const groups = [];
        
        // Fetch top events by volume (most liquid = best for arb)
        const res = await fetch(
            `${POLY_GAMMA}/events?active=true&closed=false&order=volume24hr&ascending=false&limit=50`
        );
        const events = await res.json();
        
        for (const event of (events || [])) {
            const markets = [];
            
            for (const m of (event.markets || [])) {
                // Filter: must have prices, must be within expiry window
                if (m.endDate && new Date(m.endDate).getTime() > maxExpiryMs) continue;
                
                let prices = m.outcomePrices;
                if (typeof prices === 'string') {
                    try { prices = JSON.parse(prices); } catch (e) { continue; }
                }
                if (!prices?.[0]) continue;
                
                const yesPrice = Math.round(parseFloat(prices[0]) * 100);
                const noPrice = Math.round(parseFloat(prices[1] || (1 - parseFloat(prices[0]))) * 100);
                
                // Skip dead markets (no liquidity)
                if (yesPrice <= 1 || yesPrice >= 99) continue;
                
                let tokenIds = m.clobTokenIds;
                if (typeof tokenIds === 'string') {
                    try { tokenIds = JSON.parse(tokenIds); } catch (e) { tokenIds = []; }
                }
                
                markets.push({
                    id: m.conditionId || m.id,
                    question: m.question || m.groupItemTitle || event.title,
                    yesPrice,
                    noPrice,
                    volume: parseFloat(m.volume || 0),
                    volume24hr: parseFloat(m.volume24hr || 0),
                    endDate: m.endDate,
                    tokenIds: tokenIds || [],
                    slug: m.slug,
                    eventSlug: event.slug,
                });
            }
            
            if (markets.length >= 2) {
                groups.push({
                    eventTitle: event.title,
                    eventSlug: event.slug,
                    category: event.category || 'unknown',
                    markets,
                });
            }
        }
        
        return groups;
    }

    /**
     * Scan within an event group for combinatorial arbs.
     * Markets in the same event are already topically related.
     */
    async _scanGroup(group) {
        const markets = group.markets.slice(0, this.options.maxMarketsPerGroup);
        
        // 1. Multi-outcome completeness check
        //    If this event has mutually exclusive outcomes, they should sum to ~100%
        const completenessOpps = this._checkCompleteness(group.eventTitle, markets);
        
        // 2. Pairwise matching for implications/inverses/equivalents
        const opps = await findCombinatorialArbs(markets, {
            minEdge: this.options.minEdgeCents,
            useEmbeddings: this.options.useEmbeddings,
            matchThreshold: 0.5,
        });
        
        this.stats.pairsCompared += (markets.length * (markets.length - 1)) / 2;
        
        return [...completenessOpps, ...opps.map(o => ({
            ...o,
            source: 'within-event',
            event: group.eventTitle,
        }))];
    }

    /**
     * Check if mutually exclusive outcomes in a group sum to ~100%.
     * E.g., in "Who wins the election?", all candidate YES prices should sum to ~100.
     * 
     * IMPORTANT: Not all markets in an event are mutually exclusive!
     * Sports player stats (rebounds, assists) are independent.
     * "Trump talks to X" questions are independent (can talk to multiple).
     * Only true mutually exclusive: elections, single-winner events.
     */
    _checkCompleteness(eventTitle, markets) {
        const opps = [];
        
        // Skip events that are clearly NOT mutually exclusive
        const title = eventTitle.toLowerCase();
        const isIndependent = 
            title.includes('vs.') || title.includes('vs ') ||  // Sports games (player stats)
            title.includes('o/u') || title.includes('over/under') ||
            title.includes('talk to') || title.includes('speak to') ||
            title.includes('by...') || title.includes('by ') || // "X by date" (cumulative, not exclusive)
            markets.some(m => m.question.toLowerCase().includes('o/u')) ||
            markets.some(m => m.question.toLowerCase().includes('over/under'));
        
        if (isIndependent) return opps;
        
        // Check if markets look mutually exclusive (similar question structure)
        // "Will X win?" / "Will Y win?" pattern
        const questions = markets.map(m => m.question.toLowerCase());
        const hasCommonPattern = this._looksExclusive(questions);
        if (!hasCommonPattern) return opps;
        
        const totalYes = markets.reduce((sum, m) => sum + m.yesPrice, 0);
        
        // Only flag if there are 3+ outcomes (binary is handled by same-market arb)
        if (markets.length >= 3) {
            if (totalYes < 90) {
                // Sum < 100% → all underpriced, guaranteed profit buying all YES
                const edge = 100 - totalYes;
                if (edge >= this.options.minEdgeCents) {
                    opps.push({
                        type: 'completeness_gap',
                        rule: `${markets.length} outcomes sum to ${totalYes}¢ < 100¢`,
                        action: `Buy YES on all ${markets.length} outcomes in "${eventTitle}" — total cost ${totalYes}¢, payout $1`,
                        edge,
                        source: 'completeness',
                        event: eventTitle,
                        reason: `${markets.length} mutually exclusive outcomes sum to only ${totalYes}¢`,
                        markets: markets.map(m => ({ question: m.question, yesPrice: m.yesPrice })),
                        confidence: 0.7, // Lower confidence — might not be mutually exclusive
                        matchScore: 0.7,
                    });
                }
            }
            if (totalYes > 110) {
                // Sum > 100% → all overpriced, buy all NO for guaranteed profit
                const totalNo = markets.reduce((sum, m) => sum + m.noPrice, 0);
                const edge = totalYes - 100;
                if (edge >= this.options.minEdgeCents) {
                    opps.push({
                        type: 'completeness_excess',
                        rule: `${markets.length} outcomes sum to ${totalYes}¢ > 100¢`,
                        action: `Buy NO on most expensive outcomes in "${eventTitle}"`,
                        edge,
                        source: 'completeness',
                        event: eventTitle,
                        reason: `${markets.length} outcomes sum to ${totalYes}¢ — at least one is overpriced`,
                        markets: markets.map(m => ({ question: m.question, yesPrice: m.yesPrice })),
                        confidence: 0.7,
                        matchScore: 0.7,
                    });
                }
            }
        }
        
        return opps;
    }

    /**
     * Scan across different events for cross-event logical relationships.
     * Pre-filter by extracting key entities to avoid O(n²) blowup.
     */
    async _scanCrossEvent(eventGroups) {
        const opps = [];
        
        // Build a flat list of (market, event) for cross-event comparison
        // But only markets with strong entity signals (to avoid noise)
        const crossCandidates = [];
        
        for (const group of eventGroups) {
            for (const m of group.markets) {
                // Quick structural extraction to tag markets
                crossCandidates.push({
                    ...m,
                    event: group.eventTitle,
                    eventSlug: group.eventSlug,
                });
            }
        }
        
        // Group by shared keywords for efficient cross-matching
        // Instead of comparing ALL pairs (could be 1000s), group by key entities
        const entityBuckets = new Map(); // entity → [markets]
        
        for (const m of crossCandidates) {
            const q = m.question.toLowerCase();
            // Extract key nouns as bucket keys
            const keys = this._extractBucketKeys(q);
            for (const key of keys) {
                if (!entityBuckets.has(key)) entityBuckets.set(key, []);
                entityBuckets.get(key).push(m);
            }
        }
        
        // Within each bucket, run pairwise matching (only across different events)
        for (const [key, markets] of entityBuckets) {
            if (markets.length < 2 || markets.length > 50) continue; // Skip too small or too large
            
            for (let i = 0; i < markets.length; i++) {
                for (let j = i + 1; j < markets.length; j++) {
                    // Only cross-event pairs (within-event already handled)
                    if (markets[i].eventSlug === markets[j].eventSlug) continue;
                    
                    this.stats.pairsCompared++;
                    
                    const result = this.matcher.matchSync(
                        markets[i].question, markets[j].question
                    );
                    
                    if (result.relationship === 'unrelated') continue;
                    
                    // Check for pricing violation
                    const violation = this._checkPricingViolation(
                        markets[i], markets[j], result
                    );
                    
                    if (violation && violation.edge >= this.options.minEdgeCents) {
                        opps.push({
                            ...violation,
                            source: 'cross-event',
                            matchScore: result.score,
                            confidence: result.confidence,
                        });
                    }
                }
            }
        }
        
        return opps;
    }

    /**
     * Extract bucket keys from a market question for efficient grouping.
     * Markets sharing a bucket key get compared pairwise.
     */
    _extractBucketKeys(question) {
        const keys = new Set();
        const q = question.toLowerCase();
        
        // People
        const people = ['trump', 'biden', 'harris', 'desantis', 'vance', 'musk', 'putin', 'zelensky', 'xi'];
        for (const p of people) { if (q.includes(p)) keys.add(p); }
        
        // Parties
        if (q.includes('republican') || q.includes('gop')) keys.add('republican');
        if (q.includes('democrat')) keys.add('democrat');
        
        // Crypto
        if (q.includes('bitcoin') || q.includes('btc')) keys.add('bitcoin');
        if (q.includes('ethereum') || q.includes('eth')) keys.add('ethereum');
        if (q.includes('solana') || q.includes('sol')) keys.add('solana');
        
        // Economics
        if (q.includes('rate') || q.includes('fed') || q.includes('fomc')) keys.add('fed_rates');
        if (q.includes('inflation') || q.includes('cpi')) keys.add('inflation');
        if (q.includes('recession') || q.includes('gdp')) keys.add('gdp');
        if (q.includes('unemployment') || q.includes('jobs')) keys.add('employment');
        
        // Geopolitics
        if (q.includes('shutdown')) keys.add('govt_shutdown');
        if (q.includes('ukraine') || q.includes('russia')) keys.add('ukraine');
        if (q.includes('taiwan') || q.includes('china')) keys.add('taiwan');
        if (q.includes('tariff') || q.includes('trade war')) keys.add('trade');
        
        // Events
        if (q.includes('super bowl')) keys.add('superbowl');
        if (q.includes('oscar') || q.includes('academy award')) keys.add('oscars');
        
        return keys;
    }

    /**
     * Check if two related markets have a pricing violation.
     */
    _checkPricingViolation(marketA, marketB, matchResult) {
        const rel = matchResult.relationship;
        const pA = marketA.yesPrice;
        const pB = marketB.yesPrice;
        
        if (rel === 'implies') {
            // A implies B → P(B) ≥ P(A)
            if (pB < pA - 2) { // 2¢ buffer for spread
                return {
                    type: 'implication_violation',
                    edge: pA - pB,
                    action: `Buy "${marketB.question}" YES at ${pB}¢ (implied floor: ${pA}¢)`,
                    reason: `"${marketA.question}" (${pA}¢) implies "${marketB.question}" (${pB}¢) but B is cheaper`,
                    buy: { market: marketB, side: 'YES', price: pB },
                    relationship: rel,
                    event: `${marketA.event} × ${marketB.event}`,
                };
            }
        }
        
        if (rel === 'implied_by') {
            // B implies A → P(A) ≥ P(B)
            if (pA < pB - 2) {
                return {
                    type: 'implication_violation',
                    edge: pB - pA,
                    action: `Buy "${marketA.question}" YES at ${pA}¢ (implied floor: ${pB}¢)`,
                    reason: `"${marketB.question}" (${pB}¢) implies "${marketA.question}" (${pA}¢) but A is cheaper`,
                    buy: { market: marketA, side: 'YES', price: pA },
                    relationship: rel,
                    event: `${marketA.event} × ${marketB.event}`,
                };
            }
        }
        
        if (rel === 'inverse') {
            const sum = pA + pB;
            if (sum < 94) { // 6¢ buffer for spreads
                return {
                    type: 'inverse_underpriced',
                    edge: 100 - sum,
                    action: `Buy both YES: "${marketA.question}" at ${pA}¢ + "${marketB.question}" at ${pB}¢ = ${sum}¢`,
                    reason: `Inverse markets sum to ${sum}¢ < 100¢ → guaranteed ${100 - sum}¢ profit`,
                    buy: [
                        { market: marketA, side: 'YES', price: pA },
                        { market: marketB, side: 'YES', price: pB },
                    ],
                    relationship: rel,
                    event: `${marketA.event} × ${marketB.event}`,
                };
            }
            if (sum > 106) {
                return {
                    type: 'inverse_overpriced',
                    edge: sum - 100,
                    action: `Buy both NO: "${marketA.question}" NO at ${100 - pA}¢ + "${marketB.question}" NO at ${100 - pB}¢`,
                    reason: `Inverse markets sum to ${sum}¢ > 100¢ → guaranteed ${sum - 100}¢ profit`,
                    buy: [
                        { market: marketA, side: 'NO', price: 100 - pA },
                        { market: marketB, side: 'NO', price: 100 - pB },
                    ],
                    relationship: rel,
                    event: `${marketA.event} × ${marketB.event}`,
                };
            }
        }
        
        if (rel === 'equivalent') {
            const diff = Math.abs(pA - pB);
            if (diff >= 5) {
                const cheap = pA < pB ? marketA : marketB;
                const expensive = pA < pB ? marketB : marketA;
                return {
                    type: 'equivalent_mispricing',
                    edge: diff,
                    action: `Buy "${cheap.question}" YES at ${Math.min(pA, pB)}¢ (equiv. priced at ${Math.max(pA, pB)}¢ elsewhere)`,
                    reason: `Equivalent markets ${diff}¢ apart: ${pA}¢ vs ${pB}¢`,
                    buy: { market: cheap, side: 'YES', price: Math.min(pA, pB) },
                    relationship: rel,
                    event: `${marketA.event} × ${marketB.event}`,
                };
            }
        }
        
        return null;
    }

    /**
     * Execute a paper trade for a combinatorial arb opportunity.
     */
    _executePaperTrade(opp) {
        if (!this.trader) return;
        
        const name = `COMBO: ${opp.type} (${opp.edge}¢)`;
        
        // Check if we already have this position
        const existing = this.trader.state.positions.find(p => 
            p.name.includes(opp.type) && 
            p.name.includes(String(opp.edge))
        );
        if (existing) return;
        
        // For the arb bot, we record the trade in the paper trader
        const trade = {
            name,
            strategy: 'combinatorial',
            type: opp.type,
            edge: opp.edge,
            relationship: opp.relationship,
            source: opp.source,
            action: opp.action,
            reason: opp.reason,
            confidence: opp.confidence,
            matchScore: opp.matchScore,
            timestamp: new Date().toISOString(),
        };
        
        // Add to paper trader as a position
        if (opp.buy) {
            const buys = Array.isArray(opp.buy) ? opp.buy : [opp.buy];
            for (const b of buys) {
                this.trader.state.positions.push({
                    name: `${name} | ${b.market.question?.substring(0, 40)}`,
                    strategy: 'combinatorial',
                    side: b.side,
                    entryPrice: b.price,
                    contracts: 10,
                    enteredAt: new Date().toISOString(),
                    expiresAt: b.market.endDate,
                    polySide: b.side,
                });
            }
            this.trader.state.trades.push(trade);
            this.stats.trades++;
            
            console.log(`[COMBO-ARB] 📊 Paper trade: ${name}`);
            console.log(`  ${opp.action}`);
        }
    }

    /**
     * Heuristic: do these questions look like mutually exclusive outcomes?
     * "Will Trump win?" / "Will Biden win?" → yes (same structure, different entity)
     * "Rebounds O/U 3.5" / "Assists O/U 8.5" → no (different metrics)
     */
    _looksExclusive(questions) {
        if (questions.length < 3) return false;
        
        // Check if questions share a common template with one varying part
        // e.g., "Will X win the 2024 election?" where X varies
        const words = questions.map(q => q.split(/\s+/));
        if (words.length < 3) return false;
        
        // Find shared prefix/suffix length
        const first = words[0];
        let sharedWords = 0;
        for (const w of first) {
            if (questions.every(q => q.includes(w))) sharedWords++;
        }
        
        // If most words are shared across all questions, they're likely exclusive variants
        const avgLen = words.reduce((s, w) => s + w.length, 0) / words.length;
        return sharedWords >= avgLen * 0.4; // At least 40% shared words
    }

    /**
     * Deduplicate opportunities (same pair can be found through different paths).
     */
    _deduplicateOpps(opps) {
        const seen = new Set();
        return opps.filter(opp => {
            const key = `${opp.type}:${opp.edge}:${opp.reason?.substring(0, 50)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * Get current state for the dashboard API.
     */
    getState() {
        return {
            stats: this.stats,
            opportunities: this.activeOpportunities.slice(0, 20),
        };
    }
}
