export interface FuzzyMatchResult {
  score: number;
  matches: number[]; // indices of matched characters in the target string
}

/**
 * Sequential character fuzzy matcher with scoring bonuses.
 * Prefers substring and prefix matches heavily over scattered character matches.
 * Returns null if not all query characters are found in order.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (!query) return { score: 0, matches: [] };

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // --- Fast-path: exact substring match ---
  const substringIndex = targetLower.indexOf(queryLower);
  if (substringIndex !== -1) {
    const matches = Array.from({ length: query.length }, (_, i) => substringIndex + i);
    let score = query.length * 15; // high base for full substring

    // Prefix bonus
    if (substringIndex === 0) {
      score += 20;
    }

    // Word-boundary bonus for the start of the substring
    if (
      substringIndex === 0 ||
      target[substringIndex - 1] === ' ' ||
      target[substringIndex - 1] === '-' ||
      target[substringIndex - 1] === '_'
    ) {
      score += 10;
    }

    // Exact case bonus
    for (let i = 0; i < query.length; i++) {
      if (target[substringIndex + i] === query[i]) {
        score += 1;
      }
    }

    // Bonus for covering a larger fraction of the target
    score += Math.round((query.length / target.length) * 15);

    return { score, matches };
  }

  // --- Fuzzy character-by-character match ---
  const matches: number[] = [];
  let score = 0;
  let qi = 0;
  let prevMatchIndex = -2; // -2 so first match isn't "consecutive"

  for (let ti = 0; ti < target.length && qi < queryLower.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) {
      matches.push(ti);
      score += 10; // base match bonus

      // Consecutive match bonus
      if (ti === prevMatchIndex + 1) {
        score += 5;
      }

      // Word-boundary bonus (after space, -, _, or at index 0)
      if (ti === 0 || target[ti - 1] === ' ' || target[ti - 1] === '-' || target[ti - 1] === '_') {
        score += 8;
      }

      // Exact case match bonus
      if (target[ti] === query[qi]) {
        score += 3;
      }

      // Gap penalty — stronger for larger gaps
      const gap = ti - prevMatchIndex - 1;
      if (gap > 1 && prevMatchIndex >= 0) {
        score -= gap * 2;
      }

      prevMatchIndex = ti;
      qi++;
    }
  }

  // All query characters must be matched
  if (qi < queryLower.length) return null;

  return { score, matches };
}

export interface FuzzyFilterItem<T> {
  item: T;
  score: number;
  matches: number[];
}

/**
 * Minimum score threshold to include an item.
 * Short queries need proportionally higher scores to avoid matching everything.
 */
function scoreThreshold(queryLength: number): number {
  if (queryLength <= 1) return 15; // single char must be a prefix or boundary hit
  if (queryLength <= 2) return 12;
  return 8;
}

/**
 * Filters and sorts items by fuzzy match score.
 * Tries primary label first, then falls back to keywords.
 * Items below the minimum score threshold are excluded.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getLabel: (item: T) => string,
  getKeywords?: (item: T) => string[],
): FuzzyFilterItem<T>[] {
  if (!query) return items.map((item) => ({ item, score: 0, matches: [] as number[] }));

  const threshold = scoreThreshold(query.length);
  const results: FuzzyFilterItem<T>[] = [];

  for (const item of items) {
    const label = getLabel(item);
    const labelResult = fuzzyMatch(query, label);
    if (labelResult && labelResult.score >= threshold) {
      results.push({ item, score: labelResult.score, matches: labelResult.matches });
      continue;
    }

    // Try keywords
    if (getKeywords) {
      const keywords = getKeywords(item);
      let bestKeywordResult: FuzzyMatchResult | null = null;
      for (const kw of keywords) {
        const kwResult = fuzzyMatch(query, kw);
        if (kwResult && (!bestKeywordResult || kwResult.score > bestKeywordResult.score)) {
          bestKeywordResult = kwResult;
        }
      }
      if (bestKeywordResult && bestKeywordResult.score >= threshold) {
        // Keyword matches get slightly lower priority (empty matches array since they matched keyword, not label)
        results.push({ item, score: bestKeywordResult.score - 5, matches: [] });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
