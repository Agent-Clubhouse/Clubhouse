import { describe, it, expect } from 'vitest';
import { computeCatalogDiff } from './wrapper-diff';
import type { McpCatalogEntry, WrapperCatalogSnapshot } from './types';

const e = (id: string, desc = id): McpCatalogEntry => ({ id, name: id, description: desc });
const snap = (entries: McpCatalogEntry[]): WrapperCatalogSnapshot => ({
  lastSeenCatalog: entries,
  lastSeenAt: '2026-05-07T00:00:00.000Z',
});

describe('computeCatalogDiff', () => {
  it('marks new entries when no snapshot', () => {
    const diff = computeCatalogDiff([e('a'), e('b')], undefined, [], []);
    expect(diff.find((d) => d.id === 'a')!.state).toBe('new');
    expect(diff.find((d) => d.id === 'b')!.state).toBe('new');
  });

  it('marks unchanged entries stable', () => {
    const diff = computeCatalogDiff([e('a')], snap([e('a')]), [], []);
    expect(diff[0].state).toBe('stable');
  });

  it('marks changed entries when description differs', () => {
    const diff = computeCatalogDiff([e('a', 'new')], snap([e('a', 'old')]), [], []);
    expect(diff[0].state).toBe('changed');
  });

  it('marks changed entries when name differs (description same)', () => {
    const oldEntry: McpCatalogEntry = { id: 'a', name: 'Old Name', description: 'desc' };
    const newEntry: McpCatalogEntry = { id: 'a', name: 'New Name', description: 'desc' };
    const diff = computeCatalogDiff([newEntry], snap([oldEntry]), [], []);
    expect(diff[0].state).toBe('changed');
  });

  it('appends removed entries when in selection but not in current', () => {
    const diff = computeCatalogDiff([e('a')], snap([e('a'), e('gone')]), ['gone'], []);
    expect(diff.find((d) => d.id === 'gone')!.state).toBe('removed');
  });

  it('does not append removed entries that are not in any selection', () => {
    const diff = computeCatalogDiff([e('a')], snap([e('a'), e('gone')]), [], []);
    expect(diff.find((d) => d.id === 'gone')).toBeUndefined();
  });

  it('preserves catalog order; appends removed at end', () => {
    const diff = computeCatalogDiff([e('b'), e('a')], snap([e('a'), e('b'), e('gone')]), ['gone'], []);
    expect(diff.map((d) => d.id)).toEqual(['b', 'a', 'gone']);
  });

  it('dedupes duplicate ids in current (last wins)', () => {
    const first: McpCatalogEntry = { id: 'dup', name: 'first', description: 'first' };
    const second: McpCatalogEntry = { id: 'dup', name: 'second', description: 'second' };
    const diff = computeCatalogDiff([first, second], undefined, [], []);
    expect(diff).toHaveLength(1);
    expect(diff[0].name).toBe('second');
    expect(diff[0].description).toBe('second');
  });

  it('returns empty when current and snapshot both empty', () => {
    const diff = computeCatalogDiff([], undefined, [], []);
    expect(diff).toEqual([]);
  });

  it('returns all-removed for empty current with selected ids in snapshot', () => {
    const diff = computeCatalogDiff([], snap([e('gone1'), e('gone2')]), ['gone1'], ['gone2']);
    expect(diff.map((d) => d.state)).toEqual(['removed', 'removed']);
  });

  it('does not double-append when removed id is in both projectDefaults and anyAgentMcpIds', () => {
    const diff = computeCatalogDiff([], snap([e('gone')]), ['gone'], ['gone']);
    expect(diff).toHaveLength(1);
  });

  it('marks entry changed when args differ', () => {
    const oldEntry: McpCatalogEntry = { id: 'x', name: 'X', description: 'desc', args: [{ name: '--org', required: false }] };
    const newEntry: McpCatalogEntry = { id: 'x', name: 'X', description: 'desc', args: [{ name: '--org', required: false }, { name: '--scope', required: false }] };
    const diff = computeCatalogDiff([newEntry], snap([oldEntry]), [], []);
    expect(diff[0].state).toBe('changed');
  });

  it('marks stable when args are identical', () => {
    const entry: McpCatalogEntry = { id: 'x', name: 'X', description: 'desc', args: [{ name: '--org', required: false }] };
    const diff = computeCatalogDiff([entry], snap([entry]), [], []);
    expect(diff[0].state).toBe('stable');
  });

  it('marks changed when args added to previously zero-config MCP', () => {
    const oldEntry: McpCatalogEntry = { id: 'x', name: 'X', description: 'desc' };
    const newEntry: McpCatalogEntry = { id: 'x', name: 'X', description: 'desc', args: [{ name: '--tenant', required: true }] };
    const diff = computeCatalogDiff([newEntry], snap([oldEntry]), [], []);
    expect(diff[0].state).toBe('changed');
  });

  it('marks stable when both entries have no args', () => {
    const entry: McpCatalogEntry = { id: 'teams', name: 'Teams', description: 'desc' };
    const diff = computeCatalogDiff([entry], snap([entry]), [], []);
    expect(diff[0].state).toBe('stable');
  });
});
