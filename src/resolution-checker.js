/**
 * Resolution Criteria Checker
 * 
 * Uses heuristics and pattern matching to detect likely resolution mismatches
 * between Polymarket and Kalshi markets. No external API required.
 * 
 * Flags suspicious matches like:
 * - Different date thresholds
 * - Different price targets
 * - Different source requirements
 * - Unusually large spreads on auto-discovered pairs
 */

export class ResolutionChecker {
    constructor(config = {}) {
        this.minSpreadToCheck = config.minSpreadToCheck || 10; // Only check spreads > 10%
        this.maxSafeSpread = config.maxSafeSpread || 5; // Auto-approve spreads < 5%
        
        // Patterns that indicate potential mismatches
        this.datePatterns = [
            /by\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+/gi,
            /by\s+\d{1,2}\/\d{1,2}\/\d{2,4}/g,
            /before\s+(january|february|march|april|may|june|july|august|september|october|november|december)/gi,
            /Q[1-4]\s*\d{4}/gi,
            /\d{4}/g,
        ];
        
        this.pricePatterns = [
            /\$[\d,]+(?:k|K|m|M)?/g,
            /\d+(?:,\d{3})*\s*(?:dollars|USD)/gi,
            /above\s+\$?[\d,]+/gi,
            /below\s+\$?[\d,]+/gi,
            /hit\s+\$?[\d,]+/gi,
        ];
        
        this.stats = {
            checked: 0,
            approved: 0,
            flagged: 0,
        };
        
        console.log('[RESOLUTION-CHECKER] ✅ Using heuristic matching (no API required)');
    }

    /**
     * Check if two markets likely have matching resolution criteria
     */
    async check(polyMarket, kalshiMarket, spread = 0) {
        this.stats.checked++;
        
        const polyName = (polyMarket.question || polyMarket.title || polyMarket.name || '').toLowerCase();
        const kalshiName = (kalshiMarket.title || kalshiMarket.name || '').toLowerCase();
        
        // Auto-approve small spreads (likely accurate matches)
        if (spread < this.maxSafeSpread) {
            this.stats.approved++;
            return { 
                approved: true, 
                confidence: 0.9, 
                reason: 'Small spread indicates good price alignment' 
            };
        }
        
        // Check for obvious mismatches
        const issues = [];
        
        // 1. Check date mismatches
        const polyDates = this.extractDates(polyName);
        const kalshiDates = this.extractDates(kalshiName);
        if (polyDates.length && kalshiDates.length) {
            const dateMatch = polyDates.some(pd => 
                kalshiDates.some(kd => this.datesMatch(pd, kd))
            );
            if (!dateMatch) {
                issues.push(`Date mismatch: Poly has ${polyDates.join(', ')}, Kalshi has ${kalshiDates.join(', ')}`);
            }
        }
        
        // 2. Check price target mismatches
        const polyPrices = this.extractPrices(polyName);
        const kalshiPrices = this.extractPrices(kalshiName);
        if (polyPrices.length && kalshiPrices.length) {
            const priceMatch = polyPrices.some(pp => 
                kalshiPrices.some(kp => Math.abs(pp - kp) / Math.max(pp, kp) < 0.1) // 10% tolerance
            );
            if (!priceMatch) {
                issues.push(`Price target mismatch: Poly ${polyPrices.join(', ')}, Kalshi ${kalshiPrices.join(', ')}`);
            }
        }
        
        // 3. Check for suspicious keywords that indicate different criteria
        const suspiciousKeywords = [
            { poly: 'any', kalshi: 'official', reason: 'Different threshold (any vs official)' },
            { poly: 'announcement', kalshi: 'confirmation', reason: 'Different verification standard' },
            { poly: 'first', kalshi: 'total', reason: 'Different counting method' },
            { poly: 'close', kalshi: 'intraday', reason: 'Different price measurement' },
        ];
        
        for (const kw of suspiciousKeywords) {
            if (polyName.includes(kw.poly) && kalshiName.includes(kw.kalshi)) {
                issues.push(kw.reason);
            }
        }
        
        // 4. Flag very large spreads as suspicious regardless
        if (spread > 50) {
            issues.push(`Extremely large spread (${spread}%) — likely different markets`);
        } else if (spread > 25) {
            issues.push(`Large spread (${spread}%) — verify resolution criteria match`);
        }
        
        // 5. Name similarity check
        const similarity = this.calculateSimilarity(polyName, kalshiName);
        if (similarity < 0.5) {
            issues.push(`Low name similarity (${(similarity * 100).toFixed(0)}%) — may be different events`);
        }
        
        // Decision
        if (issues.length > 0) {
            this.stats.flagged++;
            return {
                approved: false,
                confidence: Math.max(0, 0.5 - (issues.length * 0.1)),
                reason: issues.join('; '),
                issues,
            };
        }
        
        this.stats.approved++;
        return {
            approved: true,
            confidence: 0.7,
            reason: 'No obvious mismatches detected',
        };
    }
    
    /**
     * Extract dates from text
     */
    extractDates(text) {
        const dates = [];
        for (const pattern of this.datePatterns) {
            const matches = text.match(pattern);
            if (matches) dates.push(...matches);
        }
        return [...new Set(dates)];
    }
    
    /**
     * Extract price values from text
     */
    extractPrices(text) {
        const prices = [];
        const priceMatch = text.match(/\$?([\d,]+)(?:k|K)?/g);
        if (priceMatch) {
            for (const p of priceMatch) {
                const num = parseFloat(p.replace(/[$,]/g, ''));
                if (!isNaN(num) && num > 100) { // Ignore small numbers
                    const multiplier = p.toLowerCase().includes('k') ? 1000 : 1;
                    prices.push(num * multiplier);
                }
            }
        }
        return prices;
    }
    
    /**
     * Check if two date strings likely refer to the same date
     */
    datesMatch(d1, d2) {
        const norm1 = d1.toLowerCase().replace(/\s+/g, '');
        const norm2 = d2.toLowerCase().replace(/\s+/g, '');
        return norm1 === norm2 || norm1.includes(norm2) || norm2.includes(norm1);
    }
    
    /**
     * Calculate string similarity (Jaccard index on words)
     */
    calculateSimilarity(s1, s2) {
        const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
        const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
        
        const intersection = new Set([...words1].filter(w => words2.has(w)));
        const union = new Set([...words1, ...words2]);
        
        return union.size > 0 ? intersection.size / union.size : 0;
    }
    
    /**
     * Get stats
     */
    getStatus() {
        return {
            enabled: true,
            mode: 'heuristic',
            ...this.stats,
        };
    }
}

export default ResolutionChecker;
