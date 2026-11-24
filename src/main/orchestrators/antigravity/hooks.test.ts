import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  antigravityHookCommand,
  antigravityHooksSupported,
  buildAntigravityStatusHook,
  parseAntigravityHookEvent,
  removeAntigravityHooks,
  validConversationId,
  writeAntigravityHooks,
} from './hooks';
import { AntigravityWorkspaceError, memoryReceiptStore, setAntigravityReceiptStore } from './workspace-json';

const HOOK_URL = 'http://127.0.0.1:4567/hook';

describe('Antigravity status hook shape (docs: /docs/hooks/)', () => {
  it('uses matcher groups for tool events and plain handlers otherwise', () => {
    const hook = buildAntigravityStatusHook(HOOK_URL) as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(hook)).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(hook.PreToolUse[0]).toMatchObject({ matcher: '*', hooks: [{ type: 'command', timeout: 5 }] });
    expect(hook.PostToolUse[0]).toMatchObject({ matcher: '*', hooks: [{ type: 'command', timeout: 5 }] });
    expect(hook.SessionStart[0]).toMatchObject({ type: 'command', timeout: 5 });
    expect(hook.Stop[0]).toMatchObject({ type: 'command', timeout: 5 });
  });

  it('always answers allow for PreToolUse and {} elsewhere, whatever the callback did', () => {
    const pre = antigravityHookCommand(HOOK_URL, 'PreToolUse');
    expect(pre).toContain(`/PreToolUse`);
    expect(pre).toMatch(/>\/dev\/null 2>&1; printf '%s\\n' '\{"decision":"allow"\}'$/);
    expect(antigravityHookCommand(HOOK_URL, 'Stop')).toMatch(/printf '%s\\n' '\{\}'$/);
    // Never continue a stop, never deny or ask.
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const) {
      expect(antigravityHookCommand(HOOK_URL, event)).not.toMatch(/continue|deny|ask/);
    }
  });

  it('carries no nonce or port literal: both come from the launch environment', () => {
    const cmd = antigravityHookCommand(HOOK_URL, 'Stop');
    expect(cmd).toContain('${CLUBHOUSE_HOOK_NONCE}');
    expect(cmd).toContain('${CLUBHOUSE_HOOK_PORT}');
    expect(cmd).not.toContain('4567');
  });

  it('is off on Windows, where the hook shell is undocumented', () => {
    expect(antigravityHooksSupported('win32')).toBe(false);
    expect(antigravityHooksSupported('darwin')).toBe(true);
    expect(antigravityHooksSupported('linux')).toBe(true);
  });
});

