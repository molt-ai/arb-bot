/**
 * Tests for BTC 15-Minute Same-Market Arbitrage (Gabagool Strategy)
 * 
 * Run: node tests/btc-15min-arb.test.js
 */

import { computeBuyFill, calcTakerFee, calcPairArb } from '../src/btc-15min-arb.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${message}`);
    } else {
        failed++;
        console.error(`  ❌ ${message}`);
    }
}

function assertClose(actual, expected, tolerance, message) {
    const ok = Math.abs(actual - expected) <= tolerance;
    if (ok) {
        passed++;
        console.log(`  ✅ ${message} (${actual.toFixed(6)} ≈ ${expected.toFixed(6)})`);
    } else {
        failed++;
        console.error(`  ❌ ${message} (got ${actual.toFixed(6)}, expected ${expected.toFixed(6)}, diff ${Math.abs(actual - expected).toFixed(6)} > tolerance ${tolerance})`);
    }
}

// ═══════════════════════════════════════════════════════════════
// TEST: computeBuyFill
// ═══════════════════════════════════════════════════════════════

console.log('\n📦 computeBuyFill tests:');

// Simple case: buy 10 shares from a single level
{
    const asks = [{ price: '0.48', size: '100' }];
    const result = computeBuyFill(asks, 10);
    assert(result !== null, 'Single level with enough liquidity returns result');
    assertClose(result.vwap, 0.48, 0.0001, 'VWAP matches single level price');
    assertClose(result.totalCost, 4.80, 0.01, 'Total cost = 10 × $0.48 = $4.80');
    assertClose(result.worstPrice, 0.48, 0.0001, 'Worst price is the only level');
    assertClose(result.bestPrice, 0.48, 0.0001, 'Best price is the only level');
    assert(result.filled === 10, 'Filled amount matches target');
}

// Multi-level fill: need to walk through multiple price levels
{
    const asks = [
        { price: '0.47', size: '5' },
        { price: '0.48', size: '5' },
        { price: '0.50', size: '10' },
    ];
    const result = computeBuyFill(asks, 10);
    assert(result !== null, 'Multi-level fill returns result');
    // 5 × 0.47 + 5 × 0.48 = 2.35 + 2.40 = 4.75
    assertClose(result.totalCost, 4.75, 0.01, 'Multi-level total cost correct');
    assertClose(result.vwap, 0.475, 0.001, 'VWAP = 4.75/10 = $0.475');
    assertClose(result.worstPrice, 0.48, 0.0001, 'Worst price is highest filled level');
    assertClose(result.bestPrice, 0.47, 0.0001, 'Best price is lowest level');
}

// Insufficient liquidity
{
    const asks = [{ price: '0.48', size: '5' }];
    const result = computeBuyFill(asks, 10);
    assert(result === null, 'Insufficient liquidity returns null');
}

// Empty asks
{
    const result = computeBuyFill([], 10);
    assert(result === null, 'Empty asks returns null');
}

// Null asks
{
    const result = computeBuyFill(null, 10);
    assert(result === null, 'Null asks returns null');
}

// Zero target size
{
    const asks = [{ price: '0.48', size: '100' }];
    const result = computeBuyFill(asks, 0);
    assert(result === null, 'Zero target size returns null');
}

// Unsorted asks (should still work — function sorts internally)
{
    const asks = [
        { price: '0.50', size: '10' },
        { price: '0.47', size: '5' },
        { price: '0.48', size: '5' },
    ];
    const result = computeBuyFill(asks, 10);
    assert(result !== null, 'Unsorted asks still work');
    assertClose(result.vwap, 0.475, 0.001, 'VWAP correct despite unsorted input');
}

// Numeric (non-string) prices
{
    const asks = [
        { price: 0.48, size: 100 },
    ];
    const result = computeBuyFill(asks, 10);
    assert(result !== null, 'Numeric prices work');
    assertClose(result.vwap, 0.48, 0.001, 'Numeric price VWAP correct');
}


// ═══════════════════════════════════════════════════════════════
// TEST: calcTakerFee
// ═══════════════════════════════════════════════════════════════

console.log('\n💸 calcTakerFee tests:');

