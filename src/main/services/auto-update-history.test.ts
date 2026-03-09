import { describe, it, expect } from 'vitest';
import { filterVersionHistory, composeVersionHistoryMarkdown } from './auto-update-service';
import type { VersionHistoryEntry } from '../../shared/types';

// ---------------------------------------------------------------------------
// filterVersionHistory
// ---------------------------------------------------------------------------

describe('filterVersionHistory', () => {
  const today = new Date().toISOString();
  const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  function entry(version: string, releaseDate: string): VersionHistoryEntry {
    return { version, releaseDate, releaseMessage: `v${version}`, releaseNotes: `Notes for ${version}` };
  }

  it('filters out versions newer than currentVersion', () => {
    const entries = [entry('0.30.0', today), entry('0.31.0', today), entry('0.32.0', today)];
    const result = filterVersionHistory(entries, '0.31.0');
    expect(result.map((e) => e.version)).toEqual(['0.31.0', '0.30.0']);
  });

  it('filters out entries older than 3 months', () => {
    const entries = [entry('0.28.0', sixMonthsAgo), entry('0.30.0', twoMonthsAgo)];
    const result = filterVersionHistory(entries, '0.30.0');
    expect(result.map((e) => e.version)).toEqual(['0.30.0']);
  });

  it('caps at 5 entries', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry(`0.${20 + i}.0`, today),
    );
    const result = filterVersionHistory(entries, '0.29.0');
    expect(result.length).toBe(5);
  });

  it('returns entries sorted newest-first', () => {
    const entries = [entry('0.28.0', today), entry('0.30.0', today), entry('0.29.0', today)];
    const result = filterVersionHistory(entries, '0.30.0');
    expect(result.map((e) => e.version)).toEqual(['0.30.0', '0.29.0', '0.28.0']);
  });

  it('returns empty array when no entries match', () => {
    const entries = [entry('0.32.0', today)];
    const result = filterVersionHistory(entries, '0.31.0');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(filterVersionHistory([], '1.0.0')).toEqual([]);
  });

  it('includes the current version itself', () => {
    const entries = [entry('0.31.0', today)];
    const result = filterVersionHistory(entries, '0.31.0');
    expect(result.map((e) => e.version)).toEqual(['0.31.0']);
  });

  it('handles prerelease versions correctly', () => {
    const entries = [entry('0.34.0-beta.1', today), entry('0.34.0', today)];
    const result = filterVersionHistory(entries, '0.34.0');
    // 0.34.0 stable is not newer than itself, and beta is not newer than stable
    expect(result.map((e) => e.version)).toEqual(['0.34.0', '0.34.0-beta.1']);
  });
});

// ---------------------------------------------------------------------------
// composeVersionHistoryMarkdown
// ---------------------------------------------------------------------------

describe('composeVersionHistoryMarkdown', () => {
  function entry(version: string, message: string, notes: string): VersionHistoryEntry {
    return { version, releaseDate: new Date().toISOString(), releaseMessage: message, releaseNotes: notes };
  }

  it('composes a single entry with H1 header and notes', () => {
    const md = composeVersionHistoryMarkdown([entry('0.30.0', 'Big Release', 'Bug fixes')]);
    expect(md).toBe('# Big Release\n\nBug fixes');
  });

  it('separates multiple entries with horizontal rules', () => {
    const entries = [
      entry('0.31.0', 'v0.31.0', 'New stuff'),
      entry('0.30.0', 'v0.30.0', 'Old stuff'),
    ];
    const md = composeVersionHistoryMarkdown(entries);
    expect(md).toBe('# v0.31.0\n\nNew stuff\n\n----\n\n# v0.30.0\n\nOld stuff');
  });

  it('uses version as fallback when releaseMessage is empty', () => {
    const entries = [{ version: '0.30.0', releaseDate: '', releaseMessage: '', releaseNotes: 'notes' }];
    const md = composeVersionHistoryMarkdown(entries);
    expect(md).toBe('# v0.30.0\n\nnotes');
  });

  it('handles entries with empty releaseNotes', () => {
    const entries = [{ version: '0.30.0', releaseDate: '', releaseMessage: 'Title', releaseNotes: '' }];
    const md = composeVersionHistoryMarkdown(entries);
    expect(md).toBe('# Title\n\n');
  });

  it('returns empty string for empty input', () => {
    expect(composeVersionHistoryMarkdown([])).toBe('');
  });
});
