/**
 * Entity Matcher — Multi-layer matching engine
 * 
 * Determines if two strings/records refer to the same underlying entity,
 * and detects the logical relationship between them.
 * 
 * Relationships:
 *   identical  — same thing, same wording
 *   equivalent — same thing, different wording ("BTC" vs "Bitcoin")
 *   implies    — A being true means B must be true ("Trump wins" → "Republican wins")
 *   implied_by — inverse of implies
 *   inverse    — A being true means B must be false ("Yes shutdown" vs "No shutdown")
 *   subset     — A is a narrower version of B ("BTC > 100k" is subset of "BTC > 95k")
 *   superset   — A is broader than B
 *   related    — same domain/entity but different claims
 *   unrelated  — nothing in common
 * 
 * Usage:
 *   const matcher = new EntityMatcher();
 *   const result = matcher.match("Trump wins presidency", "Republican wins 2024");
 *   // { score: 0.85, relationship: 'implies', confidence: 0.9, signals: {...} }
 */

// ============================================================
// LAYER 1: Normalization
// ============================================================

const ABBREVIATIONS = {
    'btc': 'bitcoin', 'eth': 'ethereum', 'sol': 'solana',
    'doge': 'dogecoin', 'xrp': 'ripple',
    'gop': 'republican', 'dem': 'democrat', 'dems': 'democrats',
    'govt': 'government', 'gov': 'government',
    'pres': 'president', 'potus': 'president',
    'scotus': 'supreme court', 'sec': 'securities exchange commission',
    'fed': 'federal reserve', 'fomc': 'federal open market committee',
    'gdp': 'gross domestic product', 'cpi': 'consumer price index',
    'yoy': 'year over year', 'mom': 'month over month',
    'jan': 'january', 'feb': 'february', 'mar': 'march', 'apr': 'april',
    'jun': 'june', 'jul': 'july', 'aug': 'august', 'sep': 'september',
    'sept': 'september', 'oct': 'october', 'nov': 'november', 'dec': 'december',
    'vs': 'versus', 'v': 'versus',
    'us': 'united states', 'usa': 'united states', 'uk': 'united kingdom',
};

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'will', 'would', 'could', 'should', 'may', 'might', 'shall',
    'to', 'of', 'in', 'for', 'on', 'at', 'by', 'with', 'from',
    'and', 'or', 'but', 'not', 'this', 'that', 'it', 'its',
    'do', 'does', 'did', 'has', 'have', 'had',
]);

const NEGATION_WORDS = new Set(['not', 'no', "don't", "doesn't", "won't", "isn't", "aren't", 'never', 'neither', 'nor']);

