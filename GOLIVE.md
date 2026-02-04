# 🚀 GO-LIVE CHECKLIST — Arb Bot Production Deployment

**Last updated:** 2025-02-04  
**Portfolio target:** $100–200  
**Expected returns:** $1–10 per successful arb (be realistic)

---

## 📋 Pre-Requisites at a Glance

| Item | Status | Notes |
|------|--------|-------|
| Kalshi API key (.kalshi-key.pem) | ✅ Ready | Key ID: `6be3c7c4-fb0e-4b94-8409-d37d7f719f01` |
| Kalshi account funded | ❓ Check | Need $100+ deposited |
| Polymarket private key | ❌ Needed | CLOB API wallet key |
| Polymarket geo-proxy | ❌ Needed | US IPs blocked for CLOB orders |
| Polymarket wallet funded | ❌ Needed | USDC on Polygon |
| `.env` file created | ❌ Needed | See template below |

---

## 1. KALSHI SETUP

### 1a. Verify API Authentication

Your Kalshi RSA key is already at `.kalshi-key.pem`. Run the test script:

```bash
/opt/homebrew/Cellar/node@22/22.22.0/bin/node test/test-kalshi-auth.js
```

This will:
- Load your private key
- Make an authenticated GET to `/trade-api/v2/portfolio/balance`
- Print your account balance or any auth errors

**Expected output:** Your USD balance in cents. If you see `401` or signature errors, the key may need regenerating at https://kalshi.com/account/api-keys.

### 1b. Fund Kalshi Account

1. Log in to https://kalshi.com
2. Go to **Account → Deposit**
3. Options: Bank transfer (ACH), debit card, or wire
4. Deposit **$100–200** (start small)
5. Verify balance with the test script above

### 1c. Kalshi API Limits

- No geo-restriction (US users welcome)
- Rate limit: ~10 requests/sec for REST
- WebSocket: single connection, subscribe to tickers
- Order minimum: 1 contract (typically $0.01–$0.99 each)

---

## 2. POLYMARKET SETUP

### 2a. Get a Polymarket CLOB API Private Key

Polymarket's CLOB (Central Limit Order Book) requires an Ethereum-compatible private key:

1. **Create a fresh wallet** (MetaMask, or generate via `ethers.js`):
   ```js
   import { ethers } from 'ethers';
   const wallet = ethers.Wallet.createRandom();
   console.log('Address:', wallet.address);
   console.log('Private Key:', wallet.privateKey);
   ```
   ⚠️ Store the private key securely. This wallet will hold real USDC.

2. **Register it with Polymarket CLOB:**
   - Go to https://clob.polymarket.com
   - Or use the API: `POST /auth/derive-api-key` with a signed message
   - The `pmxtjs` library handles this if you pass the private key to `new pmxt.polymarket({ privateKey: '0x...' })`

3. **Set the env var:**
   ```
   POLYMARKET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
   ```

### 2b. Set Up a Geo-Proxy (REQUIRED for US users)

Polymarket blocks US IP addresses from placing CLOB orders. You need a proxy server outside the US.

**Option A: Self-hosted proxy on a VPS (recommended)**
1. Spin up a small VPS in **Toronto, London, or Singapore** (DigitalOcean $4/mo, Hetzner $3.29/mo)
2. Deploy a simple proxy server that:
   - Accepts authenticated requests from your bot
   - Forwards them to `https://clob.polymarket.com`
   - Returns the response
3. Set env vars:
   ```
   ORDER_PROXY_URL=https://your-proxy.example.com/proxy
   ORDER_PROXY_TOKEN=your_secret_token
   ```

**Option B: Use a SOCKS5/HTTPS proxy service**
- Residential proxy from a non-US country
- Less reliable, potential IP bans

**Option C: Run the bot itself on a non-US VPS**
- Deploy to Fly.io (already configured in `fly.toml`) in a non-US region
- Change `fly.toml` primary_region to `yyz` (Toronto) or `lhr` (London)
- Then no proxy needed — the bot itself has a non-US IP

**The bot's proxy integration is already built.** See `LiveExecutor.placePolyOrder()` — it routes through `ORDER_PROXY_URL` if configured, with Bearer token auth and a 15-second timeout.

### 2c. Fund the Polymarket Wallet

1. Get USDC on Polygon:
   - Bridge from Ethereum mainnet via https://wallet.polygon.technology/bridge
   - Or buy USDC on Polygon directly (Coinbase → Polygon withdrawal)
   - Or use a DEX on Polygon (QuickSwap, Uniswap on Polygon)
2. Send **$100–200 USDC** to your CLOB wallet address
3. Also need a tiny amount of **MATIC** (~$0.50) for gas fees
4. The wallet needs an **allowance** for the Polymarket Exchange contract:
   ```js
   // pmxtjs may handle this automatically on first order
   // Or manually approve via the Polymarket UI
   ```

### 2d. Verify Polymarket Connection (Read-Only)