// Fee at 50/50 (maximum fee point)
{
    const fee = calcTakerFee(0.50, 1);
    // 0.50 × 0.25 × (0.50 × 0.50)² = 0.50 × 0.25 × 0.0625 = 0.0078125
    assertClose(fee, 0.0078125, 0.0000001, 'Fee at p=0.50: $0.0078/share (0.78¢)');
}

// Fee at 48¢
{
    const fee = calcTakerFee(0.48, 1);
    // 0.48 × 0.25 × (0.48 × 0.52)² = 0.48 × 0.25 × 0.2496² = 0.48 × 0.25 × 0.06230016
    const expected = 0.48 * 0.25 * Math.pow(0.48 * 0.52, 2);
    assertClose(fee, expected, 0.0000001, `Fee at p=0.48: $${expected.toFixed(6)}/share`);
}

// Fee at 51¢
{
    const fee = calcTakerFee(0.51, 1);
    const expected = 0.51 * 0.25 * Math.pow(0.51 * 0.49, 2);
    assertClose(fee, expected, 0.0000001, `Fee at p=0.51: $${expected.toFixed(6)}/share`);
}

// Fee at extreme prices (should be very low)
{
    const fee95 = calcTakerFee(0.95, 1);
    assert(fee95 < 0.001, `Fee at p=0.95 is very low: $${fee95.toFixed(6)}`);

    const fee05 = calcTakerFee(0.05, 1);
    assert(fee05 < 0.001, `Fee at p=0.05 is very low: $${fee05.toFixed(6)}`);
}

// Fee at edge cases
{
    const fee0 = calcTakerFee(0, 1);
    assert(fee0 === 0, 'Fee at p=0 is $0');

    const fee1 = calcTakerFee(1, 1);
    assert(fee1 === 0, 'Fee at p=1 is $0');
}

// Fee scales with shares
{
    const fee1 = calcTakerFee(0.50, 1);
    const fee10 = calcTakerFee(0.50, 10);
    assertClose(fee10, fee1 * 10, 0.0000001, 'Fee scales linearly with shares');
}


// ═══════════════════════════════════════════════════════════════
// TEST: calcPairArb (the core arb math)
// ═══════════════════════════════════════════════════════════════

console.log('\n🎯 calcPairArb tests:');

// Example from strategy doc: UP=$0.48, DOWN=$0.51, total=$0.99
{
    const arb = calcPairArb(0.48, 0.51, 10);
    assertClose(arb.pairCost, 0.99, 0.0001, 'Pair cost: $0.48 + $0.51 = $0.99');
    assertClose(arb.grossProfit, 0.10, 0.01, 'Gross profit: 10 × ($1.00 - $0.99) = $0.10');
    
    // Fees: UP fee + DOWN fee per share × 10
    const upFee = calcTakerFee(0.48, 10);
    const downFee = calcTakerFee(0.51, 10);
    assertClose(arb.totalFees, upFee + downFee, 0.0001, `Total fees: $${(upFee + downFee).toFixed(4)}`);
    
    const netProfit = 0.10 - (upFee + downFee);
    assertClose(arb.netProfit, netProfit, 0.0001, `Net profit: $${netProfit.toFixed(4)} (gross $0.10 - fees $${(upFee+downFee).toFixed(4)})`);
    
    // With the formula-based fees (~1.5¢/pair), net profit should be negative at 99¢ total
    // Wait — 10 shares × 1¢ gross = $0.10 gross, fees ~$0.015 per share × 10 = $0.15... 
    // Actually: upFee per share ≈ 0.00748, downFee ≈ 0.00796, total ≈ 0.01544 per pair
    // For 10 pairs: gross=$0.10, fees=10×0.01544=$0.1544, net=−$0.054
    // So at 99¢ pair cost with formula fees, this is NOT profitable!
    console.log(`    [INFO] At $0.99 pair cost: gross=$${arb.grossProfit.toFixed(4)}, fees=$${arb.totalFees.toFixed(4)}, net=$${arb.netProfit.toFixed(4)}`);
    console.log(`    [INFO] isProfitable: ${arb.isProfitable} (expected: depends on fee model)`);
}

