/**
 * Curated Cross-Platform Market Pairs
 * Hand-verified mappings between Polymarket and Kalshi
 * 
 * This is more reliable than fuzzy matching — we verify
 * each pair refers to the SAME event/date/outcome.
 * 
 * The multi-scanner discovers candidates; this file confirms them.
 */

// Kalshi API base for fetching fresh market data
export const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
export const POLY_GAMMA = 'https://gamma-api.polymarket.com';

/**
 * Each pair:
 * - polySlug: Polymarket event slug (fetch from gamma-api)
 * - kalshiSeries: Kalshi series ticker (fetch markets from API)
 * - category: for UI grouping
 * - matchBy: how to match individual outcomes ('name' or 'exact')
 * - active: whether to monitor this pair
 */
export const MARKET_PAIRS = [
    // ═══════════════════════════════════════════════════════════
    // SHORT-TERM MARKETS ONLY — resolve within days, not years
    // Long-dated pairs deactivated (capital should turn over fast)
    // ═══════════════════════════════════════════════════════════

    // ═══ POLITICS & GOVERNMENT (near-term deadlines only) ═══
    {
        name: 'Fed Chair Nomination',
        polySlug: 'who-will-trump-nominate-as-fed-chair',
        kalshiSeries: 'KXFEDCHAIRNOM',
        category: 'politics',
        matchBy: 'name',
        active: false, // no imminent resolution date
    },
    {
        name: 'Government Shutdown Jan 31',
        polySlug: 'will-there-be-another-us-government-shutdown-by-january-31',
        kalshiTicker: 'KXGOVSHUT-26JAN31',
        category: 'politics',
        matchBy: 'exact',
        active: true, // resolves Jan 31 — imminent!
    },
    
    // ═══ FED & ECONOMICS (only upcoming decisions) ═══
    {
        name: 'Fed Decision March 2026',
        polySlug: 'fed-decision-in-march-885',
        kalshiSeries: 'KXFEDDECISION',
        kalshiEventFilter: '26MAR',
        category: 'economics',
        matchBy: 'name',
        active: true, // resolves on Fed meeting day
    },
    {
        name: 'Fed Rate Cuts 2026',
        polySlug: 'how-many-fed-rate-cuts-in-2026',
        kalshiSeries: 'KXRATECUTCOUNT',
        category: 'economics',
        matchBy: 'name',
        active: false, // full-year → too long
    },
    {
        name: 'Large Fed Rate Cut 2026',
        polySlug: 'fed-to-cut-more-than-25bps-in-2026',
        kalshiSeries: 'KXLARGECUT',
        category: 'economics',
        matchBy: 'exact',
        active: false, // full-year → too long
    },
    {
        name: 'January 2026 CPI',
        polySlug: 'january-2026-cpi',
        kalshiSeries: 'KXCPI',
        kalshiEventFilter: '26JAN',
        category: 'economics',
        matchBy: 'name',
        active: true, // resolves on CPI release day
    },

    // ═══ CRYPTO (daily/weekly brackets — high volatility) ═══
    {
        name: 'Bitcoin Price Monthly',
        polySlug: 'what-price-will-bitcoin-hit-in-january',
        kalshiSeries: 'KXBTC',
        category: 'crypto',
        matchBy: 'strike',
        active: true,
    },
    {
        name: 'Bitcoin Daily',
        polySlug: 'bitcoin-above-on-january-30',
        kalshiSeries: 'KXBTCD',
        category: 'crypto',
        matchBy: 'strike',
        active: true, // daily resolution!
    },
    {
        name: 'Ethereum Price',
        polySlug: 'ethereum-above-on-january-30',
        kalshiSeries: 'KXETH',
        category: 'crypto',
        matchBy: 'strike',
        active: true,
    },
    {
        name: 'Solana Price',
        polySlug: 'solana-above-on-january-30',
        kalshiSeries: 'KXSOL',
        category: 'crypto',
        matchBy: 'strike',
        active: true,
    },

    // ═══ 2028 ELECTIONS (deactivated — years away) ═══
    {
        name: '2028 Presidential Election',
        polySlug: 'presidential-election-winner-2028',
        kalshiSeries: 'KXPRES28',
        category: 'politics',
        matchBy: 'name',
        active: false, // 1000+ days out
    },
    {
        name: '2028 Democratic Nominee',
        polySlug: 'democratic-presidential-nominee-2028',
        kalshiSeries: 'KXDEM28',
        category: 'politics',
        matchBy: 'name',
        active: false, // 1000+ days out
    },
    {
        name: '2028 Republican Nominee',
        polySlug: 'republican-presidential-nominee-2028',
        kalshiSeries: 'KXREP28',
        category: 'politics',
        matchBy: 'name',
        active: false, // 1000+ days out
    },

    // ═══ GEOPOLITICS (deactivated — open-ended) ═══
    {
        name: 'US Strikes Iran',
        polySlug: 'us-strikes-iran-by',
        kalshiSeries: 'KXUSSTRIKE',
        category: 'geopolitics',
        matchBy: 'name',
        active: false, // no near-term resolution date
    },

    // ═══ SPORTS (keep — resolve on game day) ═══
    {
        name: 'Super Bowl 2026',
        polySlug: 'super-bowl-champion-2026',
        kalshiSeries: 'KXNFLSB',
        category: 'sports',
        matchBy: 'name',
        active: true, // Feb 8 — close!
    },
    {
        name: 'NBA Champion 2026',
        polySlug: '2026-nba-champion',
        kalshiSeries: 'KXNBACHAMP',
        category: 'sports',
        matchBy: 'name',
        active: false, // June — too far
    },
    {
        name: 'FIFA World Cup 2026',
        polySlug: '2026-fifa-world-cup-winner-595',
        kalshiSeries: 'KXFIFAWC',
        category: 'sports',
        matchBy: 'name',
        active: false, // Summer 2026 — too far
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
            const km = await fetchKalshi(`/markets/${pair.kalshiTicker}`);
            if (km.market) kalshiMarkets = [km.market];
        } else if (pair.kalshiSeries) {
            const kData = await fetchKalshi(`/markets?series_ticker=${pair.kalshiSeries}&status=open&limit=50`);
            kalshiMarkets = (kData.markets || []).filter(m => {
                // Apply date filter if specified
                if (pair.kalshiEventFilter) {
                    return m.event_ticker?.includes(pair.kalshiEventFilter);
                }
                return true;
            });
        }
        
        if (kalshiMarkets.length === 0) return resolved;
        
        // Match outcomes
        // Helper: build a resolved pair with proper ask-based pricing
        const buildPair = (pm, km, overrideName, sim) => {
            const pPrices = pm.outcomePrices ? JSON.parse(pm.outcomePrices) : [];
            if (!pPrices[0]) return null;
            
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
            const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
            
            for (const pm of polyMarkets) {
                const pName = norm(pm.question || pm.groupItemTitle || '');
                
                for (const km of kalshiMarkets) {
                    const kName = norm(km.title || km.subtitle || '');
                    
                    const pWords = pName.split(' ').filter(w => w.length > 2);
                    const kWords = kName.split(' ').filter(w => w.length > 2);
                    const common = pWords.filter(w => kWords.includes(w));
                    const similarity = common.length / Math.max(pWords.length, kWords.length);
                    
                    if (similarity > 0.35 || common.length >= 3) {
                        const r = buildPair(pm, km, null, similarity);
                        if (r) resolved.push(r);
                        break;
                    }
                }
            }
        }
    } catch (e) {
        // Silently skip failed pairs
    }
    
    return resolved;
}

export default MARKET_PAIRS;
