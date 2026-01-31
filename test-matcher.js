import { EntityMatcher, findCombinatorialArbs, extractStructure } from './src/entity-matcher.js';

const matcher = new EntityMatcher();

console.log('\n=== RELATIONSHIP DETECTION ===\n');

const tests = [
    // Implication: person → party
    ['Trump wins the presidency', 'Republican wins 2024 election'],
    // Inverse
    ['Government shutdown happens', 'No government shutdown'],
    // Threshold implication
    ['Bitcoin above $100k', 'Bitcoin above $95k'],
    ['BTC above $100k by January', 'Bitcoin over $100,000'],
    // Equivalent
    ['Will BTC go up today?', 'Bitcoin up or down today'],
    // Unrelated
    ['Trump wins', 'Bitcoin above $100k'],
    // Inverse action
    ['Fed cuts rates in March', 'Fed raises rates in March'],
    // Related but different
    ['Trump wins presidency', 'Trump approval rating above 50%'],
];

for (const [a, b] of tests) {
    const result = matcher.match(a, b);
    const emoji = {
        identical: '🟰', equivalent: '🟢', implies: '➡️', implied_by: '⬅️',
        inverse: '🔴', subset: '📦', superset: '📤', related: '🟡', unrelated: '⚪',
    }[result.relationship] || '❓';
    
    console.log(`${emoji} ${result.relationship.padEnd(12)} (${result.score}) | "${a}" vs "${b}"`);
    if (result.signals.reasoning?.length) {
        console.log(`   └─ ${result.signals.reasoning.join(' | ')}`);
    }
}

console.log('\n=== COMBINATORIAL ARB DETECTION ===\n');

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

const arbs = findCombinatorialArbs(markets, { minEdge: 2 });

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

console.log('\n=== STRUCTURE EXTRACTION ===\n');

const samples = [
    'Will Bitcoin be above $100,000 by January 31, 2026?',
    'Trump wins the 2024 presidential election',
    'Fed cuts interest rates in March 2026',
    'Government shutdown before February',
    'Ethereum price below $3k by Q2 2026',
];

for (const s of samples) {
    const struct = extractStructure(s);
    console.log(`"${s}"`);
    console.log(`  Domain: ${struct.domain} | Action: ${struct.action} | Polarity: ${struct.polarity}`);
    console.log(`  Entities: ${struct.entities.map(e => e.name).join(', ') || 'none'}`);
    if (struct.threshold) console.log(`  Threshold: ${struct.thresholdDirection} ${struct.threshold}`);
    if (struct.date) console.log(`  Date: ${struct.date}`);
    console.log('');
}
