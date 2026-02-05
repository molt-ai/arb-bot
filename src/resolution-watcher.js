/**
 * Resolution Watcher — Settlement Lag Opportunity Scanner
 * 
 * When a market resolves, prices SHOULD instantly go to $0 or $1.
 * But on Polymarket, they often drift slowly — creating a window
 * where you can buy the obvious winner at a discount.
 * 
 * Example: Assad flees Syria (outcome determined), but YES="Assad stays"
 * is still $0.30 instead of $0. Buy NO at $0.30, guaranteed $0.70 profit.
 * 
 * This module:
 * - Periodically checks recently closed Polymarket markets
 * - Identifies settlement lag opportunities (prices not yet at 0/100)
 * - Logs opportunities but does NOT auto-trade (needs validation)
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

export class ResolutionWatcher {
  constructor(config = {}) {
    this.checkIntervalMs = config.checkIntervalMs || 5 * 60 * 1000; // 5 min
    this.maxAgeHours = config.maxAgeHours || 24;
    this.minProfitCents = config.minProfitCents || 3; // Min profit to log
    this.opportunities = [];
    this.stats = {
      checksRun: 0,
      marketsScanned: 0,
      opportunitiesFound: 0,
      lastCheck: null,
    };
    this._interval = null;
    this._running = false;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    console.log('[RESOLUTION-WATCHER] 🔍 Starting settlement lag scanner...');
    console.log(`[RESOLUTION-WATCHER] Config: check every ${this.checkIntervalMs / 1000}s, max age ${this.maxAgeHours}h, min profit ${this.minProfitCents}¢`);
    
    // Run immediately, then on interval
    await this.checkResolvedMarkets();
    this._interval = setInterval(() => this.checkResolvedMarkets(), this.checkIntervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._running = false;
    console.log('[RESOLUTION-WATCHER] Stopped');
  }

  async checkResolvedMarkets() {
    try {
      this.stats.checksRun++;
      this.stats.lastCheck = new Date().toISOString();
      
      // Fetch recently closed markets
      const response = await fetch(`${GAMMA_API}/markets?closed=true&limit=100`);
      if (!response.ok) {
        console.error(`[RESOLUTION-WATCHER] API error: ${response.status}`);
        return;
      }
      
      const markets = await response.json();
      if (!Array.isArray(markets)) {
        console.error('[RESOLUTION-WATCHER] Unexpected API response format');
        return;
      }
      
      this.stats.marketsScanned += markets.length;
      
      // Filter to recent closed markets (within maxAgeHours)
      const cutoffTime = Date.now() - (this.maxAgeHours * 60 * 60 * 1000);
      const recentlyResolved = markets.filter(m => {
        if (!m.closedTime) return false;
        const closedAt = new Date(m.closedTime).getTime();
        return closedAt >= cutoffTime;
      });
      
      if (recentlyResolved.length === 0) {
        // No recently resolved markets found
        return;
      }
      
      const newOpportunities = [];
      
      for (const market of recentlyResolved) {
        const opp = this._analyzeMarket(market);
        if (opp) {
          newOpportunities.push(opp);
        }
      }
      
      // Update opportunities list (replace, don't append duplicates)
      this.opportunities = newOpportunities;
      this.stats.opportunitiesFound = newOpportunities.length;
      
      if (newOpportunities.length > 0) {
        console.log(`[RESOLUTION-WATCHER] 💰 Found ${newOpportunities.length} settlement lag opportunities:`);
        for (const opp of newOpportunities) {
          console.log(`  • ${opp.question.substring(0, 50)}...`);
          console.log(`    ${opp.type}: ${opp.side} @ ${opp.currentPrice}¢ → Expected profit: ${opp.profitCents.toFixed(1)}¢`);
        }
      }
      
    } catch (error) {
      console.error('[RESOLUTION-WATCHER] Error checking markets:', error.message);
    }
  }

  _analyzeMarket(market) {
    try {
      // Parse outcome prices
      let prices = market.outcomePrices;
      if (typeof prices === 'string') {
        prices = JSON.parse(prices);
      }
      if (!Array.isArray(prices) || prices.length < 2) return null;
      
      const yesPrice = parseFloat(prices[0]) * 100; // Convert to cents
      const noPrice = parseFloat(prices[1]) * 100;
      
      // Check for settlement lag opportunities
      // Opportunity exists if:
      // 1. Winning outcome < 95¢ (should be ~100¢)
      // 2. OR losing outcome > 5¢ (should be ~0¢)
      
      const opportunities = [];
      
      // Check YES side
      if (yesPrice > 5 && yesPrice < 95) {
        // Market hasn't settled — both sides potentially tradeable
        // We need to determine which is the "correct" side
        // For now, log both as potential opportunities
        
        // If YES is low (<50), it's likely losing — buy NO
        if (yesPrice < 50) {
          const profitCents = 100 - noPrice; // Buy NO, get $1 at resolution
          if (profitCents >= this.minProfitCents) {
            return {
              question: market.question,
              conditionId: market.conditionId || market.id,
              slug: market.slug,
              closedTime: market.closedTime,
              type: 'settlement_lag',
              side: 'NO',
              currentPrice: noPrice.toFixed(1),
              expectedValue: 100,
              profitCents,
              yesPrice: yesPrice.toFixed(1),
              noPrice: noPrice.toFixed(1),
              bestBid: market.bestBid,
              bestAsk: market.bestAsk,
              lastTradePrice: market.lastTradePrice,
              detectedAt: new Date().toISOString(),
            };
          }
        }
        
        // If YES is high (>50), it's likely winning — buy YES
        if (yesPrice > 50 && yesPrice < 95) {
          const profitCents = 100 - yesPrice; // Buy YES, get $1 at resolution
          if (profitCents >= this.minProfitCents) {
            return {
              question: market.question,
              conditionId: market.conditionId || market.id,
              slug: market.slug,
              closedTime: market.closedTime,
              type: 'settlement_lag',
              side: 'YES',
              currentPrice: yesPrice.toFixed(1),
              expectedValue: 100,
              profitCents,
              yesPrice: yesPrice.toFixed(1),
              noPrice: noPrice.toFixed(1),
              bestBid: market.bestBid,
              bestAsk: market.bestAsk,
              lastTradePrice: market.lastTradePrice,
              detectedAt: new Date().toISOString(),
            };
          }
        }
      }
      
      // Additional check: losing side still has value (>5¢)
      // This is clearer — if outcome is known and loser is >5¢, it's free money
      if (yesPrice > 95) {
        // YES won — NO should be ~0¢
        if (noPrice > 5) {
          // NO is overpriced — but we can't profit by buying NO (it's worthless)
          // This is only exploitable if we can SHORT NO (sell to close)
          // Skip for now — requires existing position
        }
      }
      
      if (noPrice > 95) {
        // NO won — YES should be ~0¢
        if (yesPrice > 5) {
          // YES is overpriced — but we can't profit by buying YES (it's worthless)
          // Skip for now
        }
      }
      
      return null;
      
    } catch (error) {
      // Parsing error — skip this market
      return null;
    }
  }

  getOpportunities() {
    return this.opportunities;
  }

  getStats() {
    return {
      ...this.stats,
      running: this._running,
      currentOpportunities: this.opportunities.length,
    };
  }

  getStatus() {
    return {
      running: this._running,
      config: {
        checkIntervalMs: this.checkIntervalMs,
        maxAgeHours: this.maxAgeHours,
        minProfitCents: this.minProfitCents,
      },
      stats: this.stats,
      opportunities: this.opportunities,
    };
  }
}

export default ResolutionWatcher;
