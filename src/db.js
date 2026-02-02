/**
 * SQLite Database Layer
 * Uses better-sqlite3 for synchronous, simple persistence.
 * Falls back gracefully if SQLite can't initialize.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'arb-bot.db');

let db = null;

function getDb() {
    if (db) return db;

    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    try {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        initTables();
        console.log('[DB] SQLite initialized at', DB_PATH);
        return db;
    } catch (e) {
        console.error('[DB] Failed to initialize SQLite:', e.message);
        return null;
    }
}

function initTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            strategy INTEGER,
            poly_side TEXT,
            kalshi_side TEXT,
            poly_price REAL,
            kalshi_price REAL,
            contracts INTEGER,
            total_cost REAL,
            gross_spread REAL,
            fees REAL,
            expected_net_profit REAL,
            actual_net_pnl REAL,
            expires_at TEXT,
            entry_time TEXT,
            exit_time TEXT,
            hold_time_ms INTEGER,
            payout REAL,
            timestamp TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS portfolio_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS near_misses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            poly_yes REAL,
            poly_no REAL,
            kalshi_yes REAL,
            kalshi_no REAL,
            gross_spread REAL,
            fees REAL,
            net_profit REAL,
            reason TEXT,
            timestamp TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS daily_stats (
            date TEXT PRIMARY KEY,
            trades_entered INTEGER DEFAULT 0,
            trades_resolved INTEGER DEFAULT 0,
            gross_pnl REAL DEFAULT 0,
            net_pnl REAL DEFAULT 0,
            fees_paid REAL DEFAULT 0,
            opportunities_seen INTEGER DEFAULT 0,
            circuit_breaker_trips INTEGER DEFAULT 0
        );
    `);

    // Create indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
        CREATE INDEX IF NOT EXISTS idx_trades_name ON trades(name);
        CREATE INDEX IF NOT EXISTS idx_near_misses_timestamp ON near_misses(timestamp);
    `);
}

// ── Trade Functions ─────────────────────────────────────

/**
 * Insert a trade record. Handles both ENTRY and RESOLVE/EARLY_EXIT shapes.
 */
export function insertTrade(trade) {
    const d = getDb();
    if (!d) return false;

    try {
        const stmt = d.prepare(`
            INSERT OR REPLACE INTO trades
                (id, name, type, strategy, poly_side, kalshi_side,
                 poly_price, kalshi_price, contracts, total_cost,
                 gross_spread, fees, expected_net_profit, actual_net_pnl,
                 expires_at, entry_time, exit_time, hold_time_ms, payout, timestamp)
            VALUES
                (@id, @name, @type, @strategy, @poly_side, @kalshi_side,
                 @poly_price, @kalshi_price, @contracts, @total_cost,
                 @gross_spread, @fees, @expected_net_profit, @actual_net_pnl,
                 @expires_at, @entry_time, @exit_time, @hold_time_ms, @payout, @timestamp)
        `);

        stmt.run({
            id: trade.id,
            name: trade.name,
            type: trade.type,
            strategy: trade.strategy ?? null,
            poly_side: trade.polySide ?? null,
            kalshi_side: trade.kalshiSide ?? null,
            poly_price: trade.polyPrice ?? null,
            kalshi_price: trade.kalshiPrice ?? null,
            contracts: trade.contracts ?? null,
            total_cost: trade.totalCost ?? null,
            gross_spread: trade.grossSpread ?? null,
            fees: trade.fees ?? null,
            expected_net_profit: trade.expectedNetProfit ?? null,
            actual_net_pnl: trade.netPnl ?? trade.grossPnl ?? null,
            expires_at: trade.expiresAt ?? null,
            entry_time: trade.entryTime ?? null,
            exit_time: trade.exitTime ?? null,
            hold_time_ms: trade.holdTime ?? null,
            payout: trade.payout ?? null,
            timestamp: trade.timestamp,
        });
        return true;
    } catch (e) {
        console.error('[DB] insertTrade error:', e.message);
        return false;
    }
}

