import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoCopilotTerminalHooksForChat, readCopilotHooksConfig } from './copilot-hooks-config';
import { CopilotCliProvider } from './copilot-cli-provider';

const roots: string[] = [];
async function fixture(content?: string) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-copilot-hooks-'));
  roots.push(root);
  const file = path.join(root, '.github', 'hooks', 'hooks.json');
  if (content !== undefined) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
  return { root, file };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });

describe('Copilot hook document boundary', () => {
  it('accepts an absent file without creating it', async () => {
    const { root, file } = await fixture();
    expect(await readCopilotHooksConfig(root)).toBeNull();
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '{',
    JSON.stringify({ permissions: { allow: ['Read'] } }),
    JSON.stringify({ version: 1, hooks: {}, permissions: { deny: ['WebFetch'] } }),
    JSON.stringify({ version: 2, hooks: {} }),
    JSON.stringify({ version: 1, hooks: { preToolUse: {} } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [null] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [42] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command' }] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 42 }] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'http' }] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', exec: 'checker', bash: 'echo test' }] } }),
    JSON.stringify({ version: 1, hooks: { postToolUse: [{ type: 'http', url: 'not-a-url' }] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'http', url: 'http://localhost/hook' }] } }),
    JSON.stringify({ version: 1, hooks: { PermissionRequest: [{ type: 'http', url: 'http://localhost/hook' }] } }),
    JSON.stringify({ version: 1, hooks: { postToolUse: [{ type: 'http', url: 'http://localhost/hook', allowedEnvVars: ['TOKEN'] }] } }),
    JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'prompt' }] } }),
    JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'future-type', data: 'keep' }] } }),
  ])('rejects ambiguous or invalid input without changing it: %s', async (content) => {
    const { root, file } = await fixture(content);
    await expect(readCopilotHooksConfig(root)).rejects.toThrow(/repair.*restart/i);
    await expect(new CopilotCliProvider().writeHooksConfig(root, 'http://127.0.0.1:9999/hook')).rejects.toThrow(/repair.*restart/i);
    expect(await fsp.readFile(file, 'utf8')).toBe(content);
  });

  it('accepts documented command, HTTP and prompt entries without rewriting them', async () => {
    const content = JSON.stringify({ version: 1, hooks: {
      sessionStart: [{ type: 'prompt', prompt: 'hello' }],
      SessionStart: [{ type: 'prompt', prompt: 'hello' }],
      preToolUse: [{ command: 'echo custom' }, { type: 'command', exec: 'checker', args: ['--check'] }],
      postToolUse: [{ type: 'http', url: 'https://example.invalid/hook' }],
    } });
    const { root, file } = await fixture(content);
    expect(await readCopilotHooksConfig(root)).toEqual(JSON.parse(content));
    expect(await fsp.readFile(file, 'utf8')).toBe(content);
  });

  it('accepts custom hooks but refuses existing Clubhouse terminal callbacks for chat', async () => {
    const { root } = await fixture(JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'echo custom' }] } }));
    await expect(assertNoCopilotTerminalHooksForChat(root)).resolves.toBeUndefined();
    await new CopilotCliProvider().writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    await expect(assertNoCopilotTerminalHooksForChat(root)).rejects.toThrow(/callbacks could be duplicated/);
  });

  it('preserves custom hooks and unrelated data across repeated enable writes', async () => {
    const custom = { type: 'command', bash: 'echo custom', timeoutSec: 5 };
    const { root, file } = await fixture(JSON.stringify({ version: 1, hooks: { preToolUse: [custom] }, other: { keep: true } }));
    const provider = new CopilotCliProvider();
    await provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    await provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    const result = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(result.other).toEqual({ keep: true });
    expect(result.hooks.preToolUse).toHaveLength(2);
    expect(result.hooks.preToolUse[0]).toEqual(custom);
  });
});


