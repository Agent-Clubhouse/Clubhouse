import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  antigravityHookCommand,
  antigravityHooksCleanup,
  antigravityHooksSupported,
  buildAntigravityStatusHook,
  parseAntigravityHookEvent,
  renderAntigravityHooksFile,
  validConversationId,
  writeAntigravityHooks,
} from './hooks';

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

describe('the workspace hooks file', () => {
  let dir: string;
  const file = () => path.join(dir, '.agents', 'hooks.json');

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-')));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file with exactly its own bytes when there is none, and cleanup may delete it', async () => {
    expect(await writeAntigravityHooks(dir, HOOK_URL)).toBe('created');
    const text = fs.readFileSync(file(), 'utf-8');
    expect(text).toBe(renderAntigravityHooksFile(HOOK_URL));
    expect(Object.keys(JSON.parse(text))).toEqual(['clubhouse-status']);
    expect(antigravityHooksCleanup(text)).toBe('delete');
  });

  it('is a no-op when its own file is already there', async () => {
    await writeAntigravityHooks(dir, HOOK_URL);
    const before = fs.statSync(file()).mtimeMs;
    expect(await writeAntigravityHooks(dir, HOOK_URL)).toBe('unchanged');
    expect(fs.statSync(file()).mtimeMs).toBe(before);
  });

  it.each([
    ['the person\'s hooks', JSON.stringify({ 'my-linter-hook': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } })],
    ['a hook of the same name', JSON.stringify({ 'clubhouse-status': { Stop: [{ type: 'command', command: './mine.sh' }] } })],
    ['not JSON', '{ nope'],
    ['a BOM and comments', '\uFEFF// mine\n{}'],
  ])('never edits an existing file with %s, byte for byte', async (_label, text) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), text);
    expect(await writeAntigravityHooks(dir, HOOK_URL)).toBe('skipped_existing_file');
    expect(fs.readFileSync(file(), 'utf-8')).toBe(text);
    expect(antigravityHooksCleanup(text)).toBe('keep');
  });

  it('never claims a copy of its file that the person changed, even by one space or one event', () => {
    const ours = renderAntigravityHooksFile(HOOK_URL);
    expect(antigravityHooksCleanup(ours.replace('\n}', ' \n}'))).toBe('keep');
    const doc = JSON.parse(ours);
    doc['clubhouse-status'].Stop[0].command += ' && ./mine.sh';
    expect(antigravityHooksCleanup(`${JSON.stringify(doc, null, 2)}\n`)).toBe('keep');
    doc['clubhouse-status'].Stop[0].command = 'echo X-Clubhouse-Nonce CLUBHOUSE_AGENT_ID';
    expect(antigravityHooksCleanup(`${JSON.stringify(doc, null, 2)}\n`)).toBe('keep');
    const extra = JSON.parse(ours);
    extra.mine = {};
    expect(antigravityHooksCleanup(`${JSON.stringify(extra, null, 2)}\n`)).toBe('keep');
  });

  it('claims its file whatever the callback host and path were', () => {
    expect(antigravityHooksCleanup(renderAntigravityHooksFile('http://localhost:9/hook'))).toBe('delete');
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked .agents folder or hooks file, writing nothing through it', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-outside-')));
    try {
      fs.symlinkSync(outside, path.join(dir, '.agents'));
      await expect(writeAntigravityHooks(dir, HOOK_URL)).rejects.toThrow(/symbolic link/);
      expect(fs.readdirSync(outside)).toEqual([]);
      fs.unlinkSync(path.join(dir, '.agents'));
      fs.mkdirSync(path.join(dir, '.agents'));
      fs.symlinkSync(path.join(outside, 'target.json'), file());
      await expect(writeAntigravityHooks(dir, HOOK_URL)).rejects.toThrow(/symbolic link/);
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
