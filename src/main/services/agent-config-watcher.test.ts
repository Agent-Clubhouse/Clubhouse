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

import {
  AGENTS_FILE_CHECK_INTERVAL_MS,
  clearAgentConfigCache,
  flushAgentConfig,
  listDurable,
  onAgentConfigChanged,
  renameDurable,
} from './agent-config';

type Listener = (eventType: string, filename: string) => void;

let projectPath = '';
let agentsFile = '';
const watchers: Array<{ fire: Listener; close: ReturnType<typeof vi.fn>; emitter: EventEmitter }> = [];

const agent = (name: string) => ({ id: 'durable_watch_1', name, color: 'indigo', createdAt: '2026-01-01T00:00:00.000Z' });
const saveByHand = (name: string) => fs.writeFileSync(agentsFile, JSON.stringify([agent(name)], null, 2));
const shownName = async () => (await listDurable(projectPath))[0]?.name;

/** Let the async file checks started by a timer finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

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

describe('agents.json watcher (#2729)', () => {
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

  it('starts a new watcher after the old one fails', async () => {
    expect(await shownName()).toBe('first');
    watchers[0].emitter.emit('error', new Error('watch failed'));
    expect(watchers[0].close).toHaveBeenCalledOnce();

    // The next write arms a new one, and that one reports edits.
    await renameDurable(projectPath, 'durable_watch_1', 'renamed-in-app');
    await flushAgentConfig(projectPath);
    expect(watchers).toHaveLength(2);
    saveByHand('after-error');
    watchers[1].fire('change', 'agents.json');
    expect(await shownName()).toBe('after-error');
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