// More profitable scenario: UP=$0.46, DOWN=$0.50, total=$0.96
{
    const arb = calcPairArb(0.46, 0.50, 10);
    assertClose(arb.pairCost, 0.96, 0.0001, 'Pair cost: $0.46 + $0.50 = $0.96');
    assertClose(arb.grossProfit, 0.40, 0.01, 'Gross profit: 10 × $0.04 = $0.40');
    assert(arb.netProfit > 0, `Net profit positive at $0.96 pair cost: $${arb.netProfit.toFixed(4)}`);
    assert(arb.isProfitable, 'Profitable at $0.96 pair cost');
    console.log(`    [INFO] At $0.96 pair cost: gross=$${arb.grossProfit.toFixed(4)}, fees=$${arb.totalFees.toFixed(4)}, net=$${arb.netProfit.toFixed(4)}`);
}

// Very profitable: UP=$0.44, DOWN=$0.50, total=$0.94
{
    const arb = calcPairArb(0.44, 0.50, 10);
    assertClose(arb.pairCost, 0.94, 0.0001, 'Pair cost: $0.94');
    assert(arb.isProfitable, 'Profitable at $0.94 pair cost');
    console.log(`    [INFO] At $0.94 pair cost: gross=$${arb.grossProfit.toFixed(4)}, fees=$${arb.totalFees.toFixed(4)}, net=$${arb.netProfit.toFixed(4)}`);
}

// Barely profitable: find the breakeven point
{
    console.log('\n  📊 Breakeven analysis (fee formula based):');
    for (let pairCostCents = 99; pairCostCents >= 93; pairCostCents--) {
        // Roughly symmetric: both sides at pairCost/2
        const halfCost = pairCostCents / 200;  // in dollars
        const arb = calcPairArb(halfCost, halfCost, 10);
        const perPair = (arb.netProfit / 10 * 100).toFixed(2);
        const indicator = arb.isProfitable ? '✅' : '❌';
        console.log(`    ${indicator} Pair=$0.${pairCostCents} → gross=$${arb.grossProfit.toFixed(4)}, fees=$${arb.totalFees.toFixed(4)}, net=$${arb.netProfit.toFixed(4)} (${perPair}¢/pair)`);
    }
}

// Not profitable: UP=$0.50, DOWN=$0.50, total=$1.00
{
    const arb = calcPairArb(0.50, 0.50, 10);
    assertClose(arb.pairCost, 1.00, 0.0001, 'Pair cost at $1.00');
    assert(arb.grossProfit <= 0, 'No gross profit at $1.00');
    assert(!arb.isProfitable, 'Not profitable at $1.00');
}

// Asymmetric: UP=$0.30, DOWN=$0.65, total=$0.95
{
    const arb = calcPairArb(0.30, 0.65, 10);
    assertClose(arb.pairCost, 0.95, 0.0001, 'Asymmetric pair cost: $0.95');
    assert(arb.isProfitable, 'Profitable with asymmetric prices at $0.95');
    // Fees should be LOWER at asymmetric prices (fee formula penalizes 50/50 most)
    const symArb = calcPairArb(0.475, 0.475, 10);
    assert(arb.totalFees < symArb.totalFees, `Asymmetric fees ($${arb.totalFees.toFixed(4)}) < symmetric fees ($${symArb.totalFees.toFixed(4)})`);
}

// Large order size
{
    const arb = calcPairArb(0.47, 0.50, 100);
    assert(arb.netProfit > 0, `100-share arb profitable at $0.97: $${arb.netProfit.toFixed(4)}`);
    assertClose(arb.netProfit, calcPairArb(0.47, 0.50, 10).netProfit * 10, 0.001, 'Profit scales linearly with size');
}


// ═══════════════════════════════════════════════════════════════
// TEST: Integration — full walk-the-book + arb check
// ═══════════════════════════════════════════════════════════════

console.log('\n🔗 Integration test (simulated order book → arb check):');