describe('the workspace hooks file (receipt-backed, workspace-json)', () => {
  let dir: string;
  let home: string;
  let previousStore: ReturnType<typeof setAntigravityReceiptStore>;
  const file = () => path.join(dir, '.agents', 'hooks.json');

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-')));
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-')));
    previousStore = setAntigravityReceiptStore(memoryReceiptStore());
  });
  afterEach(() => {
    setAntigravityReceiptStore(previousStore);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates the file with only its hook, and removal deletes the file it created', async () => {
    expect(await writeAntigravityHooks(dir, HOOK_URL, { home })).toEqual({ created: true });
    const doc = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    expect(Object.keys(doc)).toEqual(['clubhouse-status']);
    expect(doc['clubhouse-status']).toEqual(buildAntigravityStatusHook(HOOK_URL));
    expect(await removeAntigravityHooks(dir, { home })).toBe('deleted');
    expect(fs.existsSync(file())).toBe(false);
  });

  it('keeps every byte of the person\'s hooks, and removal restores them exactly', async () => {
    const user = '{\n  // mine\n  "my-linter-hook": { "PostToolUse": [{ "matcher": "run_command", "hooks": [{ "command": "./lint.sh" }] }] }\n}\n';
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), user);
    await writeAntigravityHooks(dir, HOOK_URL, { home });
    const during = fs.readFileSync(file(), 'utf-8');
    expect(during).toContain('// mine');
    expect(during).toContain('clubhouse-status');
    expect(await removeAntigravityHooks(dir, { home })).toBe('restored');
    expect(fs.readFileSync(file(), 'utf-8')).toBe(user);
  });

  it('keeps an edit the person made elsewhere in the file while the agent ran', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{\n  "a": {}\n}\n');
    await writeAntigravityHooks(dir, HOOK_URL, { home });
    fs.writeFileSync(file(), fs.readFileSync(file(), 'utf-8').replace('"a": {}', '"a": {}, "b": {}'));
    await removeAntigravityHooks(dir, { home });
    const after = fs.readFileSync(file(), 'utf-8');
    expect(after).toContain('"b": {}');
    expect(after).not.toContain('clubhouse-status');
  });

  it.each([
    ['the person\'s own clubhouse-status hook', { 'clubhouse-status': { Stop: [{ type: 'command', command: './mine.sh' }] } }],
    ['an exact copy of Clubhouse\'s hook it has no receipt for', { 'clubhouse-status': buildAntigravityStatusHook(HOOK_URL) }],
  ])('refuses %s, never adopting or removing it', async (_label, doc) => {
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), text);
    await expect(writeAntigravityHooks(dir, HOOK_URL, { home })).rejects.toMatchObject({ code: 'collision' });
    expect(fs.readFileSync(file(), 'utf-8')).toBe(text);
    expect(await removeAntigravityHooks(dir, { home })).toMatchObject({ repair: expect.any(String) });
    expect(fs.readFileSync(file(), 'utf-8')).toBe(text);
  });

  it('refuses a file that is not JSON, untouched', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{ nope');
    await expect(writeAntigravityHooks(dir, HOOK_URL, { home })).rejects.toBeInstanceOf(AntigravityWorkspaceError);
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{ nope');
  });

  it('removal with nothing written is clean and creates nothing', async () => {
    expect(await removeAntigravityHooks(dir, { home })).toBe('clean');
    expect(fs.existsSync(file())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked .agents folder, writing nothing through it', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-outside-')));
    try {
      fs.symlinkSync(outside, path.join(dir, '.agents'));
      await expect(writeAntigravityHooks(dir, HOOK_URL, { home })).rejects.toMatchObject({ code: 'unsafe_path' });
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('parseAntigravityHookEvent (documented payload fields)', () => {
  const common = { conversationId: 'conv-123', workspacePaths: ['/w'], transcriptPath: '/never/read', modelName: 'm', lastUserInput: 'x' };

  it('records the conversation id from SessionStart without a status change', () => {
    expect(parseAntigravityHookEvent({ ...common, hook_event_name: 'SessionStart' })).toEqual({ kind: 'notification', sessionId: 'conv-123' });
  });

  it('maps tool events with the tool name and args', () => {
    const toolCall = { name: 'run_command', args: { command: 'ls' } };
    expect(parseAntigravityHookEvent({ ...common, hook_event_name: 'PreToolUse', toolCall, stepIdx: 1 }))
      .toEqual({ kind: 'pre_tool', toolName: 'run_command', toolInput: { command: 'ls' }, sessionId: 'conv-123' });
    expect(parseAntigravityHookEvent({ ...common, hook_event_name: 'PostToolUse', toolCall, stepIdx: 1 }))
      .toMatchObject({ kind: 'post_tool', toolName: 'run_command' });
    expect(parseAntigravityHookEvent({ ...common, hook_event_name: 'PostToolUse', toolCall, error: 'exit 1' }))
      .toMatchObject({ kind: 'tool_error', message: 'exit 1' });
  });

  it('maps Stop with its termination reason', () => {
    expect(parseAntigravityHookEvent({ ...common, hook_event_name: 'Stop', terminationReason: 'done', fullyIdle: true }))
      .toEqual({ kind: 'stop', outcome: 'completed', message: 'done', sessionId: 'conv-123' });
    expect(parseAntigravityHookEvent({ ...common, hook_event_name: 'Stop', error: 'quota' })).toMatchObject({ kind: 'stop', outcome: 'failed' });
  });

  it('ignores unknown events, non-objects and ids that could read as a flag', () => {
    expect(parseAntigravityHookEvent({ ...common, hook_event_name: 'PreInvocation' })).toBeNull();
    expect(parseAntigravityHookEvent(null)).toBeNull();
    expect(parseAntigravityHookEvent({ hook_event_name: 'SessionStart', conversationId: '--continue' })).toBeNull();
    expect(validConversationId('-x')).toBeUndefined();
    expect(validConversationId('a b')).toBeUndefined();
    expect(validConversationId('7f3c-11ef_ab.cd:1')).toBe('7f3c-11ef_ab.cd:1');
  });

  it('never exposes the transcript path', () => {
    const event = parseAntigravityHookEvent({ ...common, hook_event_name: 'Stop' });
    expect(JSON.stringify(event)).not.toContain('/never/read');
  });
});
