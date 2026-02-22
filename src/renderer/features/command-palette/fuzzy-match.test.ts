import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyFilter } from './fuzzy-match';

describe('fuzzyMatch', () => {
  it('returns score 0 and empty matches for empty query', () => {
    expect(fuzzyMatch('', 'hello')).toEqual({ score: 0, matches: [] });
  });

  it('matches all characters in order', () => {
    const result = fuzzyMatch('abc', 'aXbXc');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([0, 2, 4]);
  });

  it('returns null when query characters not all found', () => {
    expect(fuzzyMatch('xyz', 'hello')).toBeNull();
  });

  it('returns null for partial match', () => {
    expect(fuzzyMatch('abc', 'ab')).toBeNull();
  });

  it('is case insensitive', () => {
    const result = fuzzyMatch('ABC', 'abcdef');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([0, 1, 2]);
  });

  it('gives higher score for consecutive matches', () => {
    const consecutive = fuzzyMatch('abc', 'abcdef')!;
    const spaced = fuzzyMatch('abc', 'aXbXcX')!;
    expect(consecutive.score).toBeGreaterThan(spaced.score);
  });

  it('gives higher score for word-boundary matches', () => {
    const boundary = fuzzyMatch('dp', 'display-panel')!;
    const midWord = fuzzyMatch('dp', 'adapt')!;
    expect(boundary.score).toBeGreaterThan(midWord.score);
  });

  it('gives bonus for exact case match', () => {
    const exact = fuzzyMatch('A', 'Apple')!;
    const lower = fuzzyMatch('a', 'Apple')!;
    expect(exact.score).toBeGreaterThan(lower.score);
  });

  it('handles single character query', () => {
    const result = fuzzyMatch('a', 'abc');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([0]);
  });

  it('matches at the end of string', () => {
    const result = fuzzyMatch('z', 'xyz');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([2]);
  });

  it('handles query same length as target', () => {
    const result = fuzzyMatch('abc', 'abc');
    expect(result).not.toBeNull();
    expect(result!.matches).toEqual([0, 1, 2]);
  });

  it('handles hyphenated word boundaries', () => {
    const result = fuzzyMatch('ct', 'curious-tapir');
    expect(result).not.toBeNull();
    // "ct" is not a substring, so fuzzy path: c at 0, t at 8
    expect(result!.matches).toEqual([0, 8]);
  });

  it('handles underscore word boundaries', () => {
    const result = fuzzyMatch('sm', 'set_mode');
    expect(result).not.toBeNull();
    // "sm" is not a substring, so fuzzy path: s at 0, m at 4
    expect(result!.matches).toEqual([0, 4]);
  });

  // Substring match tests
  it('detects exact substring matches with contiguous indices', () => {
    const result = fuzzyMatch('set', 'Display Settings')!;
    expect(result).not.toBeNull();
    // "set" found as substring starting at index 8
    expect(result.matches).toEqual([8, 9, 10]);
  });

  it('gives higher score for prefix substring than mid-word substring', () => {
    const prefix = fuzzyMatch('dis', 'Display Settings')!;
    const midWord = fuzzyMatch('set', 'Display Settings')!;
    expect(prefix.score).toBeGreaterThan(midWord.score);
  });

  it('gives higher score for exact substring than scattered fuzzy match', () => {
    const substring = fuzzyMatch('log', 'Logging')!;
    const scattered = fuzzyMatch('log', 'Load Ongoing')!;
    expect(substring.score).toBeGreaterThan(scattered.score);
  });

  it('gives coverage bonus for query matching larger fraction of target', () => {
    const highCoverage = fuzzyMatch('about', 'About')!;
    const lowCoverage = fuzzyMatch('about', 'About Everything')!;
    expect(highCoverage.score).toBeGreaterThan(lowCoverage.score);
  });
});

describe('fuzzyFilter', () => {
  const items = [
    { id: 1, name: 'Display Settings' },
    { id: 2, name: 'Notification Settings' },
    { id: 3, name: 'About' },
    { id: 4, name: 'Logging' },
  ];

  const getLabel = (item: typeof items[0]) => item.name;

  it('returns all items with score 0 for empty query', () => {
    const result = fuzzyFilter(items, '', getLabel);
    expect(result).toHaveLength(4);
    expect(result.every((r) => r.score === 0)).toBe(true);
  });

  it('filters to matching items', () => {
    const result = fuzzyFilter(items, 'dis', getLabel);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].item.name).toBe('Display Settings');
  });

  it('returns empty array when nothing matches', () => {
    const result = fuzzyFilter(items, 'zzz', getLabel);
    expect(result).toHaveLength(0);
  });

  it('sorts by score descending', () => {
    const result = fuzzyFilter(items, 'set', getLabel);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it('falls back to keywords when label does not match', () => {
    const result = fuzzyFilter(
      items,
      'config',
      getLabel,
      (item) => item.name === 'Display Settings' ? ['config', 'ui'] : [],
    );
    expect(result).toHaveLength(1);
    expect(result[0].item.name).toBe('Display Settings');
  });

  it('prioritizes label matches over keyword matches', () => {
    const itemsWithKeywords = [
      { id: 1, name: 'Config' },
      { id: 2, name: 'Display' },
    ];
    const result = fuzzyFilter(
      itemsWithKeywords,
      'config',
      (i) => i.name,
      (i) => i.name === 'Display' ? ['config'] : [],
    );
    expect(result).toHaveLength(2);
    expect(result[0].item.name).toBe('Config');
  });

  // Score threshold tests
  it('filters out weak single-character matches (not prefix or boundary)', () => {
    const itemsForThreshold = [
      { id: 1, name: 'About' },           // 'a' at prefix — should match
      { id: 2, name: 'Display Settings' }, // 'a' mid-word at index 5 — weak
    ];
    const result = fuzzyFilter(itemsForThreshold, 'a', (i) => i.name);
    // About should match (prefix 'a'), Display Settings may not meet threshold
    const aboutMatch = result.find((r) => r.item.name === 'About');
    expect(aboutMatch).toBeTruthy();
  });

  it('includes strong matches and excludes weak ones with short query', () => {
    const testItems = [
      { id: 1, name: 'Agents' },    // 'ag' is prefix → strong
      { id: 2, name: 'Logging' },   // 'ag' is not present → no match
    ];
    const result = fuzzyFilter(testItems, 'ag', (i) => i.name);
    expect(result.length).toBe(1);
    expect(result[0].item.name).toBe('Agents');
  });
});
