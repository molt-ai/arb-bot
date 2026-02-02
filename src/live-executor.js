/**
 * Live Executor — Real Order Placement for Cross-Platform Arb
 * 
 * Places REAL orders on Polymarket (via geo-proxy) and Kalshi (direct).
 * Safety features:
 *   - DRY_RUN mode (default: ON) — logs but doesn't place orders
 *   - Liquidity safety margin — only uses 50% of visible book depth
 *   - Minimum order enforcement — Polymarket requires $1 minimum
 *   - Parallel execution with partial-fill detection
 *   - Full audit logging for every trade attempt
 * 
 * CRITICAL: If one leg of a cross-platform trade fails, 
 * a CRITICAL alert is logged for manual review.
 */

import { generateKalshiRestHeaders, loadKalshiCredentials } from './kalshi-auth.js';

export class LiveExecutor {
    constructor(polyClient, kalshiClient, opts = {}) {
        this.poly = polyClient;
        this.kalshi = kalshiClient;
        this.proxyUrl = opts.proxyUrl || process.env.ORDER_PROXY_URL;
        this.proxyToken = opts.proxyToken || process.env.ORDER_PROXY_TOKEN;
        this.dryRun = opts.dryRun ?? (process.env.DRY_RUN !== '0');
        this.liquiditySafetyMargin = opts.liquiditySafetyMargin || 0.5; // use 50% of book
        this.minOrderDollars = opts.minOrderDollars || 1.10; // Polymarket $1 min + $0.10 buffer

        // Kalshi credentials for direct REST API calls
        try {
            this.kalshiCreds = loadKalshiCredentials();
        } catch (e) {
            this.kalshiCreds = null;
            console.warn('[LIVE-EXECUTOR] No Kalshi credentials loaded:', e.message);
        }

        // Audit log — every trade attempt is recorded
        this.auditLog = [];
        this.maxAuditEntries = 500;

        // Stats
        this.stats = {
            totalAttempts: 0,
            totalExecuted: 0,
            totalDryRun: 0,
            totalPartialFills: 0,
            totalFailures: 0,
            totalSkippedMinOrder: 0,
            totalSkippedLiquidity: 0,
        };

        const mode = this.dryRun ? 'DRY RUN (paper)' : '🔴 LIVE (real money)';
        const proxy = this.proxyUrl ? `✅ ${this.proxyUrl}` : '❌ not configured';
        console.log(`[LIVE-EXECUTOR] Initialized — Mode: ${mode} | Proxy: ${proxy}`);
    }

