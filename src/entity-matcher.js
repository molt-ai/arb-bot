/**
 * Entity Matcher - Multi-layer matching engine
 *
 * Determines if two strings/records refer to the same underlying entity,
 * and detects the logical relationship between them.
 *
 * Relationships:
 *   identical  - same thing, same wording
 *   equivalent - same thing, different wording ("BTC" vs "Bitcoin")
 *   implies    - A being true means B must be true ("Trump wins" → "Republican wins")
 *   implied_by - inverse of implies
 *   inverse    - A being true means B must be false ("Yes shutdown" vs "No shutdown")
 *   subset     - A is a narrower version of B ("BTC > 100k" is subset of "BTC > 95k")
 *   superset   - A is broader than B
 *   related    - same domain/entity but different claims
 *   unrelated  - nothing in common
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
    // Crypto
    'btc': 'bitcoin', 'eth': 'ethereum', 'sol': 'solana',
    'doge': 'dogecoin', 'xrp': 'ripple',
    // Politics
    'gop': 'republican', 'dem': 'democrat', 'dems': 'democrats',
    'govt': 'government', 'gov': 'government',
    'pres': 'president', 'potus': 'president',
    'scotus': 'supreme court', 'sec': 'securities exchange commission',
    'fed': 'federal reserve', 'fomc': 'federal open market committee',
    // Economics
    'gdp': 'gross domestic product', 'cpi': 'consumer price index',
    'yoy': 'year over year', 'mom': 'month over month',
    // Dates
    'jan': 'january', 'feb': 'february', 'mar': 'march', 'apr': 'april',
    'jun': 'june', 'jul': 'july', 'aug': 'august', 'sep': 'september',
    'sept': 'september', 'oct': 'october', 'nov': 'november', 'dec': 'december',
    // General
    'vs': 'versus', 'v': 'versus',
    'us': 'united states', 'usa': 'united states', 'uk': 'united kingdom',
    // Address
    'st': 'street', 'ave': 'avenue', 'blvd': 'boulevard', 'dr': 'drive',
    'ln': 'lane', 'rd': 'road', 'ct': 'court', 'pl': 'place',
    'apt': 'apartment', 'ste': 'suite', 'fl': 'floor',
    'nyc': 'new york city', 'sf': 'san francisco', 'la': 'los angeles',
    'dc': 'district of columbia', 'nw': 'northwest', 'ne': 'northeast',
    'sw': 'southwest', 'se': 'southeast',
    // Business suffixes
    'inc': 'incorporated', 'corp': 'corporation', 'ltd': 'limited',
    'llc': 'limited liability company', 'co': 'company',
    'intl': 'international', 'natl': 'national',
    // Names
    'bill': 'william', 'bob': 'robert', 'jim': 'james', 'mike': 'michael',
    'joe': 'joseph', 'tom': 'thomas', 'dick': 'richard', 'rick': 'richard',
    'ted': 'theodore', 'tony': 'anthony', 'dan': 'daniel', 'dave': 'david',
    'steve': 'stephen', 'ben': 'benjamin', 'sam': 'samuel', 'al': 'albert',
    'ed': 'edward', 'rob': 'robert', 'will': 'william', 'matt': 'matthew',
    'nick': 'nicholas', 'pat': 'patrick', 'jack': 'john',
    // Tech
    'ai': 'artificial intelligence', 'ml': 'machine learning',
    'spx': 'sandp500', 'aapl': 'apple incorporated', 'msft': 'microsoft', 'goog': 'google_alphabet',
    'amzn': 'amazon', 'tsla': 'tesla', 'nvda': 'nvidia',
};

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'will', 'would', 'could', 'should', 'may', 'might', 'shall',
    'to', 'of', 'in', 'for', 'on', 'at', 'by', 'with', 'from',
    'and', 'or', 'but', 'not', 'this', 'that', 'it', 'its',
    'do', 'does', 'did', 'has', 'have', 'had',
]);

const NEGATION_WORDS = new Set([
    'not', 'no', "don't", "doesn't", "won't", "isn't", "aren't", 'never', 'neither', 'nor',
    "can't", "couldn't", "wouldn't", "shouldn't", "hasn't", "haven't", "hadn't",
]);

// Words that flip the meaning even without explicit "not"
const FAILURE_WORDS = new Set([
    'fail', 'fails', 'failed', 'failing', 'failure',
    'miss', 'misses', 'missed', 'missing',
    'reject', 'rejects', 'rejected', 'rejection',
    'deny', 'denies', 'denied', 'denial',
    'block', 'blocks', 'blocked', 'blocking',
    'prevent', 'prevents', 'prevented',
    'avoid', 'avoids', 'avoided',
    'unable', 'impossible',
]);

// Known aliases - entities that have completely different names
// These are multi-word replacements applied before tokenization
const KNOWN_ALIASES = [
    // Company rebrands / parent companies
    [/\bmeta\s+platforms?\b/gi, 'facebook_meta'],
    [/\bfacebook\b/gi, 'facebook_meta'],
    [/\balphabet\b(?!\s*(?:soup|order|letter))/gi, 'google_alphabet'],
    [/\bgoogle\b/gi, 'google_alphabet'],
    [/\bp\s*&\s*g\b/gi, 'procter gamble'],
    [/\bprocter\s*&?\s*gamble\b/gi, 'procter gamble'],
    [/\bjpmorgan\b/gi, 'jp morgan chase'],
    [/\bjp\s*morgan\s*(chase)?\s*(&\s*co\.?)?\b/gi, 'jp morgan chase'],
    [/\bx\s*corp\b/gi, 'twitter x'],
    [/\btwitter\b/gi, 'twitter x'],
    // Stage names / known aliases
    [/\bthe\s+rock\b/gi, 'dwayne johnson rock'],
    [/\bdwayne\s+johnson\b/gi, 'dwayne johnson rock'],
    [/\bking\s+charles\b/gi, 'charles iii king'],
    // Landmarks
    [/\bwhite\s+house\b/gi, '1600 pennsylvania white house'],
];

function normalize(text) {
    if (!text) return '';
    let s = String(text).toLowerCase().trim();

    // Remove possessives
    s = s.replace(/'s\b/g, '');

    // Normalize punctuation
    s = s.replace(/['']/g, "'");
    s = s.replace(/[""]/g, '"');
    s = s.replace(/[--]/g, '-');

    // Handle & compounds BEFORE stripping special chars (P&G, AT&T, S&P)
    s = s.replace(/\bp\s*&\s*g\b/g, 'procter gamble');
    s = s.replace(/\bat\s*&\s*t\b/g, 'att telecom');
    s = s.replace(/\bs\s*&\s*p\s*500/g, 'sandp500');
    s = s.replace(/\bs\s*&\s*p\b/g, 'sandp500');

    // Convert comparison operators to words before stripping
    s = s.replace(/</g, ' below ').replace(/>/g, ' above ');
    s = s.replace(/→|->|=>/g, ' to ');
    
    // Remove non-alphanumeric except spaces, hyphens, periods, commas, $, %, _
    s = s.replace(/[^a-z0-9\s\-.,\$%_]/g, ' ');

    // Expand single-word abbreviations
    s = s.split(/\s+/).map(w => ABBREVIATIONS[w] || w).join(' ');

    // Apply known aliases (multi-word replacements - AFTER abbreviation expansion)
    for (const [pattern, replacement] of KNOWN_ALIASES) {
        s = s.replace(pattern, replacement.toLowerCase());
    }

    // Convert word numbers to digits
    const wordNums = {
        'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
        'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
        'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
        'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
        'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
        'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
        'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000',
        'million': '1000000', 'billion': '1000000000',
    };
    // Handle "four thousand" → "4000", "one hundred" → "100"
    s = s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(hundred|thousand|million|billion)\b/g, (_, num, mult) => {
        return String(parseInt(wordNums[num]) * parseInt(wordNums[mult]));
    });
    // Handle standalone word numbers
    s = s.split(/\s+/).map(w => wordNums[w] || w).join(' ');
    
    // Deduplicate consecutive identical words
    s = s.replace(/\b(\w+)(\s+\1)+\b/g, '$1');

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
    const hasNegation = tokens.some(t => NEGATION_WORDS.has(t));
    const hasFailure = tokens.some(t => FAILURE_WORDS.has(t));
    if (hasNegation || hasFailure) result.polarity = 'negative';
    // Also catch "will not", "does not", contractions
    if (norm.match(/\b(no|not|won't|don't|doesn't|isn't|aren't|can't|couldn't|never|fails?\s+to|failed?\s+to)\b/)) {
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

    // Generic entity extraction - catch nouns not in specific lists
    // This handles "market", "ceasefire", "recession", "bill", etc.
    const GENERIC_ENTITIES = {
        'market': { name: 'market', type: 'concept', domain: 'economics' },
        'stock market': { name: 'stock_market', type: 'concept', domain: 'economics' },
        'equities': { name: 'stock_market', type: 'concept', domain: 'economics' },
        'housing': { name: 'housing_market', type: 'concept', domain: 'economics' },
        'real estate': { name: 'housing_market', type: 'concept', domain: 'economics' },
        'recession': { name: 'recession', type: 'event', domain: 'economics' },
        'inflation': { name: 'inflation', type: 'concept', domain: 'economics' },
        'unemployment': { name: 'employment', type: 'concept', domain: 'economics' },
        'jobs': { name: 'employment', type: 'concept', domain: 'economics' },
        'employment': { name: 'employment', type: 'concept', domain: 'economics' },
        'hiring': { name: 'employment', type: 'concept', domain: 'economics' },
        'layoff': { name: 'employment', type: 'concept', domain: 'economics' },
        'layoffs': { name: 'employment', type: 'concept', domain: 'economics' },
        'ceasefire': { name: 'ceasefire', type: 'event', domain: 'geopolitics' },
        'war': { name: 'conflict', type: 'event', domain: 'geopolitics' },
        'peace': { name: 'conflict', type: 'event', domain: 'geopolitics' },
        'truce': { name: 'conflict', type: 'event', domain: 'geopolitics' },
        'interest rate': { name: 'interest_rate', type: 'concept', domain: 'economics' },
        'rates': { name: 'interest_rate', type: 'concept', domain: 'economics' },
        'oil': { name: 'oil', type: 'commodity', domain: 'commodities' },
        'gas': { name: 'gas', type: 'commodity', domain: 'commodities' },
        'fuel': { name: 'gas', type: 'commodity', domain: 'commodities' },
        'gold': { name: 'gold', type: 'commodity', domain: 'commodities' },
        'senate': { name: 'senate', type: 'institution', domain: 'politics' },
        'congress': { name: 'congress', type: 'institution', domain: 'politics' },
        'taiwan': { name: 'taiwan', type: 'country', domain: 'geopolitics' },
        'china': { name: 'china', type: 'country', domain: 'geopolitics' },
        'russia': { name: 'russia', type: 'country', domain: 'geopolitics' },
        'ukraine': { name: 'ukraine', type: 'country', domain: 'geopolitics' },
    };

    const seenGeneric = new Set(result.entities.map(e => e.name));
    for (const [phrase, info] of Object.entries(GENERIC_ENTITIES)) {
        if (norm.includes(phrase) && !seenGeneric.has(info.name)) {
            result.entities.push({ ...info });
            if (result.domain === 'unknown') result.domain = info.domain;
            seenGeneric.add(info.name);
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
        { pattern: /\b(win|wins|winning|won|victory)\b/, action: 'win' },
        { pattern: /\b(lose|loses|losing|lost|defeat|defeated)\b/, action: 'lose' },
        { pattern: /\b(above|over|exceed|exceeds|surpass|surpasses|cross|crosses|reach|reaches)\b/, action: 'above' },
        { pattern: /\b(below|under)\b/, action: 'below' },
        { pattern: /\b(up\b|rise|rises|rising|increase|increases|gain|gains|bull|bullish|rally|rallies|appreciate)\b/, action: 'up' },
        { pattern: /\b(down\b|drop|drops|fall|falls|decrease|decline|bear|bearish|crash|crashes|selloff|sell-off)\b/, action: 'down' },
        { pattern: /\b(cut|cuts|cutting|lower|lowers|reduce|reduces|ease|eases|easing)\b/, action: 'cut' },
        { pattern: /\b(hike|hikes|raise|raises|tighten|tightens)\b/, action: 'raise' },
        { pattern: /\b(shutdown|shut down|shuts down)\b/, action: 'shutdown' },
        { pattern: /\b(confirm|confirmed|nomination|nominate|nominated)\b/, action: 'confirm' },
        { pattern: /\b(ban|bans|block|blocks|restrict|restricts|prohibit|prohibits)\b/, action: 'restrict' },
        { pattern: /\b(approve|approves|pass\b|passes|passing|enact|enacts)\b/, action: 'pass' },
        { pattern: /\b(fail|fails|failing|failed|failure|reject|rejects|rejected)\b/, action: 'fail' },
        { pattern: /\b(hold|holds|steady|unchanged|maintain|maintains|pause|pauses)\b/, action: 'hold' },
        { pattern: /\b(invade|invades|invasion|attack|attacks|war|wars|conflict|fight|fighting)\b/, action: 'invade' },
        { pattern: /\b(ceasefire|peace|peaceful|truce|armistice|maintain|maintained)\b/, action: 'ceasefire' },
        { pattern: /\b(recession|contract|contracts|contraction)\b/, action: 'recession' },
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
        // Relative time
        /\b(today|tonight|tomorrow|yesterday|this week|this month|this year|next week|next month|next year|end of year|year-end)\b/,
    ];
    for (const pattern of datePatterns) {
        const m = norm.match(pattern);
        if (m) {
            result.date = m[0];
            break;
        }
    }

    // ── Sports / Player Props Detection ──
    // Detect stat categories: points, rebounds, assists, touchdowns, yards, etc.
    const SPORT_STATS = {
        'points': 'points', 'pts': 'points', 'point': 'points',
        'rebounds': 'rebounds', 'rebs': 'rebounds', 'rebound': 'rebounds',
        'assists': 'assists', 'ast': 'assists', 'assist': 'assists',
        'steals': 'steals', 'stl': 'steals', 'steal': 'steals',
        'blocks': 'blocks_stat', 'blk': 'blocks_stat',  // disambiguate from "block" action
        'turnovers': 'turnovers', 'tov': 'turnovers', 'turnover': 'turnovers',
        'three-pointers': 'threes', 'threes': 'threes', '3-pointers': 'threes', '3pm': 'threes',
        'touchdowns': 'touchdowns', 'tds': 'touchdowns', 'td': 'touchdowns',
        'passing yards': 'passing_yards', 'rush yards': 'rushing_yards',
        'rushing yards': 'rushing_yards', 'receiving yards': 'receiving_yards',
        'yards': 'yards',
        'goals': 'goals', 'goal': 'goals',
        'saves': 'saves', 'save': 'saves',
        'hits': 'hits', 'hit': 'hits',
        'strikeouts': 'strikeouts', 'ks': 'strikeouts',
        'home runs': 'home_runs', 'hrs': 'home_runs', 'hr': 'home_runs',
        'runs': 'runs', 'rbis': 'rbis', 'rbi': 'rbis',
        'tweets': 'tweets', 'tweet': 'tweets', 'posts': 'posts',
    };

    // Detect bet type
    const SPORT_BET_TYPES = {
        'o/u': 'over_under', 'over/under': 'over_under', 'over under': 'over_under',
        'total': 'total', 'team total': 'team_total',
        'moneyline': 'moneyline', 'money line': 'moneyline',
        'spread': 'spread', 'handicap': 'spread',
        'winner': 'moneyline',
    };

    // Extract stat category
    for (const [phrase, stat] of Object.entries(SPORT_STATS)) {
        if (norm.includes(phrase)) {
            result.sportStat = stat;
            if (result.domain === 'unknown') result.domain = 'sports';
            break;
        }
    }

    // Extract bet type
    for (const [phrase, betType] of Object.entries(SPORT_BET_TYPES)) {
        if (norm.includes(phrase)) {
            result.sportBetType = betType;
            if (result.domain === 'unknown') result.domain = 'sports';
            break;
        }
    }

    // Detect O/U threshold (e.g., "O/U 8.5", "Over/Under 10.5")
    const ouMatch = norm.match(/o\/u\s*([\d.]+)/);
    if (ouMatch) {
        result.sportBetType = 'over_under';
        result.sportLine = parseFloat(ouMatch[1]);
        if (result.domain === 'unknown') result.domain = 'sports';
    }

    // Team total pattern: "Team Total: O/U 21.5"
    if (norm.match(/team total/)) {
        result.sportBetType = 'team_total';
    }

    // Detect "vs" pattern as potential sports matchup (moneyline/winner)
    const vsMatch = norm.match(/(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\s*[:!?]|\s+o\/u|\s*$)/);
    if (vsMatch && !result.sportBetType) {
        result.sportBetType = result.sportBetType || 'moneyline';
        if (result.domain === 'unknown') result.domain = 'sports';
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

    // Same entities - now check the claim
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

    // ── Sports mismatch guard ──
    // Different stat categories on the same player/team are NEVER equivalent
    const sportStatA = structA.sportStat;
    const sportStatB = structB.sportStat;
    const sportBetTypeA = structA.sportBetType;
    const sportBetTypeB = structB.sportBetType;

    if (sportStatA && sportStatB && sportStatA !== sportStatB) {
        result.relationship = 'related';
        result.confidence = 0.3;
        result.reasoning.push(`Same entity but different stat category: ${sportStatA} vs ${sportStatB}`);
        return result;
    }

    // Different bet types (e.g., O/U vs moneyline, team_total vs moneyline) are NOT equivalent
    if (sportBetTypeA && sportBetTypeB && sportBetTypeA !== sportBetTypeB) {
        result.relationship = 'related';
        result.confidence = 0.3;
        result.reasoning.push(`Same entity but different bet type: ${sportBetTypeA} vs ${sportBetTypeB}`);
        return result;
    }

    // Different O/U lines on the same stat are related (subset/superset), not equivalent
    if (structA.sportLine != null && structB.sportLine != null && structA.sportLine !== structB.sportLine) {
        if (sportStatA === sportStatB || (!sportStatA && !sportStatB)) {
            // Same stat, different line — this is a threshold relationship
            result.relationship = structA.sportLine < structB.sportLine ? 'subset' : 'superset';
            result.confidence = 0.8;
            result.reasoning.push(`Same stat O/U but different line: ${structA.sportLine} vs ${structB.sportLine}`);
            return result;
        }
    }

    // If one side is sports and the other isn't, they can't be equivalent
    if ((sportStatA || sportBetTypeA) && !(sportStatB || sportBetTypeB)) {
        result.relationship = 'related';
        result.confidence = 0.3;
        result.reasoning.push('One side is a sports prop, the other is not');
        return result;
    }
    if ((sportStatB || sportBetTypeB) && !(sportStatA || sportBetTypeA)) {
        result.relationship = 'related';
        result.confidence = 0.3;
        result.reasoning.push('One side is a sports prop, the other is not');
        return result;
    }

    // Check temporal mismatch - same claim but different time = related, not equivalent
    const dateA = structA.date;
    const dateB = structB.date;
    const temporalMismatch = dateA && dateB && dateA !== dateB;

    // Same entity + same action + same polarity = likely equivalent (unless temporal mismatch)
    if (sharedEntities.length > 0 && sameAction && samePolarity) {
        if (temporalMismatch) {
            result.relationship = 'related';
            result.confidence = 0.65;
            result.reasoning.push(`Same claim but different timeframe: "${dateA}" vs "${dateB}"`);
            return result;
        }
        // Check if one side has significantly more unique tokens - suggests different context
        const entNamesA = new Set(structA.entities.map(e => e.name));
        const entNamesB = new Set(structB.entities.map(e => e.name));
        const tokA = new Set(tokenizeNoStop(structA.raw));
        const tokB = new Set(tokenizeNoStop(structB.raw));
        const uniqueA = [...tokA].filter(t => !tokB.has(t));
        const uniqueB = [...tokB].filter(t => !tokA.has(t));

        // If one side has unique content words, it's probably a different specific claim
        if (uniqueA.length >= 2 || uniqueB.length >= 2) {
            result.relationship = 'related';
            result.confidence = 0.7;
            result.reasoning.push(`Same entity/action but different context: [${uniqueA.join(',')}] vs [${uniqueB.join(',')}]`);
            return result;
        }

        result.relationship = 'equivalent';
        result.confidence = 0.85;
        result.reasoning.push('Same entity, action, and polarity');
        return result;
    }

    // Same entity + opposite action = inverse (regardless of polarity)
    if (sharedEntities.length > 0 && oppositeAction) {
        result.relationship = 'inverse';
        result.confidence = 0.85;
        result.reasoning.push(`Same entity, opposite actions: ${structA.action} vs ${structB.action}`);
        return result;
    }

    // Same entity + same action + different polarity = inverse
    // e.g., "Market crashes" (positive) vs "Market does not crash" (negative)
    if (sharedEntities.length > 0 && sameAction && !samePolarity) {
        result.relationship = 'inverse';
        result.confidence = 0.85;
        result.reasoning.push('Same entity and action but opposite polarity');
        return result;
    }

    // Same entity, different polarity but no/different action
    if (sharedEntities.length > 0 && !samePolarity) {
        result.relationship = 'inverse';
        result.confidence = 0.7;
        result.reasoning.push('Same entity, opposite polarity');
        return result;
    }

    // Same entity, different or no action, same polarity
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
        'pass': 'fail', 'fail': 'pass',
        'pass': 'restrict', 'restrict': 'pass',
        'shutdown': 'no_shutdown', 'no_shutdown': 'shutdown',
        'confirm': 'fail', 'fail': 'confirm',
        'invade': 'ceasefire', 'ceasefire': 'invade',
        'hold': 'cut', // "hold rates" is opposite of "cut rates"
        'recession': 'up', // recession is opposite of growth
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
// LAYER 4: Semantic Embeddings (local model, no API)
// ============================================================

let _pipeline = null;
let _pipelineLoading = null;

/**
 * Lazy-load the embedding model. First call downloads ~23MB model,
 * subsequent calls are instant. Runs entirely local via ONNX.
 * Model: all-MiniLM-L6-v2 (384-dim embeddings, great for similarity)
 */
