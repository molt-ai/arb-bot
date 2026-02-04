// Configuration for the arbitrage bot
export const config = {
  // ═══════════════════════════════════════════════════════════
  // STRATEGY FLAGS — what the bot actually runs
  // ═══════════════════════════════════════════════════════════

  // TRUE ARBITRAGE: Buy YES on one platform + NO on the other for the SAME event.
  // Guaranteed profit at resolution regardless of outcome (after fees).
  // This is the ONLY strategy enabled by default.
  enableCrossPlatformArb: true,

  // CRYPTO SPEED: Exploits Polymarket crypto markets lagging behind Binance spot.
  // Covers 15-min, hourly, and daily "above $X" / "up or down" markets.
  // Single-platform directional bet — not cross-platform arb, but a real edge
  // when exchange prices lead prediction market pricing.
  // Duration-aware: daily markets require stronger momentum than 15-min markets.
  enableCryptoSpeed: true,

  // THEORETICAL ARB: Buy YES + NO on same Polymarket market when sum < $1.
  // Real arb in theory but windows last ~200ms — too fast for this bot.
  // Has found 0 opportunities in testing. Disabled by default.
  enableSameMarketArb: false,

  // 15-MIN CRYPTO SAME-MARKET ARB ("Gabagool" Strategy):
  // Buy BOTH UP and DOWN on Polymarket's 15-min BTC/ETH/SOL markets when
  // combined cost < $1.00 (minus fees). Pure arbitrage — guaranteed $1.00
  // payout regardless of outcome. Walks the CLOB order book for real prices.
  // Reference: https://github.com/gabagool222/15min-btc-polymarket-trading-bot
  enableBtc15minArb: true,
  btc15minTargetPairCost: 0.97,  // Max combined cost ($) — must be < 1.00 minus fees
  btc15minOrderSize: 10,          // Shares per leg (both UP and DOWN)

  // SPECULATIVE: Finds pricing inconsistencies between logically related markets
  // on Polymarket (e.g., "Trump wins" vs "Republican wins"). NOT guaranteed profit —
  // relies on the entity matcher correctly identifying relationships and the market
  // eventually correcting. More like statistical edge trading. Disabled by default.
  enableCombinatorialArb: false,

  // ═══════════════════════════════════════════════════════════
  // CROSS-PLATFORM ARB SETTINGS
  // ═══════════════════════════════════════════════════════════

  // Market URLs to monitor (legacy, used for REST fallback polling)
  polymarketUrl: 'https://polymarket.com/event/who-will-trump-nominate-as-fed-chair',
  kalshiUrl: 'https://kalshi.com/markets/kxfedchairnom/fed-chair-nominee/kxfedchairnom-29',

  // Polling interval in seconds (REST fallback when WebSocket disconnects)
  pollIntervalSeconds: 30,

  // Minimum profit margin in cents to execute trade (after fees)
  minProfitCents: 0.5,

  // Trading mode: 'YOLO' (all-in) or 'CONSERVATIVE' (fixed amount)
  tradingMode: 'CONSERVATIVE',

  // If CONSERVATIVE mode, amount to trade per opportunity (in cents = $10)
  tradeAmountCents: 1000,

  // Fuzzy matching threshold (0-1, higher = stricter matching for auto-discovery)
  matchingThreshold: 0.6,

  // Enable dry run mode (no actual trades) - PAPER TRADING
  dryRun: true,

  // Number of top opportunities to show on dashboard
  topNOpportunities: 10,

  // Minimum price threshold - skip markets where YES or NO is <= this value (in cents)
  // Markets at extreme prices (1-2¢) have no real liquidity
  minPriceThreshold: 2,

  // Maximum days to expiry — skip markets resolving further out than this
  // Cross-platform arb locks capital until resolution, so shorter = better ROI.
  // 180 days captures quarterly economics, sports seasons, near-term politics.
  // Set lower (30-60) for faster capital turnover, higher for more matches.
  maxDaysToExpiry: 180,

  // ═══════════════════════════════════════════════════════════
  // AUTO-DISCOVERY SETTINGS
  // ═══════════════════════════════════════════════════════════

  // Number of Polymarket events to scan for auto-discovery (sorted by volume)
  discoveryPolyEventLimit: 200,

  // Kalshi series to scan for auto-discovery (non-sports, cross-platform relevant)
  // These are queried individually — much faster than scanning all 3000+ open markets
  discoveryKalshiSeries: [
    // Economics / Fed
    'KXCPI', 'KXGDP', 'KXFED', 'KXFEDDECISION', 'KXRATECUTCOUNT', 'KXLARGECUT',
    // Crypto
    'KXBTC', 'KXBTCD', 'KXETH', 'KXSOL',
    // Politics
    'KXFEDCHAIRNOM', 'KXGOVSHUT', 'KXGREENLAND',
    // Sports
    'KXNBA', 'KXSB',
    // Entertainment
    'KXOSCARS', 'KXNEWPOPE',
    // Elections (long-dated but high volume)
    'KXPRES28', 'KXDEM28', 'KXREP28',
  ],

  // Minimum similarity score for auto-discovered cross-platform pairs (0-1)
  // Lower = more matches but more false positives. 0.3 is fairly permissive.
  discoveryMinSimilarity: 0.30,

  // ═══════════════════════════════════════════════════════════
  // API CREDENTIALS (set via environment variables)
  // ═══════════════════════════════════════════════════════════

  polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY,
  kalshiApiKey: process.env.KALSHI_API_KEY,
  kalshiApiSecret: process.env.KALSHI_API_SECRET,
};
