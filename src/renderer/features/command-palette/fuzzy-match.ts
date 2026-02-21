export interface FuzzyMatchResult {
  score: number;
  matches: number[]; // indices of matched characters in the target string
}

/**
 * Sequential character fuzzy matcher with scoring bonuses.
 * Returns null if not all query characters are found in order.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (!query) return { score: 0, matches: [] };

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();
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

      // Gap penalty
      const gap = ti - prevMatchIndex - 1;
      if (gap > 1 && prevMatchIndex >= 0) {
        score -= gap;
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
 * Filters and sorts items by fuzzy match score.
 * Tries primary label first, then falls back to keywords.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getLabel: (item: T) => string,
  getKeywords?: (item: T) => string[],
): FuzzyFilterItem<T>[] {
  if (!query) return items.map((item) => ({ item, score: 0, matches: [] as number[] }));

  const results: FuzzyFilterItem<T>[] = [];

  for (const item of items) {
    const label = getLabel(item);
    const labelResult = fuzzyMatch(query, label);
    if (labelResult) {
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
      if (bestKeywordResult) {
        // Keyword matches get slightly lower priority (empty matches array since they matched keyword, not label)
        results.push({ item, score: bestKeywordResult.score - 5, matches: [] });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
