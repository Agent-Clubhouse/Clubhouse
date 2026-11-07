import { beforeEach, describe, expect, it, vi } from 'vitest';

type RotationFile = { version: 1; cursors: Record<string, { key: string; at: number }> };

const W = vi.hoisted(() => ({
  /** What a running app holds. */
  memory: { version: 1, cursors: {} } as RotationFile,
  /** What a restart would read. */
  disk: { version: 1, cursors: {} } as RotationFile,
  saveFails: false,
  saves: 0,
  log: vi.fn(),
}));

vi.mock('./settings-store', () => ({
  createSettingsStore: () => {
    // Like the real store: loaded from disk once, then in memory first and written after.
    W.memory = JSON.parse(JSON.stringify(W.disk));
    return {
      get: () => W.memory,
      save: async (next: RotationFile) => {
        W.memory = next;
        W.saves++;
        if (W.saveFails) throw new Error('disk full');
        W.disk = JSON.parse(JSON.stringify(next));
      },
      update: async () => W.memory,
    };
  },
}));
vi.mock('./log-service', () => ({ appLog: W.log }));

type State = typeof import('./helper-auto-state');
let S: State;

const none = { live: new Set<string>(), notRunning: new Set<string>() };
const live = (...ids: string[]) => ({ live: new Set(ids), notRunning: new Set<string>() });
const stopped = (...ids: string[]) => ({ live: new Set<string>(), notRunning: new Set(ids) });

/** A fresh module, as after a restart: it reads whatever the disk has. */
async function restart(): Promise<State> {
  vi.resetModules();
  return import('./helper-auto-state');
}

beforeEach(async () => {
  W.disk = { version: 1, cursors: {} };
  W.saveFails = false;
  W.saves = 0;
  W.log.mockClear();
  S = await restart();
});

describe('reservations', () => {
  it('count once through creation, start, a count that misses the row, and the count that sees it live', () => {
    S.reserveAutoDecision('d1', { provider: 'claude-code', key: 'claude-code:default' });
    // Before the row exists.
    expect(S.reservedLoad(none)).toEqual({ 'claude-code': 1 });
    S.commitAutoDecision('d1', 'h1');
    expect(S.autoDecisionFor('h1')).toBe('d1');
    // The row counts it now, so the reservation doesn't.
    expect(S.reservedLoad(live('h1'))).toEqual({});
    S.settleAutoDecision('d1', 'started');
    // A count whose snapshot misses the row keeps counting it, as often as that happens.
    expect(S.reservedLoad(none)).toEqual({ 'claude-code': 1 });
    expect(S.reservedLoad(none)).toEqual({ 'claude-code': 1 });
    expect(S.reservationSummary()).toMatchObject({ held: 1, startedPending: 1 });
    // Seen live: reconciled, once. The row counts it from now on.
    expect(S.reservedLoad(live('h1'))).toEqual({});
    expect(S.autoDecisionFor('h1')).toBeUndefined();
    expect(S.reservedLoad(none)).toEqual({});
    expect(S.reservationSummary()).toEqual({ held: 0, startedPending: 0 });
  });

  it('a started helper seen not running is released: it ran and stopped', () => {
    S.reserveAutoDecision('d1', { provider: 'claude-code', key: 'claude-code:default' });
    S.commitAutoDecision('d1', 'h1');
    S.settleAutoDecision('d1', 'started');
    expect(S.reservedLoad(stopped('h1'))).toEqual({});
    expect(S.reservationSummary().held).toBe(0);
  });

  it('one still starting counts even if its row reads not running', () => {
    S.reserveAutoDecision('d1', { provider: 'claude-code', key: 'claude-code:default' });
    S.commitAutoDecision('d1', 'h1');
    expect(S.reservedLoad(stopped('h1'))).toEqual({ 'claude-code': 1 });
  });

  describe('a settle outside the lock, against a count\'s single pass', () => {
    // The count's pass reads statuses, then reservations, with nothing awaited between.
    // A settle is its own event-loop turn, so it lands before the pass or after it.
    const start = () => {
      S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' });
      S.commitAutoDecision('d1', 'h1');
    };

    it('started, settled before the pass: the pass sees it running and reconciles it', () => {
      start();
      S.settleAutoDecision('d1', 'started');
      expect(S.reservedLoad(live('h1'))).toEqual({});
      expect(S.reservedLoad(live('h1'))).toEqual({});
    });

    it('started, settled after the pass: the pass saw it starting, counted by its row only', () => {
      start();
      expect(S.reservedLoad(live('h1'))).toEqual({});
      S.settleAutoDecision('d1', 'started');
      expect(S.reservationSummary().startedPending).toBe(1);
    });

    it('failed, settled before the pass: the row reads failed and nothing counts it', () => {
      start();
      S.settleAutoDecision('d1', 'spawn_failed');
      expect(S.reservedLoad(stopped('h1'))).toEqual({});
    });

    it('failed, settled after the pass: the pass saw it starting, counted once by its row', () => {
      start();
      expect(S.reservedLoad(live('h1'))).toEqual({});
      S.settleAutoDecision('d1', 'spawn_failed');
      expect(S.reservedLoad(stopped('h1'))).toEqual({});
    });
  });

  it.each(['creation_refused', 'cancelled', 'spawn_failed', 'left_asleep'] as const)('%s releases at once', (result) => {
    S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' });
    if (result !== 'creation_refused') S.commitAutoDecision('d1', 'h1');
    S.settleAutoDecision('d1', result);
    expect(S.reservedLoad(none)).toEqual({});
  });

  it('started before it was committed is a refusal, not a held reservation', () => {
    S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' });
    S.settleAutoDecision('d1', 'started');
    expect(S.reservedLoad(none)).toEqual({});
  });

  it('a disposed helper releases what it held, started or not', () => {
    S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' });
    S.commitAutoDecision('d1', 'h1');
    S.settleAutoDecision('d1', 'started');
    S.forgetAutoHelper('h1');
    expect(S.reservedLoad(none)).toEqual({});
  });

  it('never expire: an unsettled one is kept and its age reported', () => {
    S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' }, 1_000);
    expect(S.reservationSummary(1_000 + 3_600_000)).toEqual({ held: 1, startedPending: 0, oldestAgeMs: 3_600_000 });
    expect(S.reservedLoad(none)).toEqual({ 'codex-cli': 1 });
  });

  it('commit twice, settle after release: nothing changes the second time', () => {
    S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default', rotation: { cursorKey: 's', key: 'codex-cli:default' } });
    S.commitAutoDecision('d1', 'h1');
    S.commitAutoDecision('d1', 'h2');
    expect(S.autoDecisionFor('h1')).toBe('d1');
    expect(W.saves).toBe(1);
    S.settleAutoDecision('d1', 'spawn_failed');
    S.settleAutoDecision('d1', 'started');
    expect(S.reservedLoad(none)).toEqual({});
  });

  it('a restart holds none', async () => {
    S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default' });
    S = await restart();
    expect(S.reservedLoad(none)).toEqual({});
  });
});

