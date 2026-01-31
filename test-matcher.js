import { EntityMatcher, findCombinatorialArbs, extractStructure, semanticSimilarity } from './src/entity-matcher.js';

const matcher = new EntityMatcher();

// Warm up model first
console.log('Loading semantic model...\n');
await matcher.warmup();

console.log('=== LAYER 4: SEMANTIC SIMILARITY (unstructured text) ===\n');

// These pairs have LOW token overlap but HIGH semantic meaning overlap
// This is where traditional fuzzy matching completely fails
const semanticTests = [
    // Same meaning, completely different words
    ['The economy is headed for a recession', 'GDP will contract for two consecutive quarters'],
    ['US government runs out of funding', 'Federal government shutdown'],
    ['Inflation keeps rising', 'Consumer prices continue to increase'],
    // Same entity, different phrasing
    ['Will Elon sell his Twitter stake?', 'Musk divests X holdings'],
    ['Interest rates go higher', 'The Fed tightens monetary policy'],
    // Actually unrelated despite some surface similarity
    ['Apple stock price rises', 'Apple harvest season begins'],
    ['Mercury is in retrograde', 'Mercury levels in water supply'],
    // Structured vs unstructured — same meaning
    ['BTC/USD > 100000', 'Will Bitcoin surpass one hundred thousand dollars?'],
    ['Trump 2024 victory', 'Donald Trump wins the next presidential election'],
    // Address matching (non-prediction-market use case)
    ['123 Main St, Apt 4B, New York', '123 Main Street, Unit 4B, NYC'],
    ['McDonald\'s Corporation', 'McDonalds Corp'],
];

for (const [a, b] of semanticTests) {
    const result = await matcher.match(a, b);
    const sem = result.signals.semantic;
    const emoji = {
        identical: '🟰', equivalent: '🟢', implies: '➡️', implied_by: '⬅️',
        inverse: '🔴', subset: '📦', superset: '📤', related: '🟡', unrelated: '⚪',
    }[result.relationship] || '❓';
    
    console.log(`${emoji} ${result.relationship.padEnd(12)} score:${result.score.toFixed(2)} sem:${sem?.toFixed(2) || 'n/a'} | "${a}" ↔ "${b}"`);
    if (result.signals.reasoning?.length) {
        console.log(`   └─ ${result.signals.reasoning.join(' | ')}`);
    }
}

console.log('\n=== PREDICTION MARKET MATCHING (structural + semantic) ===\n');

const marketTests = [
    ['Trump wins the presidency', 'Republican wins 2024 election'],
    ['Government shutdown happens', 'No government shutdown'],
    ['Bitcoin above $100k', 'Bitcoin above $95k'],
    ['BTC above $100k by January', 'Bitcoin over $100,000'],
    ['Will BTC go up today?', 'Bitcoin up or down today'],
    ['Trump wins', 'Bitcoin above $100k'],
    ['Fed cuts rates in March', 'Fed raises rates in March'],
    ['Trump wins presidency', 'Trump approval rating above 50%'],
];

for (const [a, b] of marketTests) {
    const result = await matcher.match(a, b);
    const sem = result.signals.semantic;
    const emoji = {
        identical: '🟰', equivalent: '🟢', implies: '➡️', implied_by: '⬅️',
        inverse: '🔴', subset: '📦', superset: '📤', related: '🟡', unrelated: '⚪',
    }[result.relationship] || '❓';
    
    console.log(`${emoji} ${result.relationship.padEnd(12)} score:${result.score.toFixed(2)} sem:${sem?.toFixed(2) || 'n/a'} | "${a}" ↔ "${b}"`);
}

console.log('\n=== COMBINATORIAL ARB DETECTION (with semantic layer) ===\n');

const markets = [
    { question: 'Trump wins the presidency', yesPrice: 62 },
    { question: 'Republican wins 2024 election', yesPrice: 55 },
    { question: 'Government shutdown by Jan 31', yesPrice: 40 },
    { question: 'No government shutdown January', yesPrice: 45 },
    { question: 'Bitcoin above $100k', yesPrice: 70 },
    { question: 'Bitcoin above $95k', yesPrice: 65 },
    { question: 'Bitcoin above $110k', yesPrice: 50 },
    { question: 'Fed cuts rates March', yesPrice: 35 },
    { question: 'Fed raises rates March', yesPrice: 30 },
];

const arbs = await findCombinatorialArbs(markets, { minEdge: 2 });

if (arbs.length === 0) {
    console.log('No combinatorial arbs found.');
} else {
    for (const arb of arbs) {
        console.log(`💰 ${arb.type} | Edge: ${arb.edge}¢ | Confidence: ${arb.confidence}`);
        console.log(`   ${arb.action}`);
        console.log(`   ${arb.reason}`);
        console.log('');
    }
}

console.log('=== SYNC vs ASYNC PERFORMANCE ===\n');

const start1 = Date.now();
for (const [a, b] of marketTests) matcher.matchSync(a, b);
console.log(`Sync (no embeddings): ${Date.now() - start1}ms for ${marketTests.length} pairs`);

const start2 = Date.now();
for (const [a, b] of marketTests) await matcher.match(a, b);
console.log(`Async (with embeddings): ${Date.now() - start2}ms for ${marketTests.length} pairs`);

console.log('\nDone ✓');