describe('Copilot generated callback ownership', () => {
  const posix = 'cat | curl -s -X POST http://127.0.0.1:9999/hook/${CLUBHOUSE_AGENT_ID}/preToolUse -H \'Content-Type: application/json\' -H "X-Clubhouse-Nonce: ${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true';
  const windows = 'curl -s -X POST http://127.0.0.1:%CLUBHOUSE_HOOK_PORT%/hook/%CLUBHOUSE_AGENT_ID%/preToolUse -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- || (exit /b 0)';
  const supported = [posix, posix.replace(':9999', ':${CLUBHOUSE_HOOK_PORT}'), windows, windows.replace('%CLUBHOUSE_HOOK_PORT%', '9999')]
    .flatMap((command) => ['preToolUse', 'postToolUse', 'errorOccurred', 'permissionRequest', 'sessionStart', 'sessionEnd', 'userPromptSubmitted']
      .map((event) => ({ event, entry: { type: 'command', bash: command.replace('/preToolUse ', `/${event} `), timeoutSec: event === 'permissionRequest' ? 120 : 5 } })));
  it.each(supported)('recognizes supported generated entries for chat refusal: $event $entry.bash', async ({ event, entry }) => {
    const { root } = await fixture(JSON.stringify({ version: 1, hooks: { [event]: [entry] } }));
    await expect(assertNoCopilotTerminalHooksForChat(root)).rejects.toThrow(/callbacks could be duplicated/);
  });

  it.each(supported)('replaces only supported generated entries on repeated writes: $event $entry.bash', async ({ event, entry }) => {
    const custom = { type: 'command', bash: 'echo custom' };
    const { root, file } = await fixture(JSON.stringify({ version: 1, hooks: { [event]: [custom, entry] } }));
    const provider = new CopilotCliProvider();
    await provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    await provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    const entries = JSON.parse(await fsp.readFile(file, 'utf8')).hooks[event];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(custom);
    expect(entries[1]).toMatchObject({ type: 'command', timeoutSec: entry.timeoutSec });
  });

  const generated = { type: 'command', bash: posix, timeoutSec: 5 };
  const extended = [
    { ...generated, powershell: 'Write-Output custom' },
    { ...generated, command: 'echo custom' },
    { ...generated, env: { CUSTOM: 'keep' } },
    { ...generated, args: ['custom'] },
    { ...generated, cwd: '/custom' },
    { ...generated, matcher: 'custom' },
    { ...generated, timeout: 5000 },
    { ...generated, extension: { keep: true } },
    { ...generated, timeoutSec: 10 },
    { ...generated, timeoutSec: 120 },
    { type: 'command', bash: posix },
    { ...generated, bash: posix.replace('/preToolUse ', '/permissionRequest ') },
  ];
  it.each(extended)('preserves extended or modified generated entries across repeated provider writes: %j', async (entry) => {
    const bytes = JSON.stringify({ version: 1, hooks: { preToolUse: [generated, entry] } }, null, 2);
    const { root, file } = await fixture(bytes);
    const provider = new CopilotCliProvider();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook')).rejects.toThrow(/repair.*restart/i);
      expect(await fsp.readFile(file, 'utf8')).toBe(bytes);
    }
    await expect(readCopilotHooksConfig(root)).rejects.toThrow(/repair.*restart/i);
    await expect(assertNoCopilotTerminalHooksForChat(root)).rejects.toThrow(/repair.*restart/i);
  });

  it('preserves custom hook URLs across repeated provider writes and permits them in chat', async () => {
    const custom = { type: 'command', bash: 'curl https://example.invalid/hook/audit' };
    const { root, file } = await fixture(JSON.stringify({ version: 1, hooks: { preToolUse: [custom] } }));
    await expect(assertNoCopilotTerminalHooksForChat(root)).resolves.toBeUndefined();
    const provider = new CopilotCliProvider();
    await provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    await provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    const result = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(result.hooks.preToolUse).toHaveLength(2);
    expect(result.hooks.preToolUse[0]).toEqual(custom);
  });

  it('preserves unrecognized marked callback forms for manual repair', async () => {
    const bytes = JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'curl /hook/${CLUBHOUSE_AGENT_ID}' }] } }, null, 2);
    const { root, file } = await fixture(bytes);
    await expect(readCopilotHooksConfig(root)).rejects.toThrow(/repair.*restart/i);
    await expect(new CopilotCliProvider().writeHooksConfig(root, 'http://127.0.0.1:9999/hook')).rejects.toThrow(/repair.*restart/i);
    await expect(assertNoCopilotTerminalHooksForChat(root)).rejects.toThrow(/repair.*restart/i);
    expect(await fsp.readFile(file, 'utf8')).toBe(bytes);
  });
});
