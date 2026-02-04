/**
 * Curated Cross-Platform Market Pairs
 * Hand-verified mappings between Polymarket and Kalshi
 * 
 * This is more reliable than fuzzy matching — we verify
 * each pair refers to the SAME event/date/outcome.
 * 
 * The auto-discovery in live.js supplements this with dynamic matching.
 * 
 * MAINTENANCE: Review monthly. Polymarket slugs change when events
 * resolve or new ones are created. Kalshi series tickers are stable.
 */

// Kalshi API base for fetching fresh market data
export const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
export const POLY_GAMMA = 'https://gamma-api.polymarket.com';

/**
 * Each pair:
 * - polySlug: Polymarket event slug (fetch from gamma-api)
 * - kalshiSeries: Kalshi series ticker (fetch markets from API)
 * - kalshiTicker: specific Kalshi market ticker (for single-market matches)
 * - kalshiEventFilter: substring to filter Kalshi event_ticker within a series
 * - category: for UI grouping
 * - matchBy: how to match individual outcomes ('name', 'exact', or 'strike')
 * - active: whether to monitor this pair
 * 
 * NOTE: polySlug values must be kept current — they change when Polymarket
 * creates new events. Check https://gamma-api.polymarket.com/events?slug=<slug>
 * to verify a slug is still valid. If it returns empty, the event has expired
 * or been renamed.
 */