/**
 * Get all trades, ordered by timestamp descending.
 */
export function getTrades() {
    const d = getDb();
    if (!d) return null;

    try {
        return d.prepare('SELECT * FROM trades ORDER BY timestamp DESC').all();
    } catch (e) {
        console.error('[DB] getTrades error:', e.message);
        return null;
    }
}

/**
 * Get recent trades (last N).
 */
export function getRecentTrades(limit = 30) {
    const d = getDb();
    if (!d) return null;

    try {
        return d.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
    } catch (e) {
        console.error('[DB] getRecentTrades error:', e.message);
        return null;
    }
}

// ── Near-Miss Functions ─────────────────────────────────

export function insertNearMiss(miss) {
    const d = getDb();
    if (!d) return false;

    try {
        const stmt = d.prepare(`
            INSERT INTO near_misses
                (name, poly_yes, poly_no, kalshi_yes, kalshi_no,
                 gross_spread, fees, net_profit, reason, timestamp)
            VALUES
                (@name, @poly_yes, @poly_no, @kalshi_yes, @kalshi_no,
                 @gross_spread, @fees, @net_profit, @reason, @timestamp)
        `);

        stmt.run({
            name: miss.name,
            poly_yes: miss.polyYes ?? null,
            poly_no: miss.polyNo ?? null,
            kalshi_yes: miss.kalshiYes ?? null,
            kalshi_no: miss.kalshiNo ?? null,
            gross_spread: miss.grossSpread ?? null,
            fees: miss.fees ?? null,
            net_profit: miss.netProfit ?? null,
            reason: miss.reason ?? null,
            timestamp: miss.timestamp || new Date().toISOString(),
        });
        return true;
    } catch (e) {
        console.error('[DB] insertNearMiss error:', e.message);
        return false;
    }
}

export function getRecentNearMisses(limit = 50) {
    const d = getDb();
    if (!d) return null;

    try {
        return d.prepare('SELECT * FROM near_misses ORDER BY timestamp DESC LIMIT ?').all(limit);
    } catch (e) {
        console.error('[DB] getRecentNearMisses error:', e.message);
        return null;
    }
}

// ── Portfolio State Functions ────────────────────────────

