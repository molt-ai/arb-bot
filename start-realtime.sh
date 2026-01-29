#!/bin/bash
# Start the real-time WebSocket-based arbitrage bot

cd "$(dirname "$0")"

# Load environment
source .env 2>/dev/null || true

echo "🚀 Starting Real-Time Arb Bot..."
echo "   Press Ctrl+C to stop"
echo ""

node src/ws-bot.js