export const MARKET_PAIRS = [
    // ═══════════════════════════════════════════════════════════
    // ACTIVE CROSS-PLATFORM PAIRS
    // These are verified to exist on BOTH platforms as of last review
    // ═══════════════════════════════════════════════════════════

    // ═══ POLITICS & GOVERNMENT ═══
    {
        name: 'Fed Chair Nomination',
        polySlug: 'who-will-trump-nominate-as-fed-chair',
        kalshiSeries: 'KXFEDCHAIRNOM',
        category: 'politics',
        matchBy: 'name',
        active: true,
        notes: 'Multi-candidate market. Long-dated but high volume.',
    },
    {
        name: 'Greenland Acquisition',
        polySlug: 'will-trump-acquire-greenland-before-2027',
        kalshiSeries: 'KXGREENLAND',
        category: 'politics',
        matchBy: 'name',
        active: true,
        notes: 'Also check will-the-us-acquire-any-part-of-greenland-in-2026',
    },

    // ═══ FED & ECONOMICS ═══
    {
        name: 'Fed Decision (next meeting)',
        polySlug: 'fed-decision-in-march-885',
        kalshiSeries: 'KXFEDDECISION',
        kalshiEventFilter: '26',  // Current year events
        category: 'economics',
        matchBy: 'name',
        active: true,
        notes: 'Poly slug changes per meeting. Update when current one resolves.',
    },
    {
        name: 'Fed Rate Cuts 2026',
        polySlug: 'how-many-fed-rate-cuts-in-2026',
        kalshiSeries: 'KXRATECUTCOUNT',
        category: 'economics',
        matchBy: 'name',
        active: true,
        notes: 'Full-year resolution but high volume on both platforms.',
    },
    {
        name: 'Large Fed Rate Cut 2026',
        polySlug: 'fed-to-cut-more-than-25bps-in-2026',
        kalshiSeries: 'KXLARGECUT',
        category: 'economics',
        matchBy: 'exact',
        active: false, // Slug appears expired, re-enable when a new one exists
        notes: 'Check for updated slug if Polymarket creates new "large cut" event.',
    },
    {
        name: 'Inflation US Monthly (CPI proxy)',
        polySlug: 'january-inflation-us-monthly',
        kalshiSeries: 'KXCPI',
        kalshiEventFilter: '26',
        category: 'economics',
        matchBy: 'strike',
        active: true,
        notes: 'Polymarket calls it "Inflation" not "CPI". Slug changes monthly. Matched by threshold value.',
    },
    {
        name: 'GDP Q4 2025',
        polySlug: 'us-gdp-growth-in-q4-2025',
        kalshiSeries: 'KXGDP',
        category: 'economics',
        matchBy: 'strike',
        active: true,
        notes: 'Slug changes quarterly. Matched by threshold value. Range-bracket Poly markets are filtered out.',
    },

    // ═══ CRYPTO (daily price brackets) ═══
    // NOTE: Crypto price markets are hard to match cross-platform because
    // Polymarket and Kalshi use different strike prices and resolution rules.
    // Poly: "Will BTC be above $82,000 on Feb 4?" (above/below at close)
    // Kalshi: "Bitcoin price on Feb 4, 2026?" with strikes like $87,749.99
    // Auto-discovery handles these better than curated pairs.
    {
        name: 'Bitcoin Daily Price',
        polySlug: 'bitcoin-above-on-february-4',
        kalshiSeries: 'KXBTCD',
        category: 'crypto',
        matchBy: 'strike',
        active: true,
        notes: 'Slug changes DAILY (february-4 → february-5 etc). Hard to maintain — rely on auto-discovery.',
    },
    {
        name: 'Ethereum Daily Price',
        polySlug: 'ethereum-above-on-february-4',
        kalshiSeries: 'KXETH',
        category: 'crypto',
        matchBy: 'strike',
        active: true,
        notes: 'Same daily slug issue as Bitcoin.',
    },
    {
        name: 'Solana Daily Price',
        polySlug: 'solana-above-on-february-4',
        kalshiSeries: 'KXSOL',
        category: 'crypto',
        matchBy: 'strike',
        active: true,
        notes: 'Same daily slug issue. KXSOL may have 0 Kalshi markets.',
    },

    // ═══ SPORTS ═══
    {
        name: 'Super Bowl 2026',
        polySlug: 'super-bowl-champion-2026-731',
        kalshiSeries: 'KXSB',
        category: 'sports',
        matchBy: 'name',
        active: true,
        notes: 'Feb 2026. Kalshi has limited markets (2 teams). Poly has 33.',
    },
    {
        name: 'NBA Champion 2026',
        polySlug: '2026-nba-champion',
        kalshiSeries: 'KXNBA',
        category: 'sports',
        matchBy: 'name',
        active: true,
        notes: 'June 2026. Both platforms have 30 teams.',
    },

    // ═══ GEOPOLITICS ═══
    {
        name: 'Ukraine Ceasefire by March 31',
        polySlug: 'russia-x-ukraine-ceasefire-by-march-31-2026',
        kalshiSeries: 'KXCEASEFIRE',
        category: 'geopolitics',
        matchBy: 'exact',
        active: true,
        notes: 'Kalshi series KXCEASEFIRE may not exist. Will be skipped gracefully.',
    },
    {
        name: 'Government Shutdown',
        polySlug: 'another-us-government-shutdown-by-february-14',
        kalshiSeries: 'KXGOVSHUT',
        category: 'politics',
        matchBy: 'exact',
        active: true,
        notes: 'Both series may be empty if shutdown has resolved. Slug changes with new deadlines.',
    },

    // ═══ ENTERTAINMENT ═══
    {
        name: 'Oscars 2026 Best Picture',
        polySlug: 'oscars-2026-best-picture-winner',
        kalshiSeries: 'KXOSCARS',
        category: 'entertainment',
        matchBy: 'name',
        active: true,
        notes: 'Kalshi series may not exist. Will be skipped gracefully if absent.',
    },

    // ═══════════════════════════════════════════════════════════
    // INACTIVE — kept for reference / easy reactivation
    // ═══════════════════════════════════════════════════════════

    {
        name: '2028 Presidential Election',
        polySlug: 'presidential-election-winner-2028',
        kalshiSeries: 'KXPRES28',
        category: 'politics',
        matchBy: 'name',
        active: false, // 1000+ days out, low urgency
    },
    {
        name: '2028 Democratic Nominee',
        polySlug: 'democratic-presidential-nominee-2028',
        kalshiSeries: 'KXDEM28',
        category: 'politics',
        matchBy: 'name',
        active: false,
    },
    {
        name: '2028 Republican Nominee',
        polySlug: 'republican-presidential-nominee-2028',
        kalshiSeries: 'KXREP28',
        category: 'politics',
        matchBy: 'name',
        active: false,
    },
    {
        name: 'FIFA World Cup 2026',
        polySlug: '2026-fifa-world-cup-winner-595',
        kalshiSeries: 'KXFIFAWC',
        category: 'sports',
        matchBy: 'name',
        active: false, // Summer 2026 — far out
    },
];

/**
 * Resolve a market pair into tradeable outcome pairs with prices
 * Returns array of { name, polyTokenId, kalshiTicker, polyYes, kalshiYes, ... }
 */
