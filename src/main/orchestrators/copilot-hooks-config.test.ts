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
  ])('rejects ambiguous or invalid input without changing it: %s', async (content) => {
    const { root, file } = await fixture(content);
    await expect(readCopilotHooksConfig(root)).rejects.toThrow(/repair.*restart/i);
    await expect(new CopilotCliProvider().writeHooksConfig(root, 'http://127.0.0.1:9999/hook')).rejects.toThrow(/repair.*restart/i);
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
