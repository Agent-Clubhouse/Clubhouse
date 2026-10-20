/**
 * pty-headless-terminal against a real headless xterm: sizing, seq-tagged
 * snapshots, and reset (#2324, #2325).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ensure, feedData, getSize, reset, snapshot, dispose, disposeAll } from './pty-headless-terminal';

describe('pty-headless-terminal snapshots', () => {
  afterEach(() => disposeAll());

  it('creates the terminal at the size passed to ensure', () => {
    ensure('a', { cols: 80, rows: 24 });
    expect(getSize('a')).toEqual({ cols: 80, rows: 24 });
  });

  it('leaves an existing terminal alone in ensure, and says whether it created one', () => {
    expect(ensure('a', { cols: 80, rows: 24 })).toBe(true);
    expect(ensure('a', { cols: 132, rows: 50 })).toBe(false);
    expect(getSize('a')).toEqual({ cols: 80, rows: 24 });
  });

  it('defaults to 120x30 when created by feedData', () => {
    feedData('a', 'x');
    expect(getSize('a')).toEqual({ cols: 120, rows: 30 });
  });

  it('includes everything fed before the call, even if not parsed yet', async () => {
    feedData('a', 'x'.repeat(100_000), 100_000);
    feedData('a', '\r\nend', 100_005);
    const snap = await snapshot('a');
    expect(snap?.data.endsWith('end')).toBe(true);
    expect(snap?.seq).toBe(100_005);
  });

  it('matches its seq when more output is fed while it waits', async () => {
    feedData('a', 'first', 5);
    const pending = snapshot('a');
    feedData('a', ' second', 12);
    expect(await pending).toEqual({ data: 'first', seq: 5 });
    expect(await snapshot('a')).toEqual({ data: 'first second', seq: 12 });
  });

  it('resolves to null without a terminal', async () => {
    expect(await snapshot('missing')).toBeNull();
  });

  it('reset empties the terminal and keeps its size unless given one', async () => {
    ensure('a', { cols: 80, rows: 24 });
    feedData('a', 'old', 3);
    reset('a');
    expect(getSize('a')).toEqual({ cols: 80, rows: 24 });
    feedData('a', 'new', 6);
    expect(await snapshot('a')).toEqual({ data: 'new', seq: 6 });

    reset('a', { cols: 100, rows: 30 });
    expect(getSize('a')).toEqual({ cols: 100, rows: 30 });
  });

  it('settles a pending snapshot on the replacement when reset mid-parse', async () => {
    feedData('a', 'x'.repeat(100_000), 100_000);
    const pending = snapshot('a');
    reset('a');
    feedData('a', 'fresh', 100_005);
    expect(await pending).toEqual({ data: 'fresh', seq: 100_005 });
  });

  it('settles a pending snapshot with null when disposed mid-parse', async () => {
    feedData('a', 'x'.repeat(100_000), 100_000);
    const pending = snapshot('a');
    dispose('a');
    expect(await pending).toBeNull();
  });
});