function normalize(text) {
    if (!text) return '';
    let s = String(text).toLowerCase().trim();
    
    // Remove possessives
    s = s.replace(/'s\b/g, '');
    
    // Normalize punctuation
    s = s.replace(/['']/g, "'");
    s = s.replace(/[""]/g, '"');
    s = s.replace(/[–—]/g, '-');
    
    // Remove non-alphanumeric except spaces, hyphens, periods, commas, $, %, >, <
    s = s.replace(/[^a-z0-9\s\-.,\$%><]/g, ' ');
    
    // Expand abbreviations
    s = s.split(/\s+/).map(w => ABBREVIATIONS[w] || w).join(' ');
    
    // Collapse whitespace
    s = s.replace(/\s+/g, ' ').trim();
    
    return s;
}

function tokenize(text) {
    const normalized = normalize(text);
    return normalized.split(/\s+/).filter(w => w.length > 0);
}

function tokenizeNoStop(text) {
    return tokenize(text).filter(w => !STOP_WORDS.has(w));
}

// ============================================================
// LAYER 2: Token-based Similarity
// ============================================================

function jaccard(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return intersection.size / union.size;
}

function overlap(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    return intersection.size / Math.min(setA.size, setB.size);
}

function tokenSimilarity(a, b) {
    const tokensA = new Set(tokenizeNoStop(a));
    const tokensB = new Set(tokenizeNoStop(b));
    
    return {
        jaccard: jaccard(tokensA, tokensB),
        overlap: overlap(tokensA, tokensB),
        sharedTokens: [...tokensA].filter(t => tokensB.has(t)),
        uniqueA: [...tokensA].filter(t => !tokensB.has(t)),
        uniqueB: [...tokensB].filter(t => !tokensA.has(t)),
    };
}

// ============================================================
// LAYER 3: Structural Extraction
// ============================================================

/**
 * Extract structured fields from a prediction market question or any entity string.
 * Returns: { entities, action, polarity, threshold, date, domain }
 */

// Known entities by domain
const POLITICAL_FIGURES = {
    'trump': { party: 'republican', role: 'president' },
    'donald trump': { party: 'republican', role: 'president' },
    'biden': { party: 'democrat', role: 'president' },
    'joe biden': { party: 'democrat', role: 'president' },
    'harris': { party: 'democrat', role: 'vice president' },
    'kamala harris': { party: 'democrat', role: 'vice president' },
    'desantis': { party: 'republican', role: 'governor' },
    'ron desantis': { party: 'republican', role: 'governor' },
    'vance': { party: 'republican', role: 'vice president' },
    'jd vance': { party: 'republican', role: 'vice president' },
};

const CRYPTO_ASSETS = {
    'bitcoin': 'BTC', 'btc': 'BTC',
    'ethereum': 'ETH', 'eth': 'ETH', 'ether': 'ETH',
    'solana': 'SOL', 'sol': 'SOL',
    'dogecoin': 'DOGE', 'doge': 'DOGE',
    'ripple': 'XRP', 'xrp': 'XRP',
    'cardano': 'ADA', 'ada': 'ADA',
};

function extractStructure(text) {
    const norm = normalize(text);
    const tokens = tokenize(text);
    const result = {
        entities: [],
        action: null,
        polarity: 'positive',   // positive or negative
        threshold: null,         // numeric threshold if present
        thresholdDirection: null, // 'above' or 'below'
        date: null,
        domain: 'unknown',
        raw: norm,
    };

    // Detect polarity (negation)
    // Check for negation words, but also "no X" pattern at start
    const hasNegation = tokens.some(t => NEGATION_WORDS.has(t));
    if (hasNegation) result.polarity = 'negative';
    // Also catch "will not", "does not", etc.
    if (norm.match(/\b(no|not|won't|don't|doesn't|isn't|aren't|won't|never)\s+/)) {
        result.polarity = 'negative';
    }

    // Detect domain and extract entities
    // Political
    for (const [name, info] of Object.entries(POLITICAL_FIGURES)) {
        if (norm.includes(name)) {
            result.entities.push({ name, type: 'person', ...info });
            result.domain = 'politics';
        }
    }
    if (norm.includes('republican') || norm.includes('democrat') || norm.includes('gop')) {
        result.domain = 'politics';
        if (norm.includes('republican')) result.entities.push({ name: 'republican', type: 'party' });
        if (norm.includes('democrat')) result.entities.push({ name: 'democrat', type: 'party' });
    }

    // Crypto (deduplicate by ticker)
    const seenTickers = new Set();
    for (const [name, ticker] of Object.entries(CRYPTO_ASSETS)) {
        if (norm.includes(name) && !seenTickers.has(ticker)) {
            result.entities.push({ name: ticker, type: 'crypto' });
            result.domain = 'crypto';
            seenTickers.add(ticker);
        }
    }

    // Economic
    if (norm.includes('federal reserve') || norm.includes('rate') || norm.includes('inflation') || 
        norm.includes('consumer price index') || norm.includes('gross domestic product')) {
        result.domain = 'economics';
    }

    // Government/Policy events
    if (norm.includes('shutdown') || norm.includes('government')) {
        result.domain = 'politics';
        if (norm.includes('shutdown')) {
            result.entities.push({ name: 'government_shutdown', type: 'event' });
            result.action = result.action || 'shutdown';
        }
    }

    // Extract threshold (numbers with $, %, k, etc.)
    // Suffix must be immediately after number (no space) to avoid matching "by" etc.
    const thresholdMatch = norm.match(/(?:above|over|below|under|greater than|less than|more than|>\s*|<\s*)\s*\$?([\d,]+\.?\d*)(%|k|m|b)?(?:\s|$)/);
    if (thresholdMatch) {
        let val = parseFloat(thresholdMatch[1].replace(/,/g, ''));
        const suffix = thresholdMatch[2];
        if (suffix === 'k') val *= 1000;
        if (suffix === 'm') val *= 1000000;
        if (suffix === 'b') val *= 1000000000;
        result.threshold = val;
        
        const dir = norm.match(/(above|over|greater than|more than|>)/);
        result.thresholdDirection = dir ? 'above' : 'below';
    }

    // Standalone number with $ (price target)
    if (!result.threshold) {
        const priceMatch = norm.match(/\$\s*([\d,]+\.?\d*)\s*(%|k|m|b)?/);
        if (priceMatch) {
            let val = parseFloat(priceMatch[1].replace(/,/g, ''));
            const suffix = priceMatch[2];
            if (suffix === 'k') val *= 1000;
            if (suffix === 'm') val *= 1000000;
            result.threshold = val;
        }
    }
    
    // Handle "100k" style without $ sign
    if (!result.threshold) {
        const shortMatch = norm.match(/([\d,]+\.?\d*)\s*(k|m|b)\b/);
        if (shortMatch) {
            let val = parseFloat(shortMatch[1].replace(/,/g, ''));
            if (shortMatch[2] === 'k') val *= 1000;
            if (shortMatch[2] === 'm') val *= 1000000;
            if (shortMatch[2] === 'b') val *= 1000000000;
            result.threshold = val;
        }
    }

    // Extract action verbs
    const actionPatterns = [
        { pattern: /\b(win|wins|winning|won)\b/, action: 'win' },
        { pattern: /\b(lose|loses|losing|lost|defeat)\b/, action: 'lose' },
        { pattern: /\b(above|over|exceed|surpass)\b/, action: 'above' },
        { pattern: /\b(below|under|fall)\b/, action: 'below' },
        { pattern: /\b(up|rise|rising|increase|gain|bull)\b/, action: 'up' },
        { pattern: /\b(down|drop|fall|decrease|decline|bear)\b/, action: 'down' },
        { pattern: /\b(cut|cuts|cutting|lower|reduce)\b/, action: 'cut' },
        { pattern: /\b(hike|raise|increase)\b/, action: 'raise' },
        { pattern: /\b(shutdown|shut down)\b/, action: 'shutdown' },
        { pattern: /\b(confirm|confirmed|nomination|nominate)\b/, action: 'confirm' },
        { pattern: /\b(ban|block|restrict|prohibit)\b/, action: 'restrict' },
        { pattern: /\b(approve|pass|passes|passing|enact)\b/, action: 'approve' },
    ];
    for (const { pattern, action } of actionPatterns) {
        if (pattern.test(norm)) {
            result.action = action;
            break;
        }
    }

    // Extract date
    const datePatterns = [
        // "by January 31" / "before Feb 2026" / "in March"
        /\b(by|before|after|in|on|until)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?,?\s*(\d{4})?\b/,
        // "January 30, 2026"
        /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(\d{4})?\b/,
        // "2026" standalone year
        /\b(20\d{2})\b/,
        // Q1 2026 etc
        /\b(q[1-4])\s*(20\d{2})?\b/,
    ];
    for (const pattern of datePatterns) {
        const m = norm.match(pattern);
        if (m) {
            result.date = m[0];
            break;
        }
    }

    return result;
}

// ============================================================
// LAYER 3b: Structural Comparison & Relationship Detection
// ============================================================

function detectRelationship(structA, structB) {
    const result = {
        relationship: 'unrelated',
        confidence: 0,
        reasoning: [],
    };

    // Same domain?
    if (structA.domain !== structB.domain && structA.domain !== 'unknown' && structB.domain !== 'unknown') {
        result.reasoning.push(`Different domains: ${structA.domain} vs ${structB.domain}`);
        return result;
    }

    // Extract entity names for comparison
    const entitiesA = new Set(structA.entities.map(e => e.name));
    const entitiesB = new Set(structB.entities.map(e => e.name));
    const sharedEntities = [...entitiesA].filter(e => entitiesB.has(e));
    
    // No entity overlap at all
    if (sharedEntities.length === 0 && entitiesA.size > 0 && entitiesB.size > 0) {
        // Check for implicit relationships (e.g., Trump → Republican)
        const implicitMatch = checkImplicitEntityRelationship(structA, structB);
        if (implicitMatch) {
            result.relationship = implicitMatch.relationship;
            result.confidence = implicitMatch.confidence;
            result.reasoning.push(implicitMatch.reason);
            return result;
        }
        result.reasoning.push('No shared entities');
        return result;
    }

    // Same entities — now check the claim
    if (sharedEntities.length > 0) {
        result.reasoning.push(`Shared entities: ${sharedEntities.join(', ')}`);
    }

    // Same action?
    const sameAction = structA.action && structB.action && structA.action === structB.action;
    const oppositeAction = areOppositeActions(structA.action, structB.action);

    // Polarity
    const samePolarity = structA.polarity === structB.polarity;

    // Check threshold relationship
    if (structA.threshold != null && structB.threshold != null && sharedEntities.length > 0) {
        if (structA.thresholdDirection === structB.thresholdDirection) {
            if (structA.threshold === structB.threshold) {
                result.relationship = samePolarity ? 'equivalent' : 'inverse';
                result.confidence = 0.95;
                result.reasoning.push(`Same threshold: ${structA.threshold}`);
            } else if (structA.thresholdDirection === 'above') {
                // "BTC above 100k" implies "BTC above 95k" (higher threshold implies lower)
                if (structA.threshold > structB.threshold) {
                    result.relationship = samePolarity ? 'implies' : 'inverse';
                    result.confidence = 0.9;
                    result.reasoning.push(`${structA.threshold} > ${structB.threshold}: higher "above" implies lower "above"`);
                } else {
                    result.relationship = samePolarity ? 'implied_by' : 'inverse';
                    result.confidence = 0.9;
                    result.reasoning.push(`${structA.threshold} < ${structB.threshold}: lower "above" is implied by higher "above"`);
                }
            } else if (structA.thresholdDirection === 'below') {
                // "BTC below 90k" implies "BTC below 95k"
                if (structA.threshold < structB.threshold) {
                    result.relationship = samePolarity ? 'implies' : 'inverse';
                    result.confidence = 0.9;
                    result.reasoning.push(`${structA.threshold} < ${structB.threshold}: lower "below" implies higher "below"`);
                } else {
                    result.relationship = samePolarity ? 'implied_by' : 'inverse';
                    result.confidence = 0.9;
                }
            }
            return result;
        }
    }

    // Same entity + same action + same polarity = likely equivalent
    if (sharedEntities.length > 0 && sameAction && samePolarity) {
        result.relationship = 'equivalent';
        result.confidence = 0.85;
        result.reasoning.push('Same entity, action, and polarity');
        return result;
    }

    // Same entity + opposite action OR different polarity = inverse
    if (sharedEntities.length > 0 && (oppositeAction || !samePolarity)) {
        result.relationship = 'inverse';
        result.confidence = 0.8;
        result.reasoning.push('Same entity but opposite action or polarity');
        return result;
    }

    // Same entity, different or no action
    if (sharedEntities.length > 0) {
        result.relationship = 'related';
        result.confidence = 0.6;
        result.reasoning.push('Same entity, different claims');
        return result;
    }

    return result;
}

function areOppositeActions(a, b) {
    if (!a || !b) return false;
    const opposites = {
        'win': 'lose', 'lose': 'win',
        'above': 'below', 'below': 'above',
        'up': 'down', 'down': 'up',
        'cut': 'raise', 'raise': 'cut',
        'approve': 'restrict', 'restrict': 'approve',
    };
    return opposites[a] === b;
}

function checkImplicitEntityRelationship(structA, structB) {
    // Person → Party implication
    // If A mentions a person from party X and B mentions that party
    for (const entA of structA.entities) {
        if (entA.type === 'person' && entA.party) {
            for (const entB of structB.entities) {
                if (entB.type === 'party' && entB.name === entA.party) {
                    // "Trump wins" → "Republican wins" (implies, if same action context)
                    if (structA.action === structB.action) {
                        return {
                            relationship: 'implies',
                            confidence: 0.85,
                            reason: `${entA.name} is ${entA.party} → person winning implies party winning`,
                        };
                    }
                    return {
                        relationship: 'related',
                        confidence: 0.7,
                        reason: `${entA.name} is ${entA.party} (related but different claims)`,
                    };
                }
            }
        }
    }
    // Check reverse direction
    for (const entB of structB.entities) {
        if (entB.type === 'person' && entB.party) {
            for (const entA of structA.entities) {
                if (entA.type === 'party' && entA.name === entB.party) {
                    if (structA.action === structB.action) {
                        return {
                            relationship: 'implied_by',
                            confidence: 0.85,
                            reason: `${entB.name} is ${entB.party} → party winning doesn't guarantee this person`,
                        };
                    }
                    return {
                        relationship: 'related',
                        confidence: 0.7,
                        reason: `${entB.name} is ${entB.party} (related)`,
                    };
                }
            }
        }
    }
    return null;
}

// ============================================================
// LAYER 4: Edit Distance (lightweight, no model needed)
// ============================================================

function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            const cost = b[i - 1] === a[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[b.length][a.length];
}

function normalizedEditDistance(a, b) {
    const normA = normalize(a);
    const normB = normalize(b);
    const maxLen = Math.max(normA.length, normB.length);
    if (maxLen === 0) return 1;
    return 1 - (levenshtein(normA, normB) / maxLen);
}

// ============================================================
// MAIN MATCHER CLASS
// ============================================================

class EntityMatcher {
    constructor(options = {}) {
        this.options = {
            // Minimum score to consider a match
            matchThreshold: options.matchThreshold || 0.6,
            // Weight for each signal
            weights: {
                tokenOverlap: 0.25,
                editDistance: 0.15,
                structural: 0.45,
                domainMatch: 0.15,
                ...(options.weights || {}),
            },
        };
    }

    /**
     * Match two strings/records and determine their relationship.
     * 
     * @param {string} a - First entity/question
     * @param {string} b - Second entity/question
     * @param {object} context - Optional context (domain hint, etc.)
     * @returns {{ score: number, relationship: string, confidence: number, signals: object }}
     */
    match(a, b, context = {}) {
        const normA = normalize(a);
        const normB = normalize(b);

        // Quick exact match
        if (normA === normB) {
            return {
                score: 1.0,
                relationship: 'identical',
                confidence: 1.0,
                signals: { exact: true },
            };
        }

        // Layer 2: Token similarity
        const tokenSim = tokenSimilarity(a, b);

        // Layer 3: Structural extraction & comparison
        const structA = extractStructure(a);
        const structB = extractStructure(b);
        const structural = detectRelationship(structA, structB);

        // Layer 4: Edit distance
        const editSim = normalizedEditDistance(a, b);

        // Domain match bonus
        const domainMatch = (structA.domain !== 'unknown' && structA.domain === structB.domain) ? 1 : 0;

        // Aggregate score
        const w = this.options.weights;
        const score = Math.min(1, (
            tokenSim.jaccard * w.tokenOverlap +
            editSim * w.editDistance +
            structural.confidence * w.structural +
            domainMatch * w.domainMatch
        ));

        return {
            score: Math.round(score * 1000) / 1000,
            relationship: structural.relationship,
            confidence: structural.confidence,
            signals: {
                tokenJaccard: Math.round(tokenSim.jaccard * 100) / 100,
                tokenOverlap: Math.round(tokenSim.overlap * 100) / 100,
                editDistance: Math.round(editSim * 100) / 100,
                sharedTokens: tokenSim.sharedTokens,
                domain: structA.domain,
                structureA: structA,
                structureB: structB,
                reasoning: structural.reasoning,
            },
        };
    }

    /**
     * Find matches for an entity against a list of candidates.
     * Returns candidates sorted by score (descending).
     */
    findMatches(query, candidates, context = {}) {
        const results = candidates.map((candidate, i) => {
            const text = typeof candidate === 'string' ? candidate : candidate.question || candidate.name || candidate.text;
            const result = this.match(query, text, context);
            return { ...result, index: i, candidate };
        });

        return results
            .filter(r => r.score >= this.options.matchThreshold)
            .sort((a, b) => b.score - a.score);
    }

    /**
     * Find all pairwise relationships in a list of entities.
     * Returns pairs with detected logical relationships for arbitrage.
     */
    findRelationships(entities, context = {}) {
        const pairs = [];
        for (let i = 0; i < entities.length; i++) {
            for (let j = i + 1; j < entities.length; j++) {
                const textA = typeof entities[i] === 'string' ? entities[i] : entities[i].question || entities[i].name;
                const textB = typeof entities[j] === 'string' ? entities[j] : entities[j].question || entities[j].name;
                
                const result = this.match(textA, textB, context);
                
                // Only return non-unrelated pairs
                if (result.relationship !== 'unrelated' && result.score >= this.options.matchThreshold) {
                    pairs.push({
                        ...result,
                        indexA: i,
                        indexB: j,
                        entityA: entities[i],
                        entityB: entities[j],
                    });
                }
            }
        }
        return pairs.sort((a, b) => b.score - a.score);
    }
}

// ============================================================
// COMBINATORIAL ARB DETECTOR
// ============================================================

/**
 * Given a list of markets with prices, find combinatorial arbitrage opportunities
 * based on logical relationships between markets.
 */
function findCombinatorialArbs(markets, options = {}) {
    const matcher = new EntityMatcher(options);
    const opportunities = [];

    const pairs = matcher.findRelationships(markets);

    for (const pair of pairs) {
        const marketA = pair.entityA;
        const marketB = pair.entityB;
        const priceA = marketA.yesPrice || marketA.price;
        const priceB = marketB.yesPrice || marketB.price;

        if (priceA == null || priceB == null) continue;

        const rel = pair.relationship;
        let arb = null;

        if (rel === 'implies' || rel === 'subset') {
            // A implies B → P(B) must be ≥ P(A)
            // If P(B) < P(A), buy B YES (underpriced)
            if (priceB < priceA) {
                const edge = priceA - priceB;
                arb = {
                    type: 'implication_violation',
                    rule: `"${marketA.question}" implies "${marketB.question}" → B should be ≥ A`,
                    action: `Buy "${marketB.question}" YES at ${priceB}¢ (implied floor: ${priceA}¢)`,
                    edge,
                    buy: { market: marketB, side: 'YES', price: priceB },
                    reason: `${marketA.question} (${priceA}¢) implies ${marketB.question} (${priceB}¢) but B is cheaper`,
                };
            }
        }

        if (rel === 'implied_by' || rel === 'superset') {
            // B implies A → P(A) must be ≥ P(B)
            if (priceA < priceB) {
                const edge = priceB - priceA;
                arb = {
                    type: 'implication_violation',
                    rule: `"${marketB.question}" implies "${marketA.question}" → A should be ≥ B`,
                    action: `Buy "${marketA.question}" YES at ${priceA}¢ (implied floor: ${priceB}¢)`,
                    edge,
                    buy: { market: marketA, side: 'YES', price: priceA },
                    reason: `${marketB.question} (${priceB}¢) implies ${marketA.question} (${priceA}¢) but A is cheaper`,
                };
            }
        }

        if (rel === 'inverse') {
            // A and B are inverse → P(A) + P(B) should ≈ 100¢
            const sum = priceA + priceB;
            if (sum < 95) {
                // Both underpriced — buy both
                const edge = 100 - sum;
                arb = {
                    type: 'inverse_underpriced',
                    rule: `"${marketA.question}" is inverse of "${marketB.question}" → should sum to ~100¢`,
                    action: `Buy both YES: A at ${priceA}¢ + B at ${priceB}¢ = ${sum}¢ (guaranteed ${edge}¢ profit)`,
                    edge,
                    buy: [
                        { market: marketA, side: 'YES', price: priceA },
                        { market: marketB, side: 'YES', price: priceB },
                    ],
                    reason: `Inverse markets sum to ${sum}¢ < 100¢`,
                };
            }
            if (sum > 105) {
                // Both overpriced — sell both (buy NO on both)
                const edge = sum - 100;
                arb = {
                    type: 'inverse_overpriced',
                    rule: `Inverse markets sum to ${sum}¢ > 100¢`,
                    action: `Buy both NO: A_NO at ${100 - priceA}¢ + B_NO at ${100 - priceB}¢`,
                    edge,
                    buy: [
                        { market: marketA, side: 'NO', price: 100 - priceA },
                        { market: marketB, side: 'NO', price: 100 - priceB },
                    ],
                    reason: `Inverse markets sum to ${sum}¢ > 100¢`,
                };
            }
        }

        if (rel === 'equivalent') {
            // Should be same price — arb the difference
            const diff = Math.abs(priceA - priceB);
            if (diff >= 5) {
                const cheap = priceA < priceB ? marketA : marketB;
                const expensive = priceA < priceB ? marketB : marketA;
                const cheapPrice = Math.min(priceA, priceB);
                const expensivePrice = Math.max(priceA, priceB);
                arb = {
                    type: 'equivalent_mispricing',
                    rule: `Equivalent markets but ${diff}¢ apart`,
                    action: `Buy "${cheap.question}" YES at ${cheapPrice}¢, sell "${expensive.question}" YES at ${expensivePrice}¢`,
                    edge: diff,
                    buy: { market: cheap, side: 'YES', price: cheapPrice },
                    sell: { market: expensive, side: 'YES', price: expensivePrice },
                    reason: `Same market priced differently: ${cheapPrice}¢ vs ${expensivePrice}¢`,
                };
            }
        }

        if (arb && arb.edge >= (options.minEdge || 3)) {
            opportunities.push({
                ...arb,
                matchScore: pair.score,
                relationship: rel,
                confidence: pair.confidence,
                reasoning: pair.signals.reasoning,
            });
        }
    }

    return opportunities.sort((a, b) => b.edge - a.edge);
}

// ============================================================
// EXPORTS
// ============================================================

export {
    EntityMatcher,
    findCombinatorialArbs,
    normalize,
    tokenize,
    tokenizeNoStop,
    tokenSimilarity,
    extractStructure,
    detectRelationship,
    normalizedEditDistance,
};

export default EntityMatcher;
