import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  debug: false,
  unreadable: false,
  base: '',
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(ch, fn); }) },
}));
vi.mock('../services/experimental-settings', () => ({
  getSettings: () => (h.debug ? { dispatcherDebug: true } : {}),
  savedSettingsUnreadable: () => h.unreadable,
}));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../services/dispatcher/dispatcher-service', () => ({
  getDispatcherState: () => ({ config: { id: 'work', orchestrator: 'claude-code' } }),
  getDispatcherChatConfig: () => null,
  defaultDispatcherOrchestrator: () => 'claude-code',
}));
vi.mock('../services/dispatcher/dispatcher-paths', async () => {
  const p = await vi.importActual<typeof import('path')>('path');
  return {
    getDispatcherPath: () => p.join(h.base, 'dispatcher'),
    getDispatcherChatPath: () => p.join(h.base, 'dispatcher-chat'),
    getDispatcherMemoryPath: () => p.join(h.base, 'dispatcher', 'memory'),
  };
});
vi.mock('../orchestrators', async () => {
  const p = await vi.importActual<typeof import('path')>('path');
  return {
    getAllProviders: () => [
      { id: 'claude-code', instructionsPathOf: (d: string) => p.join(d, 'CLAUDE.md'), conventions: { configDir: '.claude', skillsDir: 'skills' } },
      { id: 'codex-cli', instructionsPathOf: (d: string) => p.join(d, 'AGENTS.md'), conventions: { configDir: '.codex', skillsDir: 'skills', skillsRoot: '.agents/skills' } },
    ],
  };
});

import { IPC } from '../../shared/ipc-channels';
import { appLog } from '../services/log-service';
import { registerDispatcherInspectorHandlers } from './dispatcher-inspector-handlers';

const CHANNELS: Array<[string, unknown[]]> = [
  [IPC.DISPATCHER.INSPECT_INSTRUCTIONS, []],
  [IPC.DISPATCHER.INSPECT_SKILLS, []],
  [IPC.DISPATCHER.INSPECT_SKILL, ['work', 'check-ins']],
  [IPC.DISPATCHER.INSPECT_MEMORY_INDEX, []],
  [IPC.DISPATCHER.INSPECT_MEMORY_PAGE, ['topics/secret.md']],
  [IPC.DISPATCHER.INSPECT_MEMORY_ACCESS, []],
];

const SECRET = 'private memory text';

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(h.handlers.get(channel)!({}, ...args));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.debug = false;
  h.unreadable = false;
  h.base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-inspector-ipc-')));
  const work = path.join(h.base, 'dispatcher');
  fs.mkdirSync(path.join(work, 'memory', 'topics'), { recursive: true });
  fs.mkdirSync(path.join(work, '.claude', 'skills', 'check-ins'), { recursive: true });
  fs.mkdirSync(path.join(h.base, 'dispatcher-chat'));
  fs.writeFileSync(path.join(work, 'CLAUDE.md'), SECRET);
  fs.writeFileSync(path.join(work, '.claude', 'skills', 'check-ins', 'SKILL.md'), SECRET);
  fs.writeFileSync(path.join(work, 'memory', 'index.md'), SECRET);
  fs.writeFileSync(path.join(work, 'memory', 'topics', 'secret.md'), SECRET);
  fs.writeFileSync(path.join(work, 'memory-access.json'), JSON.stringify({ version: 1, pages: { 'topics/secret.md': { reads: 1, writes: 0, lastRead: 5 } } }));
  registerDispatcherInspectorHandlers();
});

afterEach(() => {
  fs.rmSync(h.base, { recursive: true, force: true });
});

describe('Dispatcher inspector IPC', () => {
  it('registers every channel', () => {
    expect([...h.handlers.keys()].sort()).toEqual(CHANNELS.map(([c]) => c).sort());
  });

  it.each(CHANNELS)('%s refuses with debug off, before looking at its arguments', async (channel, args) => {
    await expect(call(channel, ...args)).rejects.toThrow('dispatcher_inspector:debug_off');
    await expect(call(channel, { bad: true }, 7)).rejects.toThrow('dispatcher_inspector:debug_off');
  });

  it.each(CHANNELS)('%s refuses while the settings file cannot be read', async (channel, args) => {
    h.debug = true;
    h.unreadable = true;
    await expect(call(channel, ...args)).rejects.toThrow('dispatcher_inspector:debug_off');
  });

  it('answers with debug on', async () => {
    h.debug = true;
    const instructions = await call(IPC.DISPATCHER.INSPECT_INSTRUCTIONS) as { active: unknown; files: Array<{ provider: string; role: string; active: boolean; content?: string }> };
    expect(instructions.active).toEqual({ work: 'claude-code', chat: null });
    expect(instructions.files.find((f) => f.role === 'work' && f.provider === 'claude-code')).toMatchObject({ active: true, content: SECRET });
    expect(instructions.files.find((f) => f.role === 'work' && f.provider === 'codex-cli')).toMatchObject({ active: false, exists: false });
    await expect(call(IPC.DISPATCHER.INSPECT_SKILL, 'work', 'check-ins')).resolves.toMatchObject({ content: SECRET });
    await expect(call(IPC.DISPATCHER.INSPECT_MEMORY_PAGE, 'topics/secret.md')).resolves.toMatchObject({ text: SECRET });
    await expect(call(IPC.DISPATCHER.INSPECT_MEMORY_ACCESS)).resolves.toMatchObject({ total: 1 });
  });

  it('rejects with a code only and logs no content, path or page name', async () => {
    h.debug = true;
    await expect(call(IPC.DISPATCHER.INSPECT_MEMORY_PAGE, 'topics/absent-private-name.md')).rejects.toThrow(/^dispatcher_inspector:missing$/);
    await expect(call(IPC.DISPATCHER.INSPECT_SKILL, 'work', '../x')).rejects.toThrow(/^dispatcher_inspector:invalid_request$/);
    await expect(call(IPC.DISPATCHER.INSPECT_SKILL, 'chat', 'check-ins')).rejects.toThrow(/^dispatcher_inspector:no_agent$/);
    for (const [channel, args] of CHANNELS) await call(channel, ...args).catch(() => undefined);
    const logged = JSON.stringify(vi.mocked(appLog).mock.calls);
    expect(logged).toContain('"code":"missing"');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('absent-private-name');
    expect(logged).not.toContain(h.base);
  });
});
