#!/bin/bash
# Arb Bot Daemon - runs continuously in background
cd "$(dirname "$0")"

LOG_FILE="arb-bot.log"

echo "Starting Arb Bot daemon..."
echo "Logging to: $LOG_FILE"
echo "PID file: arb-bot.pid"

# Kill existing if running
if [ -f arb-bot.pid ]; then
    kill $(cat arb-bot.pid) 2>/dev/null
    rm arb-bot.pid
fi

# Start in background
nohup node src/index.js >> "$LOG_FILE" 2>&1 &
echo $! > arb-bot.pid

echo "Bot started with PID: $(cat arb-bot.pid)"
echo "View logs: tail -f $LOG_FILE"
echo "Stop: kill \$(cat arb-bot.pid)"
