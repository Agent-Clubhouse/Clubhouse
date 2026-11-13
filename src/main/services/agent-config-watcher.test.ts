/**
 * The agents.json watcher stays open across its own events (#2729), and a
 * low-rate check of the file catches an edit whose watcher event never comes.
 * Real files in a temp folder; the watcher itself is a fake, because macOS
 * delivers real fs.watch events late or not at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, default: actual, watch: vi.fn() };
});
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./settings-audit', async (original) => ({
  ...await original<typeof import('./settings-audit')>(),
  auditChanges: vi.fn(),
}));
/** A slow disk: every stat takes this long, as on a busy CI runner. */
const slow = vi.hoisted(() => ({ statMs: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    if (slow.statMs > 0) await new Promise((resolve) => setTimeout(resolve, slow.statMs));
    return actual.stat(...args);
  }) as typeof actual.stat;
  return { ...actual, default: { ...actual, stat }, stat };
});

import {
  AGENTS_FILE_CHECK_INTERVAL_MS,
  clearAgentConfigCache,
  flushAgentConfig,
  listDurable,
  onAgentConfigChanged,
  renameDurable,
  settleAgentsFileChecksForTests,
  setOrchestrationConfig,
  setManagedSetup,
  withDurableCreationGit,
} from './agent-config';

type Listener = (eventType: string, filename: string) => void;

let projectPath = '';
let agentsFile = '';
const watchers: Array<{ fire: Listener; close: ReturnType<typeof vi.fn>; emitter: EventEmitter }> = [];

const agent = (name: string) => ({ id: 'durable_watch_1', name, color: 'indigo', createdAt: '2026-01-01T00:00:00.000Z' });
const saveByHand = (name: string) => fs.writeFileSync(agentsFile, JSON.stringify([agent(name)], null, 2));
const shownName = async () => (await listDurable(projectPath))[0]?.name;

/** Wait for every look at agents.json in flight (the first look, a check, a refresh) to finish. */
const settle = () => settleAgentsFileChecksForTests();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-watcher-'));
  fs.mkdirSync(path.join(projectPath, '.clubhouse'));
  agentsFile = path.join(projectPath, '.clubhouse', 'agents.json');
  saveByHand('first');
  watchers.length = 0;
  vi.mocked(fs.watch).mockImplementation(((_dir: string, listener: Listener) => {
    const emitter = new EventEmitter();
    const close = vi.fn();
    watchers.push({ fire: listener, close, emitter });
    return Object.assign(emitter, { close });
  }) as unknown as typeof fs.watch);
});

afterEach(() => {
  clearAgentConfigCache();
  vi.useRealTimers();
  fs.rmSync(projectPath, { recursive: true, force: true });
});

