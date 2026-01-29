// Configuration for the arbitrage bot
export const config = {
  // Market URLs to monitor - Fed Chair nomination (active market)
  polymarketUrl: 'https://polymarket.com/event/who-will-trump-nominate-as-fed-chair',
  kalshiUrl: 'https://kalshi.com/markets/kxfedchairnom/fed-chair-nominee/kxfedchairnom-29',

  // Polling interval in seconds
  pollIntervalSeconds: 30,

  // Minimum profit margin in cents to execute trade
  minProfitCents: 0.5,

  // Trading mode: 'YOLO' (all-in) or 'CONSERVATIVE' (fixed amount)
  tradingMode: 'CONSERVATIVE',

  // If CONSERVATIVE mode, amount to trade per opportunity (in cents = $10)
  tradeAmountCents: 1000,

  // API credentials (set via environment variables) - not needed for dry run
  polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY,
  kalshiApiKey: process.env.KALSHI_API_KEY,
  kalshiApiSecret: process.env.KALSHI_API_SECRET,

  // Fuzzy matching threshold (0-1, higher = stricter matching)
  matchingThreshold: 0.6,

  // Enable dry run mode (no actual trades) - PAPER TRADING
  dryRun: true,

  // Number of top opportunities to show
  topNOpportunities: 10,

  // Minimum price threshold - skip markets where YES or NO is <= this value (in cents)
  minPriceThreshold: 2,
};