{
    // Simulate real order book scenario
    const upAsks = [
        { price: '0.47', size: '20' },
        { price: '0.48', size: '50' },
        { price: '0.49', size: '100' },
    ];
    const downAsks = [
        { price: '0.49', size: '15' },
        { price: '0.50', size: '30' },
        { price: '0.51', size: '80' },
    ];

    const orderSize = 10;
    const upFill = computeBuyFill(upAsks, orderSize);
    const downFill = computeBuyFill(downAsks, orderSize);

    assert(upFill !== null, 'UP fill successful');
    assert(downFill !== null, 'DOWN fill successful');

    assertClose(upFill.vwap, 0.47, 0.001, 'UP VWAP at best level (enough liquidity at first level)');
    // 10 shares needed, first level has 15 → fills entirely at 0.49
    assertClose(downFill.vwap, 0.49, 0.001, 'DOWN VWAP at best level (first level has enough)');

    const arb = calcPairArb(upFill.vwap, downFill.vwap, orderSize);
    assertClose(arb.pairCost, 0.96, 0.01, 'Pair cost: $0.47 + $0.49 = $0.96');
    assert(arb.isProfitable, `Arb is profitable at $${arb.pairCost.toFixed(2)} pair cost`);
    console.log(`    Total profit for ${orderSize} pairs: $${arb.netProfit.toFixed(4)}`);
}

// Scenario where book needs walking through multiple levels
{
    const upAsks = [
        { price: '0.46', size: '3' },
        { price: '0.47', size: '4' },
        { price: '0.48', size: '3' },
    ];
    const downAsks = [
        { price: '0.50', size: '3' },
        { price: '0.51', size: '4' },
        { price: '0.52', size: '3' },
    ];

    const orderSize = 10;
    const upFill = computeBuyFill(upAsks, orderSize);
    const downFill = computeBuyFill(downAsks, orderSize);

    assert(upFill !== null, 'Multi-level UP fill successful');
    assert(downFill !== null, 'Multi-level DOWN fill successful');

    // UP: 3×0.46 + 4×0.47 + 3×0.48 = 1.38 + 1.88 + 1.44 = 4.70 → VWAP = 0.47
    assertClose(upFill.totalCost, 4.70, 0.01, 'UP total cost: $4.70');
    assertClose(upFill.vwap, 0.47, 0.001, 'UP VWAP: $0.47');
    assertClose(upFill.worstPrice, 0.48, 0.001, 'UP worst price: $0.48');

    // DOWN: 3×0.50 + 4×0.51 + 3×0.52 = 1.50 + 2.04 + 1.56 = 5.10 → VWAP = 0.51
    assertClose(downFill.totalCost, 5.10, 0.01, 'DOWN total cost: $5.10');
    assertClose(downFill.vwap, 0.51, 0.001, 'DOWN VWAP: $0.51');
    assertClose(downFill.worstPrice, 0.52, 0.001, 'DOWN worst price: $0.52');

    const arb = calcPairArb(upFill.vwap, downFill.vwap, orderSize);
    assertClose(arb.pairCost, 0.98, 0.01, 'Multi-level pair cost: $0.98');
    console.log(`    Multi-level arb: pair=$${arb.pairCost.toFixed(4)}, net=$${arb.netProfit.toFixed(4)}, profitable=${arb.isProfitable}`);
}


// ═══════════════════════════════════════════════════════════════
// TEST: Fee impact analysis
// ═══════════════════════════════════════════════════════════════

console.log('\n📈 Fee impact analysis:');

// Compare fee impact at different price points
{
    const scenarios = [
        { up: 0.50, down: 0.50, label: '50/50 (max fee)' },
        { up: 0.48, down: 0.48, label: '48/48 (slight asymmetry)' },
        { up: 0.40, down: 0.55, label: '40/55 (moderate asymmetry)' },
        { up: 0.30, down: 0.65, label: '30/65 (high asymmetry)' },
        { up: 0.20, down: 0.75, label: '20/75 (extreme asymmetry)' },
        { up: 0.10, down: 0.85, label: '10/85 (very extreme)' },
    ];

    for (const s of scenarios) {
        const upFee = calcTakerFee(s.up, 1);
        const downFee = calcTakerFee(s.down, 1);
        const totalFee = upFee + downFee;
        const pairCost = s.up + s.down;
        const feeRate = (totalFee / pairCost * 100).toFixed(2);
        console.log(`    ${s.label}: pair=$${pairCost.toFixed(2)}, fee=$${totalFee.toFixed(5)}/pair (${feeRate}%)`);
    }
}


// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) {
    process.exit(1);
}