You can verify your Polymarket connection without trading:

```bash
/opt/homebrew/Cellar/node@22/22.22.0/bin/node test/test-poly-readonly.js
```

This fetches market data from the Gamma API (no auth required) and tests the CLOB connection.

---

## 3. ENVIRONMENT VARIABLES

Create a `.env` file in the project root:

```bash
# ═══ TRADING MODE ═══
# DRY_RUN=1 (default) = paper trading, no real orders
# DRY_RUN=0 = LIVE TRADING WITH REAL MONEY
DRY_RUN=1

# ═══ POLYMARKET ═══
POLYMARKET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# ═══ KALSHI ═══
# Key ID (already hardcoded as fallback, but good to set explicitly)
KALSHI_API_KEY=6be3c7c4-fb0e-4b94-8409-d37d7f719f01
# Private key loaded from .kalshi-key.pem (no env var needed)

# ═══ GEO-PROXY (for Polymarket orders from US) ═══
ORDER_PROXY_URL=https://your-proxy.example.com/proxy
ORDER_PROXY_TOKEN=your_secret_token

# ═══ CIRCUIT BREAKER (optional — sensible defaults built in) ═══
MAX_DAILY_LOSS_CENTS=2000       # $20 max daily loss
MAX_POSITION_PER_MARKET=30      # 30 contracts per market max
MAX_TOTAL_POSITION=100          # 100 contracts total max
MAX_CONSECUTIVE_ERRORS=3        # Trip after 3 consecutive failures

# ═══ ALERTS (optional) ═══
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_app_password
ALERT_EMAIL_TO=your_email@gmail.com
ALERT_WEBHOOK_URL=                # Discord/Slack webhook for alerts
```

---

## 4. PRE-FLIGHT CHECKS

### 4a. Run in Paper Mode First

```bash
cd ~/clawd/projects/arb-bot-js
# Ensure DRY_RUN=1 in .env (or just don't set it — defaults to paper)
/opt/homebrew/Cellar/node@22/22.22.0/bin/node src/live.js
```

**What to verify:**
- [ ] Dashboard loads at http://localhost:3456
- [ ] Polymarket WebSocket connects (🟢 in tick log)
- [ ] Kalshi WebSocket or REST connects (🟢 or 🔄 in tick log)
- [ ] Market pairs are discovered and matched
- [ ] Opportunities appear with spread calculations
- [ ] Paper trades execute when spreads are profitable
- [ ] P&L tracking looks reasonable
- [ ] Circuit breaker status shows on dashboard

### 4b. Verify Auth Before Going Live

```bash
# Test Kalshi auth
/opt/homebrew/Cellar/node@22/22.22.0/bin/node test/test-kalshi-auth.js

# Test Polymarket read-only
/opt/homebrew/Cellar/node@22/22.22.0/bin/node test/test-poly-readonly.js
```

### 4c. Review Safety Settings

The circuit breaker protects you from runaway losses. Current defaults (configurable via env vars):

| Setting | Default | What It Does |
|---------|---------|-------------|
| Max daily loss | $20 (2000¢) | Halts all trading if cumulative daily loss exceeds this |
| Max per-market position | 30 contracts | Won't add more contracts to a single market |
| Max total position | 100 contracts | Won't exceed this many total open contracts |
| Max consecutive errors | 3 | Trips breaker after 3 failed executions in a row |
| Cooldown | 60 seconds | Minimum wait after a trip before manual reset |
| Liquidity safety margin | 50% | Only uses half of visible book depth |
| Min order size | $1.10 | Polymarket minimum ($1) + $0.10 buffer |

**When circuit breaker trips: ALL trading stops. Requires manual reset (restart the bot or use dashboard).**

### 4d. Dashboard Monitoring

The dashboard at http://localhost:3456 shows:
- **Live prices** from both platforms
- **Spread calculations** with profit/loss per contract
- **Open positions** with entry prices and current P&L
- **Trade log** with execution times
- **Circuit breaker status** (green = ok, red = tripped)
- **Executor status** (paper/live mode, proxy status)

---

## 5. GOING LIVE — Step by Step

### Step 1: Fund Both Accounts
- [ ] Kalshi: $100+ deposited, verified via test script
- [ ] Polymarket: $100+ USDC in wallet on Polygon + small MATIC for gas

### Step 2: Set Up Geo-Proxy
- [ ] Proxy deployed and tested (curl it from your machine)
- [ ] `ORDER_PROXY_URL` and `ORDER_PROXY_TOKEN` in `.env`

### Step 3: Create `.env` File
```bash
cp .env.example .env
# Edit with real values — see Section 3 above
```

### Step 4: Final Paper Run
```bash
DRY_RUN=1 /opt/homebrew/Cellar/node@22/22.22.0/bin/node src/live.js
# Watch for 30+ minutes. Verify everything works.
# Check dashboard, check logs, check that paper trades make sense.
```

