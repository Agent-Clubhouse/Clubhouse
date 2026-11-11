import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_PERMISSIONS_BACKUP_SUFFIX, assertNoCopilotTerminalHooksForChat, readCopilotHooksConfig } from './copilot-hooks-config';
import { CopilotCliProvider } from './copilot-cli-provider';
import { appLog } from '../services/log-service';

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
}));

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
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('Copilot hook document boundary', () => {
  it('accepts an absent file without creating it', async () => {
    const { root, file } = await fixture();
    expect(await readCopilotHooksConfig(root)).toBeNull();
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '{',
    JSON.stringify({}),
    JSON.stringify({ version: 1, other: true }),
    JSON.stringify({ version: 1, hooks: null }),
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: '1' }),
    JSON.stringify([1]),
    JSON.stringify({ permissions: { allow: ['Read'] }, other: true }),
    JSON.stringify({ permissions: { allow: ['Read'], ask: ['Bash'] } }),
    JSON.stringify({ permissions: { allow: [42] } }),
    JSON.stringify({ permissions: {} }),
    JSON.stringify({ permissions: ['Read'] }),
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
    await expect(assertNoCopilotTerminalHooksForChat(root)).rejects.toThrow(/repair.*restart/i);
    expect(await fsp.readFile(file, 'utf8')).toBe(content);
  });

  it('repairs version-only residue once across concurrent reads and leaves subsequent reads unchanged', async () => {
    const { root, file } = await fixture('{\r\n  "version": 1\r\n}\r\n');
    const write = vi.spyOn(fsp, 'writeFile');
    const repaired = { version: 1, hooks: {} };
    expect(await Promise.all(Array.from({ length: 8 }, () => readCopilotHooksConfig(root)))).toEqual(Array(8).fill(repaired));
    const bytes = await fsp.readFile(file, 'utf8');
    expect(JSON.parse(bytes)).toEqual(repaired);
    expect(await readCopilotHooksConfig(root)).toEqual(repaired);
    expect(await fsp.readFile(file, 'utf8')).toBe(bytes);
    expect(write).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledExactlyOnceWith('core:orchestrator', 'warn', expect.stringContaining('version-only'), { meta: { file } });
  });

  it('re-reads a changed file before repair without overwriting custom hooks', async () => {
    const { root, file } = await fixture('{"version":1}');
    const custom = { version: 1, hooks: { sessionStart: [{ type: 'prompt', prompt: 'keep' }] } };
    const read = fsp.readFile;
    vi.spyOn(fsp, 'readFile').mockImplementationOnce(async (...args) => {
      const original = await read(...args);
      await fsp.writeFile(file, JSON.stringify(custom));
      return original;
    });
    const write = vi.spyOn(fsp, 'writeFile');
    expect(await readCopilotHooksConfig(root)).toEqual(custom);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await read(file, 'utf8'))).toEqual(custom);
    expect(appLog).not.toHaveBeenCalled();
  });

  it('keeps valid on-disk JSON while serializing readers through an atomic repair', async () => {
    const { root, file } = await fixture('{"version":1}');
    const write = fsp.writeFile;
    let writing!: () => void;
    const started = new Promise<void>((resolve) => { writing = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
      await write(...args);
      writing();
      await paused;
    });
    const first = readCopilotHooksConfig(root);
    await started;
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ version: 1 });
    const read = vi.spyOn(fsp, 'readFile');
    const second = readCopilotHooksConfig(root).then((value) => value, (error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    const readsDuringRepair = read.mock.calls.length;
    resume();
    expect(await first).toEqual({ version: 1, hooks: {} });
    expect(await second).toEqual({ version: 1, hooks: {} });
    expect(readsDuringRepair).toBe(0);
    expect(await fsp.readdir(path.dirname(file))).toEqual(['hooks.json']);
  });

  it('serializes Windows case and separator aliases of the same hook file', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    let contents = '{"version":1}';
    const read = vi.spyOn(fsp, 'readFile').mockImplementation(async () => contents);
    let writing!: () => void;
    const started = new Promise<void>((resolve) => { writing = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const write = vi.spyOn(fsp, 'writeFile').mockImplementation(async (_file, value) => {
      writing();
      await paused;
      contents = String(value);
    });
    vi.spyOn(fsp, 'rename').mockResolvedValue(undefined);
    const first = readCopilotHooksConfig('C:\\Project');
    await started;
    read.mockClear();
    const second = readCopilotHooksConfig('c:/project');
    await Promise.resolve();
    await Promise.resolve();
    const readsDuringRepair = read.mock.calls.length;
    resume();
    expect(await Promise.all([first, second])).toEqual([
      { version: 1, hooks: {} }, { version: 1, hooks: {} },
    ]);
    expect(readsDuringRepair).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledTimes(1);
  });

  it('repairs changed formatting after releasing the per-file lock', async () => {
    const { root, file } = await fixture('{"version":1}');
    const read = fsp.readFile;
    vi.spyOn(fsp, 'readFile').mockImplementationOnce(async (...args) => {
      const original = await read(...args);
      await fsp.writeFile(file, '{ "version": 1 }');
      return original;
    });
    await expect(readCopilotHooksConfig(root)).resolves.toEqual({ version: 1, hooks: {} });
    expect(appLog).toHaveBeenCalledTimes(1);
  });

  it('reports an unwritable residue file and allows a later repair retry', async () => {
    const content = '{"version":1}';
    const { root, file } = await fixture(content);
    vi.spyOn(fsp, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    await expect(readCopilotHooksConfig(root)).rejects.toThrow(`Cannot repair legacy version-only Copilot hooks at ${file}`);
    expect(await fsp.readFile(file, 'utf8')).toBe(content);
    expect(await fsp.readdir(path.dirname(file))).toEqual(['hooks.json']);
    expect(appLog).not.toHaveBeenCalled();
    await expect(readCopilotHooksConfig(root)).resolves.toEqual({ version: 1, hooks: {} });
  });

  it('preserves the original and cleans up the temporary file when repair rename fails', async () => {
    const content = '{"version":1}';
    const { root, file } = await fixture(content);
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    await expect(readCopilotHooksConfig(root)).rejects.toThrow(`Cannot repair legacy version-only Copilot hooks at ${file}`);
    expect(await fsp.readFile(file, 'utf8')).toBe(content);
    expect(await fsp.readdir(path.dirname(file))).toEqual(['hooks.json']);
    await expect(readCopilotHooksConfig(root)).resolves.toEqual({ version: 1, hooks: {} });
  });

  it('repairs version-only residue before terminal hook injection', async () => {
    const { root, file } = await fixture('{"version":1}');
    await new CopilotCliProvider().writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    const doc = await readCopilotHooksConfig(root);
    expect(doc?.version).toBe(1);
    expect(Object.keys(doc?.hooks ?? {})).not.toHaveLength(0);
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual(doc);
  });

  it('repairs version-only residue during chat preparation without injecting terminal hooks', async () => {
    const { root, file } = await fixture('{"version":1}');
    await expect(assertNoCopilotTerminalHooksForChat(root)).resolves.toBeUndefined();
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ version: 1, hooks: {} });
  });

  it.each([
    { permissions: { allow: ['Read'], deny: ['WebFetch'] } },
    { permissions: { deny: [] } },
  ])('moves aside only allow/deny rules an earlier Clubhouse wrote, keeping them (#2866): %j', async (doc) => {
    const content = JSON.stringify(doc);
    const { root, file } = await fixture(content);
    expect(await readCopilotHooksConfig(root)).toBeNull();
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsp.readFile(`${file}${LEGACY_PERMISSIONS_BACKUP_SUFFIX}`, 'utf8')).toBe(content);
    expect(await fsp.readdir(path.dirname(file))).toEqual([`hooks.json${LEGACY_PERMISSIONS_BACKUP_SUFFIX}`]);
  });

  it('moves a legacy file once when two agents start in the folder together', async () => {
    const content = JSON.stringify({ permissions: { allow: ['Read'] } });
    const { root, file } = await fixture(content);
    expect(await Promise.all([readCopilotHooksConfig(root), readCopilotHooksConfig(root)])).toEqual([null, null]);
    expect(await fsp.readdir(path.dirname(file))).toEqual([`hooks.json${LEGACY_PERMISSIONS_BACKUP_SUFFIX}`]);
  });

  it('keeps an earlier backup, using a new name for the next one', async () => {
    const first = JSON.stringify({ permissions: { allow: ['Read'] } });
    const second = JSON.stringify({ permissions: { deny: ['WebFetch'] } });
    const { root, file } = await fixture(first);
    await readCopilotHooksConfig(root);
    await fsp.writeFile(file, second);
    await readCopilotHooksConfig(root);
    expect(await fsp.readFile(`${file}${LEGACY_PERMISSIONS_BACKUP_SUFFIX}`, 'utf8')).toBe(first);
    expect(await fsp.readFile(`${file}${LEGACY_PERMISSIONS_BACKUP_SUFFIX}-2`, 'utf8')).toBe(second);
  });

  it('writes a valid hook document where a legacy permissions file was', async () => {
    const { root, file } = await fixture(JSON.stringify({ permissions: { allow: ['Read'] } }));
    await new CopilotCliProvider().writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    const written = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(written).toMatchObject({ version: 1 });
    expect(written).not.toHaveProperty('permissions');
    expect(await readCopilotHooksConfig(root)).toEqual(written);
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
    const { root, file } = await fixture(JSON.stringify({ version: 1, hooks: { preToolUse: [custom], agentStop: [custom] }, other: { keep: true } }));
    const provider = new CopilotCliProvider();
    const write = vi.spyOn(fsp, 'writeFile');
    await provider.writeHooksConfig(root, 'http://127.0.0.1:9999/hook');
    const bytes = await fsp.readFile(file, 'utf8');
    await provider.writeHooksConfig(root, 'http://127.0.0.1:10000/hook');
    expect(write).toHaveBeenCalledTimes(1);
    expect(await fsp.readFile(file, 'utf8')).toBe(bytes);
    const result = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(result.other).toEqual({ keep: true });
    expect(result.hooks.preToolUse).toHaveLength(2);
    expect(result.hooks.preToolUse[0]).toEqual(custom);
    expect(result.hooks.agentStop).toHaveLength(2);
    expect(result.hooks.agentStop[0]).toEqual(custom);
    expect(result.hooks.agentStop[1]).toMatchObject({ type: 'command', timeoutSec: 5 });
    expect(result.hooks.agentStop[1].bash).toContain('/agentStop ');
  });
});


describe('Copilot generated callback ownership', () => {
  const posix = 'cat | curl -s -X POST http://127.0.0.1:9999/hook/${CLUBHOUSE_AGENT_ID}/preToolUse -H \'Content-Type: application/json\' -H "X-Clubhouse-Nonce: ${CLUBHOUSE_HOOK_NONCE}" --data-binary @- || true';
  const windows = 'curl -s -X POST http://127.0.0.1:%CLUBHOUSE_HOOK_PORT%/hook/%CLUBHOUSE_AGENT_ID%/preToolUse -H "Content-Type: application/json" -H "X-Clubhouse-Nonce: %CLUBHOUSE_HOOK_NONCE%" -d @- || (exit /b 0)';
  const supported = [posix, posix.replace(':9999', ':${CLUBHOUSE_HOOK_PORT}'), windows, windows.replace('%CLUBHOUSE_HOOK_PORT%', '9999')]
    .flatMap((command) => ['preToolUse', 'postToolUse', 'errorOccurred', 'agentStop', 'permissionRequest', 'sessionStart', 'sessionEnd', 'userPromptSubmitted']
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
