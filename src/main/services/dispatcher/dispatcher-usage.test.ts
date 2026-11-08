import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/base' }));

import { _resetDispatcherUsageForTesting, readDispatcherUsage, setBackgroundUsageSource, type UsageSessionStore } from './dispatcher-usage';
import { describeUsage, formatTokenCount } from '../../../shared/dispatcher-settings-page';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** A provider's store: sessions per folder, and their totals. */
function store(sessions: Record<string, Array<{ id: string; ago: number; input: number; output: number }>>): UsageSessionStore {
  return {
    listSessions: async (cwd) => (sessions[cwd] ?? []).map((s) => ({ sessionId: s.id, lastActiveAt: iso(s.ago) })),
    readTotals: async (id, cwd) => {
      const s = (sessions[cwd] ?? []).find((x) => x.id === id);
      return s ? { inputTokens: s.input, outputTokens: s.output } : null;
    },
  };
}

const folders = () => ['/base/dispatcher', '/base/dispatcher-chat'];

beforeEach(() => _resetDispatcherUsageForTesting());

describe('the Dispatcher\'s usage (#3046)', () => {
  it('sums both agents\' recent sessions on every provider, and leaves out older ones', async () => {
    const claude = store({
      '/base/dispatcher': [{ id: 'c1', ago: DAY, input: 1000, output: 100 }, { id: 'old', ago: 8 * DAY, input: 9e6, output: 9e6 }],
      '/base/dispatcher-chat': [{ id: 'c2', ago: 2 * DAY, input: 500, output: 50 }],
    });
    // The provider it ran on before a switch still counts.
    const codex = store({ '/base/dispatcher-chat': [{ id: 'x1', ago: 3 * DAY, input: 200, output: 20 }] });
    const usage = await readDispatcherUsage({ now: () => NOW, folders, stores: () => [claude, codex], background: null });
    expect(usage).toEqual({ conversations: { inputTokens: 1700, outputTokens: 170, sessions: 3 }, background: null, readAt: NOW });
  });

  it('a provider or transcript that can\'t be read counts nothing', async () => {
    const broken: UsageSessionStore = { listSessions: async () => { throw new Error('no store'); }, readTotals: async () => null };
    const flaky: UsageSessionStore = {
      listSessions: async () => [{ sessionId: 'a', lastActiveAt: iso(DAY) }, { sessionId: 'b', lastActiveAt: iso(DAY) }, { sessionId: 'c', lastActiveAt: 'not a date' }],
      readTotals: async (id) => { if (id === 'a') throw new Error('bad'); return { inputTokens: 10, outputTokens: 1 }; },
    };
    const usage = await readDispatcherUsage({ now: () => NOW, folders: () => ['/f'], stores: () => [broken, flaky], background: null });
    expect(usage.conversations).toEqual({ inputTokens: 10, outputTokens: 1, sessions: 1 });
  });

  it('splits out background work once it reports its share', async () => {
    const claude = store({ '/base/dispatcher': [{ id: 'c1', ago: DAY, input: 1000, output: 100 }, { id: 'c2', ago: DAY, input: 400, output: 40 }] });
    const background = vi.fn(async () => ({ inputTokens: 400, outputTokens: 40, sessions: 1 }));
    const usage = await readDispatcherUsage({ now: () => NOW, folders, stores: () => [claude], background });
    expect(background).toHaveBeenCalledWith(NOW - 7 * DAY);
    expect(usage.conversations).toEqual({ inputTokens: 1000, outputTokens: 100, sessions: 1 });
    expect(usage.background).toEqual({ inputTokens: 400, outputTokens: 40, sessions: 1 });

    // A failing source shows conversations only, as before it existed.
    const failing = await readDispatcherUsage({ now: () => NOW, folders, stores: () => [claude], background: async () => { throw new Error('x'); } });
    expect(failing.background).toBeNull();
    expect(failing.conversations.sessions).toBe(2);
  });

  it('uses the registered background source', async () => {
    setBackgroundUsageSource(async () => ({ inputTokens: 1, outputTokens: 1, sessions: 1 }));
    const usage = await readDispatcherUsage({ now: () => NOW, folders, stores: () => [] });
    expect(usage.background).toEqual({ inputTokens: 1, outputTokens: 1, sessions: 1 });
    expect(usage.conversations).toEqual({ inputTokens: 0, outputTokens: 0, sessions: 0 });
  });

  it('formats a share of usage in plain words', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(48_200)).toBe('48K');
    expect(formatTokenCount(1_200)).toBe('1.2K');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(describeUsage({ inputTokens: 0, outputTokens: 0, sessions: 0 })).toBe('None yet');
    expect(describeUsage({ inputTokens: 1_200_000, outputTokens: 48_000, sessions: 1 })).toBe('1 session, 1.2M tokens in and 48K out');
    expect(describeUsage({ inputTokens: 900, outputTokens: 12, sessions: 3 })).toBe('3 sessions, 900 tokens in and 12 out');
  });
});
