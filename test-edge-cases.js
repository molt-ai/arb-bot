import { EntityMatcher, extractStructure, semanticSimilarity, normalize } from './src/entity-matcher.js';

const matcher = new EntityMatcher();
await matcher.warmup();

let passed = 0, failed = 0, total = 0;

function expect(a, b, expectedRel, desc) {
    total++;
    return { a, b, expectedRel, desc };
}

async function runTests(name, tests) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${name}`);
    console.log(`${'='.repeat(60)}\n`);
    
    let sectionPassed = 0, sectionFailed = 0;
    
    for (const t of tests) {
        const result = await matcher.match(t.a, t.b);
        const expected = Array.isArray(t.expectedRel) ? t.expectedRel : [t.expectedRel];
        const ok = expected.includes(result.relationship);
        
        if (ok) {
            sectionPassed++;
            passed++;
            console.log(`  ✅ ${t.desc}`);
            console.log(`     ${result.relationship} (${result.score.toFixed(2)}) sem:${result.signals.semantic?.toFixed(2) || '-'}`);
        } else {
            sectionFailed++;
            failed++;
            console.log(`  ❌ ${t.desc}`);
            console.log(`     GOT: ${result.relationship} (${result.score.toFixed(2)}) sem:${result.signals.semantic?.toFixed(2) || '-'}`);
            console.log(`     WANT: ${expected.join(' or ')}`);
            console.log(`     "${t.a}" ↔ "${t.b}"`);
            if (result.signals.reasoning?.length) {
                console.log(`     reason: ${result.signals.reasoning.join(' | ')}`);
            }
        }
    }
    
    console.log(`\n  ${sectionPassed}/${sectionPassed + sectionFailed} passed\n`);
}

// ============================================================
// BUSINESS NAME MATCHING
// ============================================================
await runTests('BUSINESS NAMES', [
    expect("McDonald's Corporation", "McDonalds Corp", ['equivalent', 'related'], "Possessive + abbreviation"),
    expect("JP Morgan Chase & Co", "JPMorgan", ['equivalent', 'related'], "Spaces, ampersand, partial"),
    expect("Meta Platforms Inc", "Facebook", ['equivalent', 'related'], "Company rebrand"),
    expect("Alphabet Inc", "Google", ['equivalent', 'related'], "Parent company vs brand"),
    expect("The Walt Disney Company", "Disney", ['equivalent', 'related'], "Full name vs short"),
    expect("Berkshire Hathaway Inc.", "Berkshire Hathaway", 'equivalent', "Inc vs no Inc"),
    expect("AT&T Inc", "AT&T", ['equivalent', 'related'], "Ampersand entity"),
    expect("Procter & Gamble", "P&G", ['identical', 'equivalent', 'related'], "Abbreviation to initials"),
    expect("Microsoft Corporation", "Microsft Corp", ['equivalent', 'related'], "Typo in name"),
    expect("Amazon.com Inc", "Amazon", ['equivalent', 'related'], "Domain suffix removal"),
    expect("Tesla Inc", "SpaceX", 'unrelated', "Different companies, same founder"),
    expect("Apple Inc", "Apple Records", ['unrelated', 'related'], "Same name, different entities"),
]);

// ============================================================
// ADDRESS MATCHING
// ============================================================
await runTests('ADDRESSES', [
    expect("123 Main St, Apt 4B, New York, NY", "123 Main Street, Unit 4B, New York, NY", ['equivalent', 'related'], "St vs Street, Apt vs Unit"),
    expect("456 Oak Ave, Suite 100, San Francisco, CA 94102", "456 Oak Avenue, Ste 100, SF, CA", ['equivalent', 'related'], "Ave vs Avenue, SF vs San Francisco"),
    expect("789 Broadway, NYC", "789 Broadway, New York City", ['identical', 'equivalent', 'related'], "NYC vs New York City"),
    expect("10 Downing St, London", "10 Downing Street, London, UK", ['equivalent', 'related'], "St vs Street, added country"),
    expect("1600 Pennsylvania Ave NW, Washington DC", "The White House", ['equivalent', 'related'], "Address vs landmark name"),
    expect("123 Main St, New York", "456 Main St, New York", ['related', 'unrelated'], "Same street name, different number"),
    expect("123 Main St, New York", "123 Main St, Los Angeles", ['related', 'unrelated', 'equivalent'], "Same address, different city"),
]);

// ============================================================
// PERSON NAME MATCHING
// ============================================================
await runTests('PERSON NAMES', [
    expect("Bill Gates", "William Gates", ['identical', 'equivalent', 'related'], "Nickname vs full name"),
    expect("Bob Smith", "Robert Smith", ['identical', 'equivalent', 'related'], "Bob vs Robert"),
    expect("J. Biden", "Joe Biden", ['equivalent', 'related'], "Initial vs name"),
    expect("Dwayne Johnson", "The Rock", ['identical', 'equivalent', 'related'], "Stage name vs real name"),
    expect("Elon Musk", "Musk", ['equivalent', 'related'], "Full name vs last name"),
    expect("Donald J. Trump", "Donald Trump", ['equivalent', 'related'], "Middle initial"),
    expect("John Smith", "John Smith Jr", ['related', 'equivalent'], "Generational suffix"),
    expect("John Smith", "Jane Smith", ['related', 'unrelated'], "Different first name, same last"),
    expect("Barack Obama", "Michelle Obama", ['related', 'unrelated'], "Same last name, different person"),
]);

// ============================================================
// PREDICTION MARKETS — NEGATION EDGE CASES
// ============================================================
await runTests('NEGATION & INVERSE', [
    expect("Government shutdown", "No government shutdown", 'inverse', "Explicit no-negation"),
    expect("Trump wins", "Trump does not win", 'inverse', "does not negation"),
    expect("Bitcoin rises above $100k", "Bitcoin fails to reach $100k", 'inverse', "Failure phrasing"),
    expect("Fed raises rates", "Fed holds rates steady", ['inverse', 'related'], "Opposite action vs hold"),
    expect("Market crashes", "Market does not crash", 'inverse', "does not + same noun"),
    expect("Bill passes Senate", "Bill fails in Senate", 'inverse', "passes vs fails"),
    expect("Ceasefire reached", "No ceasefire", 'inverse', "Event vs no-event"),
    expect("Recession in 2026", "No recession in 2026", 'inverse', "Year-specific negation"),
    expect("War breaks out", "Peace maintained", ['inverse', 'related'], "Semantic opposite, no shared words"),
]);

// ============================================================
// PREDICTION MARKETS — IMPLICATION CHAINS
// ============================================================
await runTests('IMPLICATION LOGIC', [
    expect("Trump wins presidency", "Republican wins presidency", 'implies', "Person implies party"),
    expect("Republican wins", "Trump wins", ['implied_by', 'related'], "Party doesn't guarantee person"),
    expect("BTC above $120k", "BTC above $100k", 'implies', "Higher threshold implies lower"),
    expect("BTC above $100k", "BTC above $120k", ['implied_by', 'related'], "Lower doesn't imply higher"),
    expect("Democrats win House AND Senate", "Democrats win House", ['implies', 'related'], "Conjunction implies individual"),
    expect("S&P 500 drops 20%", "Market enters bear territory", ['equivalent', 'implies', 'related'], "Definition equivalence"),
    expect("Unemployment below 4%", "Unemployment below 5%", 'implies', "Lower threshold implies higher for 'below'"),
]);

// ============================================================
// PREDICTION MARKETS — TEMPORAL MATCHING
// ============================================================
await runTests('TEMPORAL / DATE MATCHING', [
    expect("BTC above $100k by January 2026", "BTC above $100k by Jan 2026", ['identical', 'equivalent', 'related'], "Month abbreviation"),
    expect("Fed cuts in Q1 2026", "Fed cuts in March 2026", ['related', 'equivalent'], "Quarter vs specific month"),
    expect("Trump wins in 2024", "Trump wins in 2028", ['related', 'unrelated'], "Same event, different year"),
    expect("Government shutdown Jan 31", "Government shutdown by end of January", ['equivalent', 'related'], "Date vs description"),
    expect("Bitcoin above $100k today", "Bitcoin above $100k this year", 'related', "Different timeframe"),
]);

// ============================================================
// UNSTRUCTURED TEXT — SEMANTIC HEAVY
// ============================================================
await runTests('UNSTRUCTURED / SEMANTIC', [
    expect("The stock market will crash soon", "Equities face major selloff", ['equivalent', 'related'], "Completely different words, same meaning"),
    expect("Housing prices keep going up", "Real estate market continues to appreciate", ['equivalent', 'related'], "Different vocabulary, same concept"),
    expect("People are losing their jobs", "Unemployment rate increases", ['equivalent', 'related'], "Casual vs formal, same meaning"),
    expect("Gas prices through the roof", "Fuel costs skyrocketing", ['equivalent', 'related'], "Slang vs formal"),
    expect("Nobody trusts the banks anymore", "Banking sector faces confidence crisis", ['equivalent', 'related'], "Casual vs institutional"),
    expect("AI is taking over everything", "Artificial intelligence adoption accelerates", ['equivalent', 'related'], "Casual vs technical"),
    expect("The weather is terrible today", "Stock market crashes", 'unrelated', "Truly unrelated topics"),
    expect("My car broke down", "Vehicle experienced mechanical failure", ['equivalent', 'related'], "Casual vs formal, same event"),
]);

// ============================================================
// MISSPELLINGS & TYPOS
// ============================================================
await runTests('MISSPELLINGS & TYPOS', [
    expect("Govenment shutdown", "Government shutdown", ['equivalent', 'related'], "Typo in government"),
    expect("Bitconi above $100k", "Bitcoin above $100k", ['equivalent', 'related'], "Transposed letters"),
    expect("Etherium price", "Ethereum price", ['equivalent', 'related'], "Common misspelling"),
    expect("Donlad Trump wins", "Donald Trump wins", ['equivalent', 'related'], "Name typo"),
    expect("Recesion in 2026", "Recession in 2026", ['equivalent', 'related'], "Missing letter"),
]);

// ============================================================
// MIXED STRUCTURED + UNSTRUCTURED
// ============================================================
await runTests('STRUCTURED vs UNSTRUCTURED', [
    expect("BTC/USD > 100000", "Will Bitcoin cross one hundred thousand?", ['equivalent', 'related'], "Technical notation vs natural language"),
    expect("SPX < 4000", "S&P 500 drops below four thousand", ['equivalent', 'related'], "Ticker vs full name + words for numbers"),
    expect("AAPL earnings beat", "Apple Inc reports better than expected quarterly results", ['equivalent', 'related'], "Ticker + jargon vs full description"),
    expect("Rate: 5.25% → 5.00%", "Federal Reserve cuts interest rate by 25 basis points", ['equivalent', 'related'], "Numeric notation vs description"),
    expect("ETH $3,000", "Ethereum reaches three thousand dollars", ['equivalent', 'related'], "Price notation vs words"),
]);

// ============================================================
// AMBIGUOUS / TRICKY
// ============================================================
await runTests('AMBIGUOUS & TRICKY', [
    expect("Trump wins", "Trump wins Nobel Prize", 'related', "Same person, very different event"),
    expect("Apple above $200", "Apple iPhone sales exceed 200 million", ['related', 'unrelated'], "Same entity name, different meaning"),
    expect("Oil prices rise", "Oil spill in Gulf", ['related', 'unrelated'], "Same commodity, different context"),
    expect("China invades Taiwan", "Taiwan declares independence", ['related', 'inverse'], "Related geopolitical events"),
    expect("Bitcoin", "Bitcoin", 'identical', "Same word"),
    expect("", "", 'identical', "Empty strings"),
    expect("a", "b", ['unrelated', 'related'], "Single characters"),
]);

// ============================================================
// SUMMARY
// ============================================================
console.log('\n' + '='.repeat(60));
console.log(`  TOTAL: ${passed}/${total} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
    console.log('\n⚠️  Failures indicate areas to improve the matcher.');
} else {
    console.log('\n🎉 All tests passed!');
}