async function getEmbeddingPipeline() {
    if (_pipeline) return _pipeline;
    if (_pipelineLoading) return _pipelineLoading;

    _pipelineLoading = (async () => {
        try {
            const { pipeline } = await import('@huggingface/transformers');
            console.log('[ENTITY-MATCHER] Loading embedding model (first time downloads ~130MB)...');
            _pipeline = await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', {
                dtype: 'fp32',
            });
            console.log('[ENTITY-MATCHER] Embedding model loaded ✓');
            return _pipeline;
        } catch (e) {
            if (!getEmbeddingPipeline._warned) {
                console.warn('[ENTITY-MATCHER] Embedding model unavailable:', e.message);
                getEmbeddingPipeline._warned = true;
            }
            _pipelineLoading = null;
            return null;
        }
    })();

    return _pipelineLoading;
}

/**
 * Get embedding vector for a text string.
 * Returns Float32Array of 384 dimensions, or null if model unavailable.
 */
async function embed(text) {
    const pipe = await getEmbeddingPipeline();
    if (!pipe) return null;

    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return output.data;
}

/**
 * Cosine similarity between two embedding vectors.
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compute semantic similarity between two texts using local embeddings.
 * Returns 0-1 score, or null if model unavailable.
 */
async function semanticSimilarity(textA, textB) {
    const [embA, embB] = await Promise.all([embed(textA), embed(textB)]);
    if (!embA || !embB) return null;
    return cosineSimilarity(embA, embB);
}