export function getPortfolioState(key) {
    const d = getDb();
    if (!d) return null;

    try {
        const row = d.prepare('SELECT value FROM portfolio_state WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : null;
    } catch (e) {
        console.error('[DB] getPortfolioState error:', e.message);
        return null;
    }
}

export function setPortfolioState(key, value) {
    const d = getDb();
    if (!d) return false;

    try {
        d.prepare(`
            INSERT OR REPLACE INTO portfolio_state (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
        `).run(key, JSON.stringify(value));
        return true;
    } catch (e) {
        console.error('[DB] setPortfolioState error:', e.message);
        return false;
    }
}

export function getAllPortfolioState() {
    const d = getDb();
    if (!d) return null;

    try {
        const rows = d.prepare('SELECT key, value FROM portfolio_state').all();
        const state = {};
        for (const row of rows) {
            state[row.key] = JSON.parse(row.value);
        }
        return state;
    } catch (e) {
        console.error('[DB] getAllPortfolioState error:', e.message);
        return null;
    }
}

// ── Daily Stats Functions ───────────────────────────────

export function insertDailyStats(stats) {
    const d = getDb();
    if (!d) return false;

    try {
        d.prepare(`
            INSERT OR REPLACE INTO daily_stats
                (date, trades_entered, trades_resolved, gross_pnl, net_pnl,
                 fees_paid, opportunities_seen, circuit_breaker_trips)
            VALUES
                (@date, @trades_entered, @trades_resolved, @gross_pnl, @net_pnl,
                 @fees_paid, @opportunities_seen, @circuit_breaker_trips)
        `).run({
            date: stats.date,
            trades_entered: stats.tradesEntered ?? 0,
            trades_resolved: stats.tradesResolved ?? 0,
            gross_pnl: stats.grossPnl ?? 0,
            net_pnl: stats.netPnl ?? 0,
            fees_paid: stats.feesPaid ?? 0,
            opportunities_seen: stats.opportunitiesSeen ?? 0,
            circuit_breaker_trips: stats.circuitBreakerTrips ?? 0,
        });
        return true;
    } catch (e) {
        console.error('[DB] insertDailyStats error:', e.message);
        return false;
    }
}

export function getDailyStats(days = 30) {
    const d = getDb();
    if (!d) return null;

    try {
        return d.prepare(
            'SELECT * FROM daily_stats ORDER BY date DESC LIMIT ?'
        ).all(days);
    } catch (e) {
        console.error('[DB] getDailyStats error:', e.message);
        return null;
    }
}

// ── Migration: JSON → SQLite ────────────────────────────

export function migrateFromJson(tradesJsonPath) {
    const d = getDb();
    if (!d) return false;

    try {
        // Check if we already have trades in SQLite
        const count = d.prepare('SELECT COUNT(*) as cnt FROM trades').get();
        if (count.cnt > 0) {
            console.log('[DB] SQLite already has trades, skipping JSON migration');
            return true;
        }

        if (!fs.existsSync(tradesJsonPath)) {
            console.log('[DB] No trades.json to migrate');
            return true;
        }

        const trades = JSON.parse(fs.readFileSync(tradesJsonPath, 'utf8'));
        if (!Array.isArray(trades) || trades.length === 0) {
            console.log('[DB] trades.json is empty, nothing to migrate');
            return true;
        }

        console.log(`[DB] Migrating ${trades.length} trades from JSON to SQLite...`);

        const insertStmt = d.prepare(`
            INSERT OR IGNORE INTO trades
                (id, name, type, strategy, poly_side, kalshi_side,
                 poly_price, kalshi_price, contracts, total_cost,
                 gross_spread, fees, expected_net_profit, actual_net_pnl,
                 expires_at, entry_time, exit_time, hold_time_ms, payout, timestamp)
            VALUES
                (@id, @name, @type, @strategy, @poly_side, @kalshi_side,
                 @poly_price, @kalshi_price, @contracts, @total_cost,
                 @gross_spread, @fees, @expected_net_profit, @actual_net_pnl,
                 @expires_at, @entry_time, @exit_time, @hold_time_ms, @payout, @timestamp)
        `);

        const insertMany = d.transaction((trades) => {
            for (const t of trades) {
                insertStmt.run({
                    id: t.id,
                    name: t.name,
                    type: t.type,
                    strategy: t.strategy ?? null,
                    poly_side: t.polySide ?? null,
                    kalshi_side: t.kalshiSide ?? null,
                    poly_price: t.polyPrice ?? null,
                    kalshi_price: t.kalshiPrice ?? null,
                    contracts: t.contracts ?? null,
                    total_cost: t.totalCost ?? null,
                    gross_spread: t.grossSpread ?? null,
                    fees: t.fees ?? null,
                    expected_net_profit: t.expectedNetProfit ?? null,
                    actual_net_pnl: t.netPnl ?? t.grossPnl ?? null,
                    expires_at: t.expiresAt ?? null,
                    entry_time: t.entryTime ?? null,
                    exit_time: t.exitTime ?? null,
                    hold_time_ms: t.holdTime ?? null,
                    payout: t.payout ?? null,
                    timestamp: t.timestamp,
                });
            }
        });

        insertMany(trades);
        console.log(`[DB] ✅ Migrated ${trades.length} trades to SQLite`);
        return true;
    } catch (e) {
        console.error('[DB] Migration error:', e.message);
        return false;
    }
}

export default {
    insertTrade,
    getTrades,
    getRecentTrades,
    insertNearMiss,
    getRecentNearMisses,
    getPortfolioState,
    setPortfolioState,
    getAllPortfolioState,
    insertDailyStats,
    getDailyStats,
    migrateFromJson,
};