describe('rotation', () => {
  const take = (state: State, id: string, key: string) => {
    state.reserveAutoDecision(id, { provider: key.split(':')[0], key, rotation: { cursorKey: 's', key } });
    state.commitAutoDecision(id, `h-${id}`);
  };

  it('moves only when a decision commits', () => {
    S.reserveAutoDecision('d1', { provider: 'codex-cli', key: 'codex-cli:default', rotation: { cursorKey: 's', key: 'codex-cli:default' } });
    expect(S.rotationCursors()).toEqual({});
    S.settleAutoDecision('d1', 'creation_refused');
    expect(S.rotationCursors()).toEqual({});
    expect(W.saves).toBe(0);
    take(S, 'd2', 'codex-cli:default');
    expect(S.rotationCursors()).toEqual({ s: 'codex-cli:default' });
  });

  it('a saved rotation survives a restart', async () => {
    take(S, 'd1', 'codex-cli:default');
    await vi.waitFor(() => expect(W.disk.cursors.s?.key).toBe('codex-cli:default'));
    S = await restart();
    expect(S.rotationCursors()).toEqual({ s: 'codex-cli:default' });
  });

  it('repeated failed saves: this run stays exact from memory, a restart gets the last saved one, and says so', async () => {
    take(S, 'd1', 'claude-code:default');
    await vi.waitFor(() => expect(W.disk.cursors.s?.key).toBe('claude-code:default'));
    W.saveFails = true;
    take(S, 'd2', 'codex-cli:default');
    take(S, 'd3', 'claude-code:default');
    take(S, 'd4', 'codex-cli:default');
    expect(S.rotationCursors()).toEqual({ s: 'codex-cli:default' });
    await vi.waitFor(() => expect(W.log).toHaveBeenCalledTimes(3));
    expect(W.log).toHaveBeenCalledWith('core:mcp', 'warn', 'Auto: could not save the rotation', expect.anything());
    S = await restart();
    // Older history, not the latest: the bound on what this costs is in the replay tests.
    expect(S.rotationCursors()).toEqual({ s: 'claude-code:default' });
  });

  it('keeps the most recent sets when there are too many', () => {
    for (let i = 0; i <= S.AUTO_MAX_ROTATION_CURSORS; i++) {
      S.reserveAutoDecision(`d${i}`, { provider: 'codex-cli', key: 'k', rotation: { cursorKey: `s${i}`, key: 'k' } });
      S.commitAutoDecision(`d${i}`, `h${i}`, 1_000 + i);
    }
    const kept = Object.keys(S.rotationCursors());
    expect(kept).toHaveLength(S.AUTO_MAX_ROTATION_CURSORS);
    expect(kept).not.toContain('s0');
  });
});
