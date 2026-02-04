# Arb Bot Strategy Guide — The Math

## 3 Proven Strategies (Ranked by Edge Quality)

---

### 🟢 Strategy 1: Same-Market Rebalancing (BTC 15-Min)
**Edge: TRUE ARBITRAGE — guaranteed profit**
**Proven returns: $764/day on $200 deposit (documented), $5-10K/day at scale**

**How it works:**
- Polymarket has 15-minute BTC/ETH/SOL "up or down" markets
- Each market has UP shares + DOWN shares
- One of them ALWAYS pays $1.00 at resolution
- When UP + DOWN costs < $1.00, buy both → guaranteed profit

**Example:**
```
UP price:  $0.48
DOWN price: $0.51
Total cost: $0.99
Payout:     $1.00 (always, one side wins)
Profit:     $0.01 per pair (1.01% in 15 minutes)
```

With 100 shares: spend $99, receive $100. Profit $1.
With $200 deployed across multiple 15-min windows: compounds fast.

**Why the opportunity exists:**
- Different traders place orders on each side at different times
- Bid/ask spreads create windows where both sides sum < $1.00
- Volatility causes temporary mispricings
- Markets refresh every 15 minutes = high capital velocity

**Fee consideration:**
- Polymarket added taker fees on 15-min crypto markets (up to 3%)
- Threshold must be: UP + DOWN < $1.00 - fees
- At 3% fee: need combined cost < ~$0.97 to profit
- Opportunities are smaller but still exist

**Risk: MINIMAL**
- Execution risk only (one leg doesn't fill)
- Mitigation: fill-or-kill orders, walk the book for real executable prices

**Source:** gabagool bot — $313 → $414K in one month, 98% win rate
Reference: https://github.com/gabagool222/15min-btc-polymarket-trading-bot

---

### 🟢 Strategy 2: Cross-Platform Arbitrage (Poly vs Kalshi)
**Edge: TRUE ARBITRAGE — guaranteed profit**
**Proven returns: $40M extracted across all traders April 2024-April 2025**

**How it works:**
- Same event listed on both Polymarket and Kalshi
- Buy YES on one platform + NO on the other
- Combined cost < $1.00 → guaranteed profit at resolution

**Example:**
```
Event: "Fed cuts rates in March"
Polymarket YES: $0.62
Kalshi NO:      $0.35
Total cost:     $0.97
Payout:         $1.00
Profit:         $0.03 per contract (3.1%)
```

**Fee consideration:**
- Polymarket: 2% on winning side
- Kalshi: up to 3% taker fee
- Need spread > 5% to be profitable after both platforms' fees

**Why the opportunity exists:**
- Information asymmetry between platforms
- Different user bases (crypto-native vs traditional)
- Polymarket leads price discovery, Kalshi lags by minutes
- Different liquidity profiles

**Risk: LOW**
- Execution risk (one leg fills, other doesn't)
- Resolution risk (platforms disagree on outcome — has happened!)
- Capital lock-up (hold to resolution, could be days/weeks)

**Source:** IMDEA study (arXiv:2508.03474), top 3 wallets earned $4.2M combined

---

### 🟡 Strategy 3: Crypto Speed / Momentum
**Edge: STATISTICAL — high win rate but not guaranteed**
**Proven returns: 98% win rate at scale, but needs larger capital**

**How it works:**
- Exchange prices (Binance/Coinbase) move before Polymarket adjusts
- When BTC is clearly trending UP (+0.15% in 2 min), Polymarket's UP shares lag
- Buy UP cheap before market catches up, hold to resolution

**Example:**
```
BTC on Binance: just jumped +0.3% in 2 minutes
Polymarket UP price: still $0.50 (should be ~$0.65)
Buy UP at $0.50
Resolution: BTC was up → UP pays $1.00
Profit: $0.50 per share
```

**Fee consideration:**
- Same taker fees on 15-min markets (up to 3%)
- Need strong enough signal to overcome fees

**Why the opportunity exists:**
- Polymarket market makers are slow to adjust
- Exchange WebSocket data is 1-2 minutes ahead
- During volatile periods, the lag is larger

**Risk: MODERATE**
- Momentum can reverse (you buy UP, BTC reverses in last 5 minutes)
- Not guaranteed — it's a probability game, not true arbitrage
- Win rate ~98% at scale, but individual trades can lose

---

## Fee Structure (as of Jan 2026)

| Platform | Fee Type | Amount |
|----------|----------|--------|
| Polymarket | Most markets | 0% (free) |
| Polymarket | 15-min crypto | Up to 3% taker |
| Polymarket | Winning side | 2% |
| Kalshi | Taker | Up to 3% |
| Kalshi | Settlement | $0.01/contract if wrong |

## Capital Requirements

| Strategy | Min Capital | Recommended | Expected Daily Return |
|----------|------------|-------------|----------------------|
| BTC 15-min Arb | $50 | $200-500 | 1-5% |
| Cross-Platform | $200 ($100/platform) | $500-1000 | 0.5-3% |
| Crypto Speed | $100 | $500+ | Variable |

## Priority Order
1. **BTC 15-min same-market arb** — Start here. Lowest risk, fastest capital turnover.
2. **Cross-platform arb** — Add when you have capital on both platforms.
3. **Crypto speed** — Enable during volatile hours (US market open, crypto news).