// Once with stat as fast as the disk, and once slow, so no test leans on how long a look takes.
describe.each([0, 25])('agents.json watcher (#2729), stat taking %i ms extra', (statMs) => {
  beforeEach(() => { slow.statMs = statMs; });
  afterEach(() => { slow.statMs = 0; });

  it.each(['policy', 'managed setup'] as const)('persists imported %s when authority preparation invalidates the clean cache', async (setting) => {
    await listDurable(projectPath);
    let invalidated = false;
    await withDurableCreationGit({
      assertCurrent: async () => {
        if (invalidated) return;
        invalidated = true;
        watchers[0].fire('change', 'agents.json');
      },
      assertConsent: () => {},
      assertFilesystem: () => {},
      operation: { importId: 'import', requestId: 'request', key: 'creation', state: 'completed' },
      run: vi.fn(),
      preserveOnFailure: true,
    }, () => setting === 'policy'
      ? setOrchestrationConfig(projectPath, agent('first').id, { connectToDispatcher: true })
      : setManagedSetup(projectPath, agent('first').id, { version: 1, blocks: ['owned-block'], skills: [], mcps: [] }));

    expect(invalidated).toBe(true);
    const expected = setting === 'policy'
      ? { orchestration: { connectToDispatcher: true } }
      : { managed: { version: 1, blocks: ['owned-block'] } };
    expect(JSON.parse(fs.readFileSync(agentsFile, 'utf8'))[0]).toMatchObject(expected);
    clearAgentConfigCache(projectPath);
    expect((await listDurable(projectPath))[0]).toMatchObject(expected);
    await settle();
  });

  it('stays open across its own events, so a second hand edit is still seen', async () => {
    expect(await shownName()).toBe('first');
    expect(fs.watch).toHaveBeenCalledWith(path.join(projectPath, '.clubhouse'), expect.any(Function));
    expect(watchers).toHaveLength(1);

    saveByHand('second');
    watchers[0].fire('change', 'agents.json');
    expect(await shownName()).toBe('second');

    saveByHand('third');
    watchers[0].fire('change', 'agents.json');
    expect(await shownName()).toBe('third');

    // One watcher the whole time: none was closed and reopened.
    expect(watchers).toHaveLength(1);
    expect(watchers[0].close).not.toHaveBeenCalled();
  });

  it('sees an edit whose watcher event never arrives', async () => {
    expect(await shownName()).toBe('first');
    await settle(); // the first look at the file
    const changed = vi.fn();
    const off = onAgentConfigChanged(changed);
    try {
      // Nothing changed yet, so a check reports nothing.
      vi.advanceTimersByTime(AGENTS_FILE_CHECK_INTERVAL_MS);
      await settle();
      expect(changed).not.toHaveBeenCalled();

      // A different size, so the change shows even where mtime is coarse.
      saveByHand('edited-with-no-event');
      vi.advanceTimersByTime(AGENTS_FILE_CHECK_INTERVAL_MS);
      await settle();
      expect(changed).toHaveBeenCalledWith(projectPath);
      expect(await shownName()).toBe('edited-with-no-event');

      // Seen once, not again on every check.
      changed.mockClear();
      vi.advanceTimersByTime(AGENTS_FILE_CHECK_INTERVAL_MS);
      await settle();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('does not report the app\'s own event-reported edit a second time', async () => {
    expect(await shownName()).toBe('first');
    await settle();
    const changed = vi.fn();
    const off = onAgentConfigChanged(changed);
    try {
      saveByHand('reported');
      watchers[0].fire('change', 'agents.json');
      expect(changed).toHaveBeenCalledTimes(1);
      await settle(); // the watcher's event refreshes what the check compares against

      vi.advanceTimersByTime(AGENTS_FILE_CHECK_INTERVAL_MS);
      await settle();
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('keeps checking an idle project after the watcher fails, and the next read opens a new one', async () => {
    expect(await shownName()).toBe('first');
    await settle(); // the first look at the file
    watchers[0].emitter.emit('error', new Error('watch failed'));
    expect(watchers[0].close).toHaveBeenCalledOnce();

    const changed = vi.fn();
    const off = onAgentConfigChanged(changed);
    try {
      // Nothing reads or writes, and the hand edit is still seen.
      saveByHand('edited-while-idle');
      vi.advanceTimersByTime(AGENTS_FILE_CHECK_INTERVAL_MS);
      await settle();
      expect(changed).toHaveBeenCalledWith(projectPath);
    } finally {
      off();
    }

    // The next read opens a new watcher, and that one reports edits.
    expect(await shownName()).toBe('edited-while-idle');
    expect(watchers).toHaveLength(2);
    saveByHand('after-error');
    watchers[1].fire('change', 'agents.json');
    expect(await shownName()).toBe('after-error');
  });

  it('opens a new watcher on the next read after a failure, even with no edit', async () => {
    expect(await shownName()).toBe('first');
    watchers[0].emitter.emit('error', new Error('watch failed'));
    // The clean cache entry was dropped, so this read reloads and re-arms.
    expect(await shownName()).toBe('first');
    expect(watchers).toHaveLength(2);
    expect(watchers[1].close).not.toHaveBeenCalled();
  });

  it('opens a new watcher on the next write after a failure', async () => {
    expect(await shownName()).toBe('first');
    watchers[0].emitter.emit('error', new Error('watch failed'));
    await renameDurable(projectPath, 'durable_watch_1', 'renamed-in-app');
    await flushAgentConfig(projectPath);
    expect(watchers).toHaveLength(2);
    saveByHand('after-write');
    watchers[1].fire('change', 'agents.json');
    expect(await shownName()).toBe('after-write');
  });

  it('closes the watcher and its check when the cache is cleared', async () => {
    expect(await shownName()).toBe('first');
    clearAgentConfigCache(projectPath);
    expect(watchers[0].close).toHaveBeenCalledOnce();
    // Its check stopped too: a change now reports nothing.
    const changed = vi.fn();
    const off = onAgentConfigChanged(changed);
    try {
      saveByHand('after-clear');
      vi.advanceTimersByTime(AGENTS_FILE_CHECK_INTERVAL_MS * 2);
      await settle();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});
