import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterVersionHistory, composeVersionHistoryMarkdown } from './auto-update-service';
import type { VersionHistoryEntry } from '../../shared/types';

function makeEntry(version: string, releaseDate: string, releaseMessage: string, releaseNotes: string): VersionHistoryEntry {
  return { version, releaseDate, releaseMessage, releaseNotes };
}

describe('version history', () => {
  describe('filterVersionHistory', () => {
    const now = new Date();
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(now.getMonth() - 1);
    const twoMonthsAgo = new Date(now);
    twoMonthsAgo.setMonth(now.getMonth() - 2);
    const fourMonthsAgo = new Date(now);
    fourMonthsAgo.setMonth(now.getMonth() - 4);

    const entries: VersionHistoryEntry[] = [
      makeEntry('0.30.0', now.toISOString(), 'Future Release', '## Future stuff'),
      makeEntry('0.29.0', now.toISOString(), 'Latest Release', '## New features\n- Feature A'),
      makeEntry('0.28.0', oneMonthAgo.toISOString(), 'Previous Release', '## Bug fixes\n- Fix B'),
      makeEntry('0.27.0', twoMonthsAgo.toISOString(), 'Older Release', '## Improvements\n- Improve C'),
      makeEntry('0.26.0', fourMonthsAgo.toISOString(), 'Ancient Release', '## Old stuff'),
    ];

    it('excludes versions newer than current version', () => {
      const result = filterVersionHistory(entries, '0.29.0');
      expect(result.find((e) => e.version === '0.30.0')).toBeUndefined();
      expect(result.find((e) => e.version === '0.29.0')).toBeDefined();
    });

    it('includes current version and older', () => {
      const result = filterVersionHistory(entries, '0.29.0');
      expect(result.map((e) => e.version)).toContain('0.29.0');
      expect(result.map((e) => e.version)).toContain('0.28.0');
      expect(result.map((e) => e.version)).toContain('0.27.0');
    });

    it('excludes entries older than 3 months', () => {
      const result = filterVersionHistory(entries, '0.29.0');
      expect(result.find((e) => e.version === '0.26.0')).toBeUndefined();
    });

    it('returns newest first', () => {
      const result = filterVersionHistory(entries, '0.29.0');
      const versions = result.map((e) => e.version);
      expect(versions[0]).toBe('0.29.0');
      expect(versions[1]).toBe('0.28.0');
      expect(versions[2]).toBe('0.27.0');
    });

    it('caps at 5 entries', () => {
      const manyEntries: VersionHistoryEntry[] = [];
      for (let i = 0; i < 10; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        manyEntries.push(makeEntry(`0.${30 - i}.0`, date.toISOString(), `Release ${i}`, `Notes ${i}`));
      }
      const result = filterVersionHistory(manyEntries, '0.30.0');
      expect(result.length).toBeLessThanOrEqual(5);
    });

    it('returns empty for no matching entries', () => {
      const result = filterVersionHistory(entries, '0.1.0');
      expect(result).toHaveLength(0);
    });

    it('handles empty input', () => {
      const result = filterVersionHistory([], '0.29.0');
      expect(result).toHaveLength(0);
    });

    it('includes entry when version equals current version', () => {
      const result = filterVersionHistory(
        [makeEntry('0.29.0', now.toISOString(), 'Current', 'Notes')],
        '0.29.0',
      );
      expect(result).toHaveLength(1);
      expect(result[0].version).toBe('0.29.0');
    });
  });

  describe('composeVersionHistoryMarkdown', () => {
    it('formats single entry correctly', () => {
      const entries: VersionHistoryEntry[] = [
        makeEntry('0.29.0', new Date().toISOString(), 'Great Release', '## New Features\n- Added widget'),
      ];
      const md = composeVersionHistoryMarkdown(entries);
      expect(md).toContain('# Great Release');
      expect(md).toContain('## New Features');
      expect(md).toContain('- Added widget');
      expect(md).not.toContain('----');
    });

    it('separates multiple entries with horizontal rules', () => {
      const entries: VersionHistoryEntry[] = [
        makeEntry('0.29.0', new Date().toISOString(), 'Release A', 'Notes A'),
        makeEntry('0.28.0', new Date().toISOString(), 'Release B', 'Notes B'),
      ];
      const md = composeVersionHistoryMarkdown(entries);
      expect(md).toContain('# Release A');
      expect(md).toContain('# Release B');
      expect(md).toContain('----');
    });

    it('uses version as fallback title when no release message', () => {
      const entries: VersionHistoryEntry[] = [
        makeEntry('0.29.0', new Date().toISOString(), '', 'Some notes'),
      ];
      const md = composeVersionHistoryMarkdown(entries);
      expect(md).toContain('# v0.29.0');
    });

    it('returns empty string for empty entries', () => {
      const md = composeVersionHistoryMarkdown([]);
      expect(md).toBe('');
    });

    it('preserves release notes markdown formatting', () => {
      const entries: VersionHistoryEntry[] = [
        makeEntry('0.29.0', new Date().toISOString(), 'Title', '## Heading\n\n- **Bold** item\n- `code` item'),
      ];
      const md = composeVersionHistoryMarkdown(entries);
      expect(md).toContain('## Heading');
      expect(md).toContain('**Bold**');
      expect(md).toContain('`code`');
    });

    it('produces correct structure for three entries', () => {
      const entries: VersionHistoryEntry[] = [
        makeEntry('0.29.0', new Date().toISOString(), 'Third', 'Notes 3'),
        makeEntry('0.28.0', new Date().toISOString(), 'Second', 'Notes 2'),
        makeEntry('0.27.0', new Date().toISOString(), 'First', 'Notes 1'),
      ];
      const md = composeVersionHistoryMarkdown(entries);
      const sections = md.split('----');
      expect(sections).toHaveLength(3);
      expect(sections[0]).toContain('# Third');
      expect(sections[1]).toContain('# Second');
      expect(sections[2]).toContain('# First');
    });
  });
});