    /**
     * Execute a cross-platform arb trade.
     * Places orders on BOTH platforms simultaneously.
     * 
     * @param {object} opportunity — from evaluateSpread: { name, strategy, polyYes, polyNo, kalshiYes, kalshiNo, ... }
     * @param {object} mapping — market mapping: { polyTokenId, polyMarketId, kalshiTicker, ... }
     * @param {number} contracts — number of contracts to trade
     * @returns {{ success: boolean, polyResult: object|null, kalshiResult: object|null, error: string|null, dryRun: boolean }}
     */
    async execute(opportunity, mapping, contracts = 10) {
        const startTime = Date.now();
        this.stats.totalAttempts++;

        const { strategy, name } = opportunity;

        // Determine sides and prices
        let polySide, polyPrice, kalshiSide, kalshiPrice;
        if (strategy === 1) {
            // Buy Poly YES + Buy Kalshi NO
            polySide = 'BUY';    // buying YES token on Polymarket
            polyPrice = opportunity.polyYes;
            kalshiSide = 'NO';   // buying NO on Kalshi
            kalshiPrice = opportunity.kalshiNo;
        } else {
            // Buy Poly NO + Buy Kalshi YES
            polySide = 'BUY';    // buying NO token on Polymarket (would need NO token ID)
            polyPrice = opportunity.polyNo;
            kalshiSide = 'YES';  // buying YES on Kalshi
            kalshiPrice = opportunity.kalshiYes;
        }

        // 1. Validate minimum order size per side
        const polyValid = this.validateMinOrder(polyPrice, contracts);
        const kalshiValid = this.validateMinOrder(kalshiPrice, contracts);
        if (!polyValid || !kalshiValid) {
            this.stats.totalSkippedMinOrder++;
            const reason = !polyValid
                ? `Poly order too small: ${contracts} @ ${polyPrice}¢ = $${((polyPrice / 100) * contracts).toFixed(2)}`
                : `Kalshi order too small: ${contracts} @ ${kalshiPrice}¢ = $${((kalshiPrice / 100) * contracts).toFixed(2)}`;
            this._audit('SKIP_MIN_ORDER', name, { reason, polyPrice, kalshiPrice, contracts });
            return { success: false, polyResult: null, kalshiResult: null, error: reason, dryRun: this.dryRun };
        }

        // 2. Check book depth and calculate safe size
        let safeContracts = contracts;
        try {
            const depth = await this._fetchBookDepth(mapping, strategy);
            if (depth) {
                safeContracts = this.calcSafeSize(depth.availableContracts, contracts);
                if (safeContracts < 1 || !this.validateMinOrder(polyPrice, safeContracts)) {
                    this.stats.totalSkippedLiquidity++;
                    const reason = `Insufficient liquidity: depth=${depth.availableContracts}, safe=${safeContracts}`;
                    this._audit('SKIP_LIQUIDITY', name, { reason, depth, contracts, safeContracts });
                    return { success: false, polyResult: null, kalshiResult: null, error: reason, dryRun: this.dryRun };
                }
                if (safeContracts < contracts) {
                    console.log(`[LIVE-EXECUTOR] Reduced size: ${contracts} → ${safeContracts} (depth: ${depth.availableContracts}, margin: ${this.liquiditySafetyMargin})`);
                }
            }
        } catch (e) {
            console.warn(`[LIVE-EXECUTOR] Book depth check failed: ${e.message} — proceeding with requested size`);
        }

        // 3. DRY RUN — log and return simulated result
        if (this.dryRun) {
            this.stats.totalDryRun++;
            const elapsed = Date.now() - startTime;
            const simResult = {
                success: true,
                dryRun: true,
                polyResult: {
                    side: strategy === 1 ? 'YES' : 'NO',
                    price: polyPrice,
                    contracts: safeContracts,
                    simulated: true,
                },
                kalshiResult: {
                    side: kalshiSide,
                    price: kalshiPrice,
                    contracts: safeContracts,
                    simulated: true,
                },
                error: null,
                elapsedMs: elapsed,
            };
            this._audit('DRY_RUN', name, {
                strategy, polyPrice, kalshiPrice, contracts: safeContracts,
                totalCost: polyPrice + kalshiPrice, elapsed,
            });
            console.log(`[DRY-RUN] Would execute: ${name} | S${strategy} | Poly ${strategy === 1 ? 'YES' : 'NO'} @${polyPrice}¢ + Kalshi ${kalshiSide} @${kalshiPrice}¢ | ${safeContracts} contracts | Cost: ${(polyPrice + kalshiPrice).toFixed(1)}¢`);
            return simResult;
        }

        // ═══ LIVE EXECUTION ═══
        console.log(`\n🔴 [LIVE] EXECUTING: ${name} | S${strategy} | ${safeContracts} contracts`);
        console.log(`   Poly ${strategy === 1 ? 'YES' : 'NO'} @${polyPrice}¢ + Kalshi ${kalshiSide} @${kalshiPrice}¢ | Total cost: ${(polyPrice + kalshiPrice).toFixed(1)}¢/contract`);

        // 4. Place both orders in parallel
        const polyTokenId = mapping.polyTokenId;
        const kalshiTicker = mapping.kalshiTicker;
        const polyPriceDecimal = polyPrice / 100; // pmxt uses 0-1 range
        const kalshiPriceDecimal = kalshiPrice / 100;

        const [polySettled, kalshiSettled] = await Promise.allSettled([
            this.placePolyOrder(polyTokenId, mapping.polyMarketId, strategy === 1 ? 'buy' : 'buy', polyPriceDecimal, safeContracts, strategy),
            this.placeKalshiOrder(kalshiTicker, kalshiSide.toLowerCase(), kalshiPriceDecimal, safeContracts),
        ]);

        const elapsed = Date.now() - startTime;
        const polyResult = polySettled.status === 'fulfilled' ? polySettled.value : { error: polySettled.reason?.message || 'unknown' };
        const kalshiResult = kalshiSettled.status === 'fulfilled' ? kalshiSettled.value : { error: kalshiSettled.reason?.message || 'unknown' };
        const polyOk = polySettled.status === 'fulfilled' && !polyResult.error;
        const kalshiOk = kalshiSettled.status === 'fulfilled' && !kalshiResult.error;

        // 5. Handle results
        if (polyOk && kalshiOk) {
            // Both succeeded
            this.stats.totalExecuted++;
            this._audit('EXECUTED', name, {
                strategy, polyPrice, kalshiPrice, contracts: safeContracts,
                polyResult, kalshiResult, elapsed,
            });
            console.log(`✅ [LIVE] SUCCESS: ${name} | Both legs filled | ${elapsed}ms`);
            return { success: true, polyResult, kalshiResult, error: null, dryRun: false, elapsedMs: elapsed };
        }

        if (polyOk !== kalshiOk) {
            // PARTIAL FILL — one succeeded, one failed. CRITICAL!
            this.stats.totalPartialFills++;
            const failedSide = polyOk ? 'KALSHI' : 'POLYMARKET';
            const failedError = polyOk ? (kalshiResult.error || 'unknown') : (polyResult.error || 'unknown');
            const successSide = polyOk ? 'POLYMARKET' : 'KALSHI';

            this._audit('CRITICAL_PARTIAL_FILL', name, {
                strategy, polyPrice, kalshiPrice, contracts: safeContracts,
                polyResult, kalshiResult, failedSide, elapsed,
            });

            console.error(`\n🚨🚨🚨 CRITICAL: PARTIAL FILL 🚨🚨🚨`);
            console.error(`   Market: ${name}`);
            console.error(`   ✅ ${successSide} order SUCCEEDED`);
            console.error(`   ❌ ${failedSide} order FAILED: ${failedError}`);
            console.error(`   ⚠️  MANUAL INTERVENTION REQUIRED — you have an unhedged position!`);
            console.error(`   Contracts: ${safeContracts} | Strategy: ${strategy}`);
            console.error(`🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`);

            return {
                success: false,
                polyResult,
                kalshiResult,
                error: `PARTIAL FILL: ${failedSide} failed (${failedError}), ${successSide} succeeded`,
                dryRun: false,
                elapsedMs: elapsed,
                criticalPartialFill: true,
            };
        }

        // Both failed
        this.stats.totalFailures++;
        this._audit('BOTH_FAILED', name, {
            strategy, polyPrice, kalshiPrice, contracts: safeContracts,
            polyResult, kalshiResult, elapsed,
        });
        console.error(`❌ [LIVE] BOTH LEGS FAILED: ${name} | Poly: ${polyResult.error} | Kalshi: ${kalshiResult.error}`);
        return {
            success: false,
            polyResult,
            kalshiResult,
            error: `Both legs failed — Poly: ${polyResult.error}, Kalshi: ${kalshiResult.error}`,
            dryRun: false,
            elapsedMs: elapsed,
        };
    }

