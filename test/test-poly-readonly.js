#!/usr/bin/env node
/**
 * Polymarket Read-Only Connection Test
 * 
 * Verifies that we can reach Polymarket's APIs without trading:
 *   1. Gamma API (market data — no auth needed)
 *   2. CLOB API (order book — no auth needed for reads)
 *   3. WebSocket connectivity test
 * 
 * Usage: node test/test-poly-readonly.js
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function testPolymarket() {
    console.log('═══════════════════════════════════════');
    console.log('  Polymarket Read-Only Connection Test');
    console.log('═══════════════════════════════════════\n');

    // 1. Gamma API — fetch an event
    console.log('── Test 1: Gamma API (market data) ──');
    try {
        const url = `${GAMMA_API}/events?limit=3&active=true&closed=false`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
            const events = await response.json();
            console.log(`✅ Gamma API reachable (${events.length} events returned)`);
            for (const evt of events.slice(0, 3)) {
                const markets = evt.markets || [];
                const firstMarket = markets[0];
                const bestBid = firstMarket?.bestBid || '?';
                console.log(`   • ${evt.title || evt.slug} (${markets.length} markets, bestBid: ${bestBid})`);
            }
        } else {
            console.error(`❌ Gamma API error: HTTP ${response.status}`);
        }
    } catch (e) {
        console.error(`❌ Gamma API unreachable: ${e.message}`);
    }

    // 2. CLOB API — fetch order book for a known market
    console.log('\n── Test 2: CLOB API (order book) ──');
    try {
        // First, get a token ID from Gamma
        const gammaResp = await fetch(`${GAMMA_API}/markets?limit=1&active=true&closed=false`, {
            signal: AbortSignal.timeout(10000),
        });
        
        if (gammaResp.ok) {
            const markets = await gammaResp.json();
            if (markets.length > 0 && markets[0].clobTokenIds) {
                const tokenIds = JSON.parse(markets[0].clobTokenIds);
                const tokenId = tokenIds[0];
                console.log(`   Using token: ${tokenId?.substring(0, 30)}...`);

                // Fetch the CLOB order book
                const bookUrl = `${CLOB_API}/book?token_id=${tokenId}`;
                const bookResp = await fetch(bookUrl, {
                    signal: AbortSignal.timeout(10000),
                });

                if (bookResp.ok) {
                    const book = await bookResp.json();
                    const bids = book.bids?.length || 0;
                    const asks = book.asks?.length || 0;
                    console.log(`✅ CLOB API reachable | Book: ${bids} bids, ${asks} asks`);
                    
                    if (book.bids?.length > 0) {
                        const bestBid = book.bids[0];
                        console.log(`   Best bid: ${bestBid.price} × ${bestBid.size}`);
                    }
                    if (book.asks?.length > 0) {
                        const bestAsk = book.asks[0];
                        console.log(`   Best ask: ${bestAsk.price} × ${bestAsk.size}`);
                    }
                } else {
                    const body = await bookResp.text().catch(() => '');
                    console.error(`❌ CLOB order book error: HTTP ${bookResp.status}`);
                    console.error(`   ${body.substring(0, 200)}`);
                    if (bookResp.status === 403) {
                        console.error('   → Your IP may be geo-blocked (US restriction)');
                        console.error('   → Order book reads may still work; only order placement is blocked');
                    }
                }
            } else {
                console.log('⚠️  No active markets with CLOB token IDs found');
            }
        } else {
            console.error(`❌ Could not fetch market for CLOB test`);
        }
    } catch (e) {
        console.error(`❌ CLOB API error: ${e.message}`);
    }

    // 3. Check if pmxtjs Polymarket client works
    console.log('\n── Test 3: pmxtjs Polymarket client ──');
    try {
        const pmxt = (await import('pmxtjs')).default;
        const poly = new pmxt.polymarket({});
        
        // Try fetching markets via pmxt
        const markets = await poly.getMarkets({ limit: 2 });
        if (markets && markets.length > 0) {
            console.log(`✅ pmxtjs Polymarket client works (${markets.length} markets)`);
            for (const m of markets.slice(0, 2)) {
                console.log(`   • ${m.question || m.title || m.id} | Vol: ${m.volume || '?'}`);
            }
        } else {
            console.log('⚠️  pmxtjs returned empty (may need different method)');
        }
    } catch (e) {
        console.error(`❌ pmxtjs Polymarket client error: ${e.message}`);
        console.log('   This is OK if pmxtjs needs a private key for initialization');
    }

    // 4. Environment check
    console.log('\n── Test 4: Environment Check ──');
    const hasKey = !!process.env.POLYMARKET_PRIVATE_KEY;
    const hasProxy = !!process.env.ORDER_PROXY_URL;
    const hasProxyToken = !!process.env.ORDER_PROXY_TOKEN;
    
    console.log(`   POLYMARKET_PRIVATE_KEY: ${hasKey ? '✅ Set' : '❌ Not set'}`);
    console.log(`   ORDER_PROXY_URL:        ${hasProxy ? '✅ ' + process.env.ORDER_PROXY_URL : '❌ Not set'}`);
    console.log(`   ORDER_PROXY_TOKEN:      ${hasProxyToken ? '✅ Set' : '❌ Not set'}`);
    
    if (!hasKey) {
        console.log('\n   ⚠️  You need POLYMARKET_PRIVATE_KEY to place orders.');
        console.log('   See GOLIVE.md Section 2a for how to get one.');
    }
    if (!hasProxy) {
        console.log('\n   ⚠️  No geo-proxy configured. Orders from US IPs will be blocked.');
        console.log('   See GOLIVE.md Section 2b for setup instructions.');
    }

    console.log('\n═══════════════════════════════════════');
    console.log('  Test complete');
    console.log('═══════════════════════════════════════');
}

testPolymarket().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