export async function resolvePair(pair, fetchKalshi) {
    const resolved = [];
    
    try {
        // Fetch Polymarket data
        const pRes = await fetch(`${POLY_GAMMA}/events?slug=${pair.polySlug}`);
        const pEvents = await pRes.json();
        const polyMarkets = pEvents?.[0]?.markets || [];
        
        if (polyMarkets.length === 0) return resolved;
        
        // Fetch Kalshi data
        let kalshiMarkets = [];
        if (pair.kalshiTicker) {
            // Single market
            try {
                const km = await fetchKalshi(`/markets/${pair.kalshiTicker}`);
                if (km.market) kalshiMarkets = [km.market];
            } catch (e) {
                // Market may have expired/been removed
            }
        } else if (pair.kalshiSeries) {
            try {
                const kData = await fetchKalshi(`/markets?series_ticker=${pair.kalshiSeries}&status=open&limit=50`);
                kalshiMarkets = (kData.markets || []).filter(m => {
                    // Apply date filter if specified
                    if (pair.kalshiEventFilter) {
                        return m.event_ticker?.includes(pair.kalshiEventFilter);
                    }
                    return true;
                });
            } catch (e) {
                // Series may not exist on Kalshi
            }
        }
        
        if (kalshiMarkets.length === 0) return resolved;
        
        // Match outcomes
        // Helper: build a resolved pair with proper ask-based pricing
        const buildPair = (pm, km, overrideName, sim) => {
            let pPrices;
            try {
                pPrices = typeof pm.outcomePrices === 'string' ? JSON.parse(pm.outcomePrices) : pm.outcomePrices;
            } catch (e) { return null; }
            if (!pPrices?.[0]) return null;
            
            // CRITICAL: Use ASK prices for buying (what you'd actually pay)
            // Poly mid-price ≈ ask (they don't split bid/ask in gamma API)
            // Kalshi: yes_ask = cost to buy YES, no_ask = cost to buy NO
            const kalshiYesAsk = km.yes_ask || 0;
            const kalshiNoAsk = km.no_ask || 0;
            
            // Skip markets with no Kalshi liquidity (ask = 0 or 100)
            if (kalshiYesAsk <= 0 && kalshiNoAsk <= 0) return null;
            if (kalshiYesAsk >= 100 && kalshiNoAsk >= 100) return null;
            
            // Parse clobTokenIds (may be JSON string)
            let tokenIds = pm.clobTokenIds;
            if (typeof tokenIds === 'string') {
                try { tokenIds = JSON.parse(tokenIds); } catch(e) {}
            }

            // Resolution date — use Kalshi's expiration (more precise) or Poly's end date
            const expiresAt = km.expected_expiration_time || km.expiration_time || pm.endDate || null;

            return {
                name: overrideName || pm.question || pm.groupItemTitle || pair.name,
                category: pair.category,
                similarity: sim,
                polyMarketId: pm.conditionId || pm.id,
                polyTokenId: tokenIds?.[0] || pm.conditionId || pm.id,
                kalshiTicker: km.ticker,
                // Poly prices (mid-market)
                polyYes: parseFloat(pPrices[0]) * 100,
                polyNo: parseFloat(pPrices[1]) * 100,
                // Kalshi ASK prices (actual cost to buy)
                kalshiYes: kalshiYesAsk,
                kalshiNo: kalshiNoAsk,
                // Also store bids for reference
                kalshiYesBid: km.yes_bid || 0,
                kalshiNoBid: km.no_bid || 0,
                polyVolume: parseFloat(pm.volume || 0),
                kalshiVolume: km.volume || 0,
                // When this market resolves / pays out
                expiresAt,
            };
        };

        if (pair.matchBy === 'exact') {
            const pm = polyMarkets[0];
            const km = kalshiMarkets[0];
            const r = buildPair(pm, km, pair.name, 1.0);
            if (r) resolved.push(r);
        } else {
            const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s.$%]/g, ' ').replace(/\s+/g, ' ').trim();
            
            // Extract the distinguishing entity from a market question
            // For "Will the Oklahoma City Thunder win the 2026 NBA Finals?" → "oklahoma city thunder"
            // For "Bitcoin price above $82,000 on Feb 4?" → extract number 82000
            // For "Will CPI rise more than 0.3%?" → extract number 0.3
            const extractEntity = (text) => {
                const n = norm(text);
                // Extract all numbers (including decimals)
                const numbers = (n.match(/[\d]+\.?[\d]*/g) || []).map(Number);
                // Extract dollar amounts specifically
                const dollars = (n.match(/\$\s*([\d,]+\.?\d*)/g) || []).map(s => parseFloat(s.replace(/[$,]/g, '')));
                // Extract percentage amounts
                const percents = (n.match(/([\d.]+)\s*%/g) || []).map(s => parseFloat(s));
                // Extract key entity words (remove common words)
                const stopWords = new Set([
                    'will', 'the', 'be', 'is', 'are', 'was', 'in', 'on', 'at', 'to', 'of', 'for',
                    'and', 'or', 'not', 'by', 'from', 'with', 'this', 'that', 'more', 'than',
                    'above', 'below', 'over', 'under', 'win', 'wins', 'price', 'reach', 'hit',
                    'championship', 'champion', 'finals', 'super', 'bowl', 'nba', 'nfl', 'pro',
                    'football', 'basketball', 'increase', 'decrease', 'rise', 'fall', 'real',
                    'growth', 'rate', 'rates', 'federal', 'reserve', 'fed', 'hike', 'cut',
                    'bitcoin', 'ethereum', 'solana', 'gdp', 'cpi', 'how', 'many', 'what',
                    '2024', '2025', '2026', '2027', '2028', '2029',
                ]);
                const entityWords = n.split(' ').filter(w => w.length > 1 && !stopWords.has(w) && !/^\d+$/.test(w));
                return { numbers, dollars, percents, entityWords, norm: n };
            };

            // Track which Kalshi markets are already matched (1:1 matching)
            // Each Kalshi market should match AT MOST one Poly market (the best fit)
            const usedKalshiTickers = new Set();
            
            // First pass: compute all potential matches with scores
            const candidates = [];
            for (const pm of polyMarkets) {
                const pEntity = extractEntity(pm.question || pm.groupItemTitle || '');
                
                for (const km of kalshiMarkets) {
                    const kEntity = extractEntity(km.title || km.subtitle || '');
                    let score = 0;
                    
                    if (pair.matchBy === 'name') {
                        // For name-based matching (sports teams, people, etc.)
                        // Entity words must overlap — team names, person names
                        if (pEntity.entityWords.length === 0 || kEntity.entityWords.length === 0) continue;
                        
                        const common = pEntity.entityWords.filter(w => kEntity.entityWords.includes(w));
                        const entityOverlap = common.length / Math.max(pEntity.entityWords.length, kEntity.entityWords.length);
                        
                        // Require at least one entity word match
                        if (common.length === 0) continue;
                        score = entityOverlap;
                        
                    } else if (pair.matchBy === 'strike') {
                        // For threshold/strike matching (crypto prices, economic data)
                        // Must match on the THRESHOLD NUMBER + same question structure
                        
                        // Skip range-bracket markets ("between X and Y") — they don't match
                        // threshold markets ("more than X"). These are different contracts!
                        const pNorm = pEntity.norm;
                        if (pNorm.includes('between') || pNorm.includes('range')) continue;
                        
                        // Use ONLY dollar amounts and percentages for strike matching
                        // NOT raw numbers — those catch years (2025, 2026) as false matches
                        const pNums = [...pEntity.dollars, ...pEntity.percents];
                        const kNums = [...kEntity.dollars, ...kEntity.percents];
                        
                        if (pNums.length === 0 || kNums.length === 0) continue;
                        
                        // Find closest number match
                        let closestDiff = Infinity;
                        for (const pn of pNums) {
                            for (const kn of kNums) {
                                const diff = Math.abs(pn - kn) / Math.max(pn, kn);
                                if (diff < closestDiff) closestDiff = diff;
                            }
                        }
                        
                        // Numbers must be within 2% of each other (tighter match)
                        if (closestDiff > 0.02) continue;
                        score = 1.0 - closestDiff;
                        
                    } else {
                        // Generic fallback: Jaccard on all words
                        const pWords = pEntity.norm.split(' ').filter(w => w.length > 2);
                        const kWords = kEntity.norm.split(' ').filter(w => w.length > 2);
                        const common = pWords.filter(w => kWords.includes(w));
                        const union = new Set([...pWords, ...kWords]).size;
                        score = union > 0 ? common.length / union : 0;
                        if (score < 0.35) continue;
                    }
                    
                    if (score > 0) {
                        candidates.push({ pm, km, score });
                    }
                }
            }
            
            // Second pass: greedily assign best matches (1:1, no double-matching)
            // Sort by score descending — best matches first
            candidates.sort((a, b) => b.score - a.score);
            const usedPoly = new Set();
            
            for (const { pm, km, score } of candidates) {
                const polyId = pm.conditionId || pm.id;
                const kalshiId = km.ticker;
                
                // Skip if either side is already matched
                if (usedPoly.has(polyId) || usedKalshiTickers.has(kalshiId)) continue;
                
                const r = buildPair(pm, km, null, score);
                if (r) {
                    resolved.push(r);
                    usedPoly.add(polyId);
                    usedKalshiTickers.add(kalshiId);
                }
            }
        }
    } catch (e) {
        // Silently skip failed pairs — they may be outdated slugs
    }
    
    return resolved;
}

export default MARKET_PAIRS;