// Embedding cache for batch operations
const _embeddingCache = new Map();

async function embedCached(text) {
    const key = normalize(text);
    if (_embeddingCache.has(key)) return _embeddingCache.get(key);
    const emb = await embed(text);
    if (emb) _embeddingCache.set(key, emb);
    return emb;
}

function clearEmbeddingCache() {
    _embeddingCache.clear();
}

// ============================================================
// LAYER 5: Edit Distance (lightweight fallback)
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
            // Use semantic embeddings (local model, ~23MB download first time)
            useEmbeddings: options.useEmbeddings !== false,
            // Weight for each signal
            weights: {
                tokenOverlap: 0.15,
                editDistance: 0.10,
                structural: 0.35,
                semantic: 0.30,     // embedding cosine similarity
                domainMatch: 0.10,
                ...(options.weights || {}),
            },
        };
        this._modelReady = false;
    }

    /**
     * Pre-load the embedding model. Optional - model loads lazily on first use.
     * Call this at startup to avoid latency on first match.
     */
    async warmup() {
        if (!this.options.useEmbeddings) return;
        const pipe = await getEmbeddingPipeline();
        this._modelReady = !!pipe;
        return this._modelReady;
    }

    /**
     * Synchronous match - uses all layers EXCEPT semantic embeddings.
     * Fast, no async, good for high-throughput scanning.
     */
    matchSync(a, b, context = {}) {
        return this._matchInternal(a, b, null, context);
    }

    /**
     * Full async match - includes semantic embedding similarity.
     * More accurate for unstructured/free-form text.
     */
    async match(a, b, context = {}) {
        let semanticScore = null;
        if (this.options.useEmbeddings) {
            semanticScore = await semanticSimilarity(a, b);
        }
        return this._matchInternal(a, b, semanticScore, context);
    }

    _matchInternal(a, b, semanticScore, context = {}) {
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

        // Layer 5: Edit distance
        const editSim = normalizedEditDistance(a, b);

        // Domain match bonus
        const domainMatch = (structA.domain !== 'unknown' && structA.domain === structB.domain) ? 1 : 0;

        // Aggregate score
        const w = this.options.weights;
        let score;

        if (semanticScore != null) {
            // Full scoring with semantic layer
            score = Math.min(1, (
                tokenSim.jaccard * w.tokenOverlap +
                editSim * w.editDistance +
                structural.confidence * w.structural +
                semanticScore * w.semantic +
                domainMatch * w.domainMatch
            ));
        } else {
            // No embeddings - redistribute semantic weight proportionally
            const noSemTotal = w.tokenOverlap + w.editDistance + w.structural + w.domainMatch;
            score = Math.min(1, (
                tokenSim.jaccard * (w.tokenOverlap / noSemTotal) +
                editSim * (w.editDistance / noSemTotal) +
                structural.confidence * (w.structural / noSemTotal) +
                domainMatch * (w.domainMatch / noSemTotal)
            ));
        }

        // ---- Rescue Logic: Semantic, Edit Distance, Token Overlap ----
        let relationship = structural.relationship;
        let confidence = structural.confidence;
        const reasoning = [...(structural.reasoning || [])];

        // Token overlap rescue: if one string's tokens are entirely contained in the other,
        // they're likely the same entity with different detail levels
        if (tokenSim.overlap >= 0.95 && relationship === 'unrelated') {
            relationship = 'related';
            confidence = Math.max(confidence, 0.65);
            reasoning.push(`Token overlap ${(tokenSim.overlap * 100).toFixed(0)}% — one contains the other`);
        }

        // Edit distance rescue: if strings are very similar (>0.85) but structural missed,
        // this catches typos, minor spelling differences, suffix variations
        if (editSim > 0.85 && relationship === 'unrelated') {
            relationship = 'related';
            confidence = Math.max(confidence, editSim * 0.9);
            reasoning.push(`High edit similarity (${(editSim * 100).toFixed(0)}%) - likely same entity with typo/variation`);
        }

        // Semantic upgrade: if structural says "unrelated" but semantic is meaningfully high
        // Lower threshold (0.65) catches more paraphrases; 0.8+ is very confident
        if (semanticScore != null && semanticScore > 0.65 && relationship === 'unrelated') {
            relationship = 'related';
            confidence = Math.max(confidence, semanticScore * 0.85);
            reasoning.push(`Semantic similarity (${(semanticScore * 100).toFixed(0)}%) suggests related despite no structural match`);
        }

        // Strong semantic upgrade: 0.85+ semantic = very likely equivalent if unstructured
        if (semanticScore != null && semanticScore > 0.85 && (relationship === 'related' || relationship === 'unrelated') && structural.confidence < 0.5) {
            relationship = 'equivalent';
            confidence = Math.max(confidence, semanticScore * 0.9);
            reasoning.push(`Very high semantic similarity (${(semanticScore * 100).toFixed(0)}%) - likely equivalent`);
        }

        // Semantic boost: if structural found a relationship, high semantic confirms it
        if (semanticScore != null && semanticScore > 0.7 && relationship !== 'unrelated') {
            confidence = Math.min(1, confidence + 0.1);
            reasoning.push(`Semantic confirms: ${(semanticScore * 100).toFixed(0)}%`);
        }

        // Semantic downgrade: if structural says related but semantic is very low (<0.25),
        // reduce confidence - the meaning is actually different
        if (semanticScore != null && semanticScore < 0.25 && confidence > 0.5) {
            confidence *= 0.7;
            reasoning.push(`Semantic similarity low (${(semanticScore * 100).toFixed(0)}%) - reducing confidence`);
        }

        // Recalculate score with potentially updated confidence
        if (semanticScore != null) {
            score = Math.min(1, (
                tokenSim.jaccard * w.tokenOverlap +
                editSim * w.editDistance +
                confidence * w.structural +
                semanticScore * w.semantic +
                domainMatch * w.domainMatch
            ));
        }

        return {
            score: Math.round(score * 1000) / 1000,
            relationship,
            confidence: Math.round(confidence * 100) / 100,
            signals: {
                tokenJaccard: Math.round(tokenSim.jaccard * 100) / 100,
                tokenOverlap: Math.round(tokenSim.overlap * 100) / 100,
                editDistance: Math.round(editSim * 100) / 100,
                semantic: semanticScore != null ? Math.round(semanticScore * 100) / 100 : null,
                sharedTokens: tokenSim.sharedTokens,
                domain: structA.domain,
                structureA: structA,
                structureB: structB,
                reasoning,
            },
        };
    }

    /**
     * Find matches for an entity against a list of candidates.
     * Returns candidates sorted by score (descending).
     * Async version uses embeddings; pass { sync: true } for fast mode.
     */
    async findMatches(query, candidates, context = {}) {
        const results = await Promise.all(candidates.map(async (candidate, i) => {
            const text = typeof candidate === 'string' ? candidate : candidate.question || candidate.name || candidate.text;
            const result = context.sync ? this.matchSync(query, text, context) : await this.match(query, text, context);
            return { ...result, index: i, candidate };
        }));

        return results
            .filter(r => r.score >= this.options.matchThreshold)
            .sort((a, b) => b.score - a.score);
    }

    /**
     * Find all pairwise relationships in a list of entities.
     * Returns pairs with detected logical relationships for arbitrage.
     * Uses embeddings by default; pass { sync: true } for fast mode.
     */
    async findRelationships(entities, context = {}) {
        const pairs = [];

        // Pre-compute all embeddings in batch for efficiency
        if (this.options.useEmbeddings && !context.sync) {
            await Promise.all(entities.map(e => {
                const text = typeof e === 'string' ? e : e.question || e.name;
                return embedCached(text);
            }));
        }

        for (let i = 0; i < entities.length; i++) {
            for (let j = i + 1; j < entities.length; j++) {
                const textA = typeof entities[i] === 'string' ? entities[i] : entities[i].question || entities[i].name;
                const textB = typeof entities[j] === 'string' ? entities[j] : entities[j].question || entities[j].name;

                let result;
                if (context.sync) {
                    result = this.matchSync(textA, textB, context);
                } else {
                    // Use cached embeddings for efficiency
                    const [embA, embB] = await Promise.all([embedCached(textA), embedCached(textB)]);
                    const semScore = (embA && embB) ? cosineSimilarity(embA, embB) : null;
                    result = this._matchInternal(textA, textB, semScore, context);
                }

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
async function findCombinatorialArbs(markets, options = {}) {
    const matcher = new EntityMatcher(options);
    const opportunities = [];

    const pairs = await matcher.findRelationships(markets);

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
                // Both underpriced - buy both
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
                // Both overpriced - sell both (buy NO on both)
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
            // Should be same price - arb the difference
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
    semanticSimilarity,
    embed,
    cosineSimilarity,
    clearEmbeddingCache,
    getEmbeddingPipeline,
};

export default EntityMatcher;
