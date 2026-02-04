#!/usr/bin/env node
/**
 * Kalshi Authentication Test
 * 
 * Verifies that .kalshi-key.pem is valid by making authenticated
 * API calls to the Kalshi trading API.
 * 
 * Usage: node test/test-kalshi-auth.js
 */

import { loadKalshiCredentials, generateKalshiRestHeaders } from '../src/kalshi-auth.js';

const KALSHI_BASE = 'https://api.elections.kalshi.com';

async function testAuth() {
    console.log('═══════════════════════════════════════');
    console.log('  Kalshi Authentication Test');
    console.log('═══════════════════════════════════════\n');

    // 1. Load credentials
    let creds;
    try {
        creds = loadKalshiCredentials();
        console.log('✅ Credentials loaded');
        console.log(`   Key ID: ${creds.keyId}`);
        console.log(`   Private key: ${creds.privateKey.substring(0, 40)}...`);
    } catch (e) {
        console.error('❌ Failed to load credentials:', e.message);
        console.error('   Make sure .kalshi-key.pem exists in the project root');
        console.error('   Or set KALSHI_PRIVATE_KEY and KALSHI_API_KEY env vars');
        process.exit(1);
    }

    // 2. Test: Get account balance
    console.log('\n── Test 1: Get Account Balance ──');
    try {
        const path = '/trade-api/v2/portfolio/balance';
        const headers = generateKalshiRestHeaders(creds.keyId, creds.privateKey, 'GET', path);
        
        const response = await fetch(`${KALSHI_BASE}${path}`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
            const data = await response.json();
            console.log('✅ Balance request succeeded');
            console.log(`   Available balance: $${((data.balance || 0) / 100).toFixed(2)}`);
            console.log(`   Portfolio value:   $${((data.portfolio_value || 0) / 100).toFixed(2)}`);
            if (data.balance !== undefined) {
                console.log(`   Raw response:`, JSON.stringify(data, null, 2));
            }
        } else {
            const body = await response.text().catch(() => 'no body');
            console.error(`❌ Balance request failed: HTTP ${response.status}`);
            console.error(`   Response: ${body}`);
            if (response.status === 401) {
                console.error('   → API key may be invalid or expired');
                console.error('   → Regenerate at: https://kalshi.com/account/api-keys');
            }
        }
    } catch (e) {
        console.error(`❌ Balance request error: ${e.message}`);
    }

    // 3. Test: List a few markets (public endpoint but with auth)
    console.log('\n── Test 2: List Markets (first 3) ──');
    try {
        const path = '/trade-api/v2/markets';
        const queryPath = `${path}?limit=3&status=open`;
        const headers = generateKalshiRestHeaders(creds.keyId, creds.privateKey, 'GET', path);

        const response = await fetch(`${KALSHI_BASE}${queryPath}`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
            const data = await response.json();
            const markets = data.markets || [];
            console.log(`✅ Markets request succeeded (${markets.length} returned)`);
            for (const m of markets) {
                const yes = m.yes_bid != null ? `${m.yes_bid}¢` : '?';
                const no = m.no_bid != null ? `${m.no_bid}¢` : '?';
                console.log(`   • ${m.ticker}: ${m.title || m.subtitle || 'untitled'} | YES: ${yes} NO: ${no}`);
            }
        } else {
            const body = await response.text().catch(() => 'no body');
            console.error(`❌ Markets request failed: HTTP ${response.status}`);
            console.error(`   Response: ${body}`);
        }
    } catch (e) {
        console.error(`❌ Markets request error: ${e.message}`);
    }

    // 4. Test: Get open orders (should be empty)
    console.log('\n── Test 3: Get Open Orders ──');
    try {
        const path = '/trade-api/v2/portfolio/orders';
        const queryPath = `${path}?status=resting&limit=5`;
        const headers = generateKalshiRestHeaders(creds.keyId, creds.privateKey, 'GET', path);

        const response = await fetch(`${KALSHI_BASE}${queryPath}`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
            const data = await response.json();
            const orders = data.orders || [];
            console.log(`✅ Orders request succeeded (${orders.length} open orders)`);
            if (orders.length === 0) {
                console.log('   No open orders (expected for a fresh account)');
            }
            for (const o of orders) {
                console.log(`   • ${o.ticker} ${o.side} ${o.action} ${o.remaining_count} @ ${o.yes_price || o.no_price}¢`);
            }
        } else {
            const body = await response.text().catch(() => 'no body');
            console.error(`❌ Orders request failed: HTTP ${response.status}`);
            console.error(`   Response: ${body}`);
        }
    } catch (e) {
        console.error(`❌ Orders request error: ${e.message}`);
    }

    console.log('\n═══════════════════════════════════════');
    console.log('  Test complete');
    console.log('═══════════════════════════════════════');
}

testAuth().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