### Step 5: Go Live
```bash
# In .env, change:
DRY_RUN=0

# Then start:
/opt/homebrew/Cellar/node@22/22.22.0/bin/node src/live.js
```

You'll see:
```
╔═══════════════════════════════════════════════════╗
║   🎯 ARB BOT v3 — MULTI-STRATEGY                ║
║   🔴 LIVE MODE — REAL MONEY                      ║
╚═══════════════════════════════════════════════════╝

⚠️  ⚠️  ⚠️  LIVE TRADING ENABLED — REAL ORDERS WILL BE PLACED ⚠️  ⚠️  ⚠️
```

### Step 6: Monitor

**Active monitoring (first few hours):**
- Keep the dashboard open at http://localhost:3456
- Watch the terminal for 🔴 LIVE execution logs
- Check for any 🚨 CRITICAL alerts (partial fills)
- Verify orders appear on Kalshi's order page and Polymarket's portfolio

**Passive monitoring:**
- Set up email alerts (GMAIL_USER/GMAIL_APP_PASSWORD in .env)
- Or set up a Discord webhook (ALERT_WEBHOOK_URL)
- The bot sends alerts for: trades executed, big opportunities, partial fills, bot start/stop

### Step 7: Emergency Stop

**Option 1: Ctrl+C** — Graceful shutdown, closes WebSockets, stops all strategies.

**Option 2: Kill the process:**
```bash
pkill -f "node src/live.js"
```

**Option 3: Circuit breaker** — If losses hit the max, trading auto-halts.

**After stopping:**
- Check open positions on both platforms manually
- Close any unhedged positions
- Review the audit log in the dashboard or terminal output

---

## 6. REALISTIC EXPECTATIONS

### With a $100–200 Portfolio

- **Typical arb spread:** 1–5¢ per contract
- **Contracts per trade:** 5–20 (limited by liquidity and min order)
- **Gross profit per trade:** $0.05–$1.00
- **Fees eat into this:** Kalshi charges `ceil(0.07 × p × (1-p))` per contract
- **Net profit per trade:** $0.01–$0.50 realistically
- **Trades per day:** 0–5 (arb opportunities are rare and fleeting)
- **Expected daily return:** $0–$5 on a good day, $0 on most days
- **Monthly estimate:** $10–$50 if markets are active and spreads exist

### Risks

1. **Partial fills** — One leg executes, the other doesn't. You're left with an unhedged directional position. The bot alerts you, but you must manually resolve it.
2. **Stale prices** — WebSocket disconnect + REST latency = you trade on old prices. The bot has reconnection logic but isn't perfect.
3. **Liquidity illusion** — Book depth can vanish between price check and order placement.
4. **Resolution risk** — Markets can resolve ambiguously or differently across platforms.
5. **Platform risk** — API outages, rate limits, account restrictions.
6. **Geo-blocking** — Polymarket may block your proxy IP.

### Why Start Small

With $100–200, your max loss is... $100–200. The circuit breaker limits daily loss to $20 by default. This is the right way to validate the strategy before scaling up.

---

## 7. FILE REFERENCE

| File | Purpose |
|------|---------|
| `src/live.js` | Main entry point — orchestrates everything |
| `src/live-executor.js` | Places REAL orders on both platforms |
| `src/circuit-breaker.js` | Risk limits — stops trading on excess loss |
| `src/paper-trader.js` | Paper trading engine for tracking |
| `src/kalshi-auth.js` | RSA-PSS signing for Kalshi API |
| `src/order-manager.js` | Timeout wrapper for trade execution |
| `src/market-pairs.js` | Curated cross-platform market mappings |
| `src/dashboard.js` | Express + WebSocket dashboard on :3456 |
| `src/alerts.js` | iMessage / webhook alerts |
| `src/email-alerts.js` | Gmail alerts |
| `config.js` | Base config (mostly for the old polling bot) |
| `.env` | Your secrets (gitignored) |
| `.kalshi-key.pem` | Kalshi RSA private key (gitignored) |
| `test/test-kalshi-auth.js` | Kalshi auth verification script |
| `test/test-poly-readonly.js` | Polymarket read-only connection test |

---

## 8. QUICK TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| Kalshi 401 error | Key may be expired. Regenerate at kalshi.com/account/api-keys |
| Polymarket order rejected | Check: wallet funded? Allowance set? Proxy working? |
| "Proxy error 403" | Proxy IP may be blocked. Try a different region. |
| Circuit breaker tripped | Check the reason in logs. Reset by restarting the bot. |
| Partial fill alert | **MANUAL ACTION NEEDED.** Check both platforms, close the unhedged leg. |
| No opportunities found | Normal. Arb opportunities are rare. Check that WebSockets are connected. |
| Dashboard not loading | Make sure port 3456 isn't in use. Check for startup errors. |
| "Insufficient liquidity" | Book is too thin. Bot auto-skips these. |

---

*Built by Molt 🎯 — Go make some money (carefully).*