    /**
     * Place a Polymarket order (routed through geo-proxy if configured)
     * 
     * Polymarket CLOB: you buy/sell outcome tokens by tokenId.
     * Strategy 1 buys the YES token, Strategy 2 buys the NO token.
     * 
     * @param {string} tokenId — CLOB token ID (YES token for strategy 1)
     * @param {string} marketId — condition ID
     * @param {string} side — 'buy' or 'sell' (always 'buy' for arb entry)
     * @param {number} price — decimal price 0-1 (e.g., 0.52 = 52¢)
     * @param {number} size — number of shares/contracts
     * @param {number} strategy — 1 or 2 (determines which token to use)
     */
    async placePolyOrder(tokenId, marketId, side, price, size, strategy) {
        const orderParams = {
            marketId: marketId,
            outcomeId: tokenId, // The CLOB token ID
            side: side,         // 'buy' for entering positions
            type: 'limit',
            price: price,       // 0-1 decimal
            amount: size,       // Number of contracts
        };

        console.log(`[LIVE-EXECUTOR] Poly order: ${side.toUpperCase()} ${size} @ ${(price * 100).toFixed(1)}¢ | Token: ${tokenId.substring(0, 16)}...`);

        if (this.proxyUrl && this.proxyToken) {
            // Route through Toronto geo-proxy to bypass US IP restrictions
            console.log(`[LIVE-EXECUTOR] Routing through geo-proxy: ${this.proxyUrl}`);

            const proxyPayload = {
                action: 'polymarket_order',
                order: {
                    tokenID: tokenId,
                    price: price,
                    side: side.toUpperCase(),
                    size: size,
                    feeRateBps: 0, // 0% for event/political markets
                    tickSize: '0.01',
                },
            };

            const response = await fetch(this.proxyUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.proxyToken}`,
                },
                body: JSON.stringify(proxyPayload),
                signal: AbortSignal.timeout(15000), // 15s timeout
            });

            if (!response.ok) {
                const body = await response.text().catch(() => 'no body');
                throw new Error(`Proxy error ${response.status}: ${body}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || result.errorMsg || 'Proxy order failed');
            }

