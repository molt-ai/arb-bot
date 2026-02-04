# Arb Bot Trust Scorecard

> **Last reset:** 2026-02-04 — Previous P&L was fake. See "Why We Reset" below.

## Current Status

| Metric | Value |
|--------|-------|
| Paper balance | $500 Poly + $500 Kalshi |
| Open positions | 0 |
| Total realized P&L | $0.00 |
| Total trades | 0 |

## Trade Type Breakdown

### ✅ Cross-Platform Arb (TRUE arb)
- **How it works:** Buy YES on Platform A + NO on Platform B. Total cost < $1. At resolution, one side ALWAYS pays $1. Guaranteed profit.
- **Resolved:** 0
- **Net P&L:** $0.00
- **Win rate:** N/A

### ⚠️ Combinatorial Speculative (NOT guaranteed)
- **How it works:** Single-platform bets based on detected relationships between markets (same entity, implied pricing). Profit depends on the entity matcher being correct AND the market outcome.
- **Resolved:** 0
- **Net P&L:** $0.00
- **Win rate:** N/A
- **WARNING:** These are directional bets, not arbitrage. They can lose money.

## Why We Reset (2026-02-04)

The previous paper P&L of **$35.06** was fabricated by the combinatorial strategy:

1. **False equivalence matching:** The entity matcher was calling completely different stats "the same market":
   - "Andre Drummond: **Points** O/U 8.5" matched with "Andre Drummond: **Rebounds** O/U 9.5"
   - "Myles Turner: **Points** O/U 15.5" matched with "Myles Turner: **Assists** O/U 1.5"
   - "Patriots **Team Total**: O/U 21.5" matched with "**Seahawks** Team Total: O/U 23.5"

2. **Instant fake resolution:** Combo trades were "resolved" with holdTime of 5-6 **milliseconds** — the auto-redeemer was immediately crediting $1 payouts without checking if markets actually ended.

3. **Single-platform bets masquerading as arb:** All combo positions had `kalshiPrice: 0`, `kalshiSide: null` — they were single-platform directional bets, not cross-platform arbitrage.

### What We Fixed

1. **Trade classification:** Every trade is now labeled as `cross_platform_arb` (real) or `combinatorial_speculative` (not guaranteed).

2. **Arb validation:** Cross-platform arbs must pass: `buyPrice + sellPrice < 100¢` after fees. If not, rejected.

3. **Honest resolution:** 
   - True arbs: auto-resolve after market expiry (guaranteed payout)
   - Speculative trades: NEVER auto-resolve. Must verify actual market outcome via API. If unverifiable, use 50/50 coin flip.

4. **Full reasoning logged:** Every trade records WHY it was entered — what markets, what relationship, what prices.

## Open Positions

_None — fresh start._

## How to Read This

The scorecard auto-generates from `PaperTrader.getPortfolioSummary().trustScorecard`. The dashboard API serves it at `/api/status` under the `trustScorecard` key.

**Trust the numbers only when:**
- Cross-platform arb P&L = real (math guarantees it)
- Speculative P&L = track record (not guaranteed, could be random)
- Win rate > 70% on speculative trades after 50+ trades = entity matcher is working
- Win rate ~50% on speculative trades = entity matcher is no better than random
