# 🎯 Arb Bot — Prediction Market Arbitrage

Real-time arbitrage detection across **Polymarket** and **Kalshi** with paper trading, live dashboard, and instant alerts.

## Architecture

```
┌─────────────────────────────────────────────┐
│              Live Bot (live.js)              │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Poly WS  │  │ Kalshi   │  │  Market   │ │
│  │ Real-time│  │ Polling  │  │  Scanner  │ │
│  │ Prices   │  │ (5s)     │  │  (5 min)  │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│       │             │               │       │
│       └──────┬──────┘               │       │
│              ▼                      │       │
│     ┌────────────────┐              │       │
│     │ Spread Calc    │◄─────────────┘       │
│     │ Arb Detection  │                      │
│     └───────┬────────┘                      │
│             │                               │
│    ┌────────┴────────┐                      │
│    ▼                 ▼                      │
│ ┌──────────┐  ┌───────────┐                 │
│ │  Paper   │  │  iMessage │                 │
│ │  Trader  │  │  Alerts   │                 │
│ └────┬─────┘  └───────────┘                 │
│      │                                      │
│      ▼                                      │
│ ┌──────────────────────┐                    │
│ │   Live Dashboard     │                    │
│ │   Express + WS       │                    │
│ │   Port 3456          │                    │
│ └──────────────────────┘                    │
└─────────────────────────────────────────────┘
```

## Quick Start

```bash
npm install
node src/live.js
```

Dashboard opens at **http://localhost:3456**

## Modes

| File | Description |
|------|-------------|
| `src/live.js` | **Full system** — WebSocket + paper trading + dashboard |
| `src/ws-bot.js` | WebSocket bot only (no dashboard) |
| `src/index.js` | Original polling bot |
| `src/scanner.js` | One-shot market scanner |

## Features

### Real-Time Prices
- **Polymarket:** WebSocket connection for instant price updates
- **Kalshi:** REST API polling every 5 seconds
- Auto-reconnect on disconnection

### Smart Market Matching
- Fuzzy name matching across platforms
- Auto-discovers matching markets
- Filters by liquidity and volume

### Paper Trading
- Simulated $1,000 balance per platform
- Tracks every entry/exit with timestamps
- Running P&L, win rate, trade history
- Portfolio persists across restarts (saved to `data/`)

### Live Dashboard
- Real-time prices and spreads
- Open positions with hold time
- Complete trade log with P&L
- Portfolio stats (value, P&L, win rate)
- WebSocket + HTTP polling fallback

### Alerts
- iMessage alerts when spreads exceed threshold
- Cooldown system to prevent spam
- Configurable threshold (default: 2¢)

## Configuration

Edit `config.js`:

```js
{
  polymarketUrl: 'https://polymarket.com/event/...',
  kalshiUrl: 'https://kalshi.com/markets/...',
  minProfitCents: 0.3,    // Minimum spread to trade
  dryRun: true,            // Paper trading mode
  topNOpportunities: 10,
}
```

## Deployment (Fly.io)

```bash
fly launch
fly deploy
```

Free tier ($5/mo credit) — Virginia region for low latency to exchanges.

## Project Structure

```
src/
  live.js           # Main entry — ties everything together
  ws-bot.js         # WebSocket-only bot
  bot.js            # Original polling bot
  paper-trader.js   # Paper trading engine
  market-scanner.js # Multi-market discovery
  dashboard.js      # Express + WebSocket server
  alerts.js         # iMessage alert system
  arbitrage.js      # Spread calculation
  matcher.js        # Fuzzy matching
  scanner.js        # One-shot scanner
  history.js        # Opportunity tracking
public/
  index.html        # Dashboard frontend
data/               # Paper trading state (gitignored)
```

## Built by Molt 🎯

Personal AI assistant's overnight project.