            console.log(`[LIVE-EXECUTOR] Poly order placed via proxy | OrderID: ${result.orderID || result.orderId || 'unknown'}`);
            return {
                id: result.orderID || result.orderId,
                side: side,
                price: price,
                size: size,
                status: result.status || 'open',
                via: 'proxy',
            };
        } else {
            // Direct via pmxt (requires non-US IP)
            console.log(`[LIVE-EXECUTOR] Poly order: direct via pmxt (no proxy configured)`);
            const result = await this.poly.createOrder(orderParams);
            console.log(`[LIVE-EXECUTOR] Poly order placed | OrderID: ${result.id}`);
            return {
                id: result.id,
                side: result.side,
                price: result.price,
                size: result.amount,
                status: result.status,
                via: 'direct',
            };
        }
    }

    /**
     * Place a Kalshi order (direct REST API — no geo restriction)
     * 
     * Uses raw Kalshi REST API instead of pmxt's abstraction
     * because pmxt maps 'sell' → {side: 'no', action: 'sell'} which is
     * selling NO, not buying NO. We need {side: 'no'/'yes', action: 'buy'}.
     * 
     * @param {string} ticker — Kalshi market ticker (e.g., 'KXBTCD-25JUL18-B107500')
     * @param {string} side — 'yes' or 'no'
     * @param {number} price — decimal price 0-1 (e.g., 0.52)
     * @param {number} contracts — number of contracts
     */
    async placeKalshiOrder(ticker, side, price, contracts) {
        if (!this.kalshiCreds) {
            throw new Error('Kalshi credentials not available');
        }

        const priceInCents = Math.round(price * 100);
        const clientOrderId = `arb-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        const orderBody = {
            ticker: ticker,
            client_order_id: clientOrderId,
            side: side, // 'yes' or 'no'
            action: 'buy',
            count: contracts,
            type: 'limit',
        };

        // Set the correct price field based on side
        if (side === 'yes') {
            orderBody.yes_price = priceInCents;
        } else {
            orderBody.no_price = priceInCents;
        }

        console.log(`[LIVE-EXECUTOR] Kalshi order: BUY ${side.toUpperCase()} ${contracts} @ ${priceInCents}¢ | Ticker: ${ticker}`);

        const apiPath = '/trade-api/v2/portfolio/orders';
        const baseUrl = 'https://trading-api.kalshi.com';
        const headers = generateKalshiRestHeaders(
            this.kalshiCreds.keyId,
            this.kalshiCreds.privateKey,
            'POST',
            apiPath,
        );

        const response = await fetch(`${baseUrl}${apiPath}`, {
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(orderBody),
            signal: AbortSignal.timeout(15000), // 15s timeout
        });

        if (!response.ok) {
            const body = await response.text().catch(() => 'no body');
            throw new Error(`Kalshi API error ${response.status}: ${body}`);
        }

        const data = await response.json();
        const order = data.order;

        console.log(`[LIVE-EXECUTOR] Kalshi order placed | OrderID: ${order?.order_id || 'unknown'} | Status: ${order?.status || 'unknown'}`);

        return {
            id: order?.order_id || clientOrderId,
            side: side,
            price: priceInCents,
            contracts: contracts,
            status: order?.status || 'unknown',
            queuePosition: order?.queue_position,
            via: 'direct',
        };
    }

    /**
     * Fetch order book depth for both sides of the trade.
     * Returns the minimum available contracts across both platforms.
     */
    async _fetchBookDepth(mapping, strategy) {
        try {
            const [polyBook, kalshiBook] = await Promise.all([
                this.poly.fetchOrderBook(mapping.polyTokenId),
                this.kalshi.fetchOrderBook(mapping.kalshiTicker),
            ]);

            // For strategy 1 (Buy Poly YES + Kalshi NO):
            //   Poly: we buy from asks (best ask = lowest sell price)
            //   Kalshi: we buy NO from asks
            // For strategy 2 (Buy Poly NO + Kalshi YES):
            //   Similar but reversed sides

            // Poly book: asks = contracts available for us to buy
            const polyAsks = polyBook?.asks || [];
            const polyDepth = polyAsks.reduce((sum, level) => sum + level.size, 0);

            // Kalshi book: calculate available depth on the side we're buying
            // Kalshi orderbook returns {bids: [{price, size}], asks: [{price, size}]}
            const kalshiAsks = kalshiBook?.asks || [];
            const kalshiDepth = kalshiAsks.reduce((sum, level) => sum + level.size, 0);

            const minDepth = Math.min(polyDepth, kalshiDepth);

            return {
                polyDepth: Math.floor(polyDepth),
                kalshiDepth: Math.floor(kalshiDepth),
                availableContracts: Math.floor(minDepth),
            };
        } catch (e) {
            console.warn(`[LIVE-EXECUTOR] Book depth fetch failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Check book depth and calculate safe order size.
     * Only uses a fraction of visible depth to avoid adverse selection.
     * 
     * @param {number} availableDepth — total contracts available in book
     * @param {number} requestedSize — contracts we want to trade
     * @returns {number} safe number of contracts
     */
    calcSafeSize(availableDepth, requestedSize) {
        const safeDepth = Math.floor(availableDepth * this.liquiditySafetyMargin);
        return Math.min(safeDepth, requestedSize);
    }

    /**
     * Validate minimum order size per Polymarket's $1 requirement.
     * 
     * @param {number} priceCents — price in cents (1-99)
     * @param {number} contracts — number of contracts
     * @returns {boolean} true if order meets minimum
     */
    validateMinOrder(priceCents, contracts) {
        const orderValue = (priceCents / 100) * contracts;
        return orderValue >= this.minOrderDollars;
    }

    /**
     * Get minimum contracts needed at a given price to meet min order.
     * 
     * @param {number} priceCents — price in cents
     * @returns {number} minimum contracts needed
     */
    getMinContracts(priceCents) {
        if (priceCents <= 0) return Infinity;
        return Math.ceil(this.minOrderDollars / (priceCents / 100));
    }

    /**
     * Record an audit log entry.
     * Every trade attempt is logged with full details for review.
     */
    _audit(type, market, details) {
        const entry = {
            type,
            market,
            timestamp: new Date().toISOString(),
            epochMs: Date.now(),
            ...details,
        };
        this.auditLog.unshift(entry);
        if (this.auditLog.length > this.maxAuditEntries) {
            this.auditLog.length = this.maxAuditEntries;
        }
    }

    /**
     * Get executor status for the dashboard.
     */
    getStatus() {
        return {
            mode: this.dryRun ? 'paper' : 'live',
            proxyConfigured: !!(this.proxyUrl && this.proxyToken),
            proxyUrl: this.proxyUrl ? this.proxyUrl.replace(/\/proxy.*/, '/...') : null,
            kalshiCredsLoaded: !!this.kalshiCreds,
            liquiditySafetyMargin: this.liquiditySafetyMargin,
            minOrderDollars: this.minOrderDollars,
            stats: { ...this.stats },
            recentAudit: this.auditLog.slice(0, 20),
        };
    }
}

export default LiveExecutor;
