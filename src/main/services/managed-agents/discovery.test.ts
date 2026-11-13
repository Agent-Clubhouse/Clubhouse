import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorConventions } from '../../orchestrators/types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { discoverManagedAssets, readDiscoveredManagedAsset } from './discovery';
import { MAX_SKILL_FILE_BYTES } from '../asset-catalog/validation';

const conventions: OrchestratorConventions = {
  configDir: '.github', skillsDir: 'skills', mcpConfigFile: '.github/mcp.json',
  localInstructionsFile: 'copilot-instructions.md', legacyInstructionsFile: 'AGENTS.md',
  localSettingsFile: 'settings.json',
};
let root: string, worktree: string;
const source = () => ({ root: worktree, conventions });
function write(relative: string, content: string | Buffer): void {
  const file = path.join(worktree, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function selected(kind: 'skill' | 'mcp') {
  const candidate = (await discoverManagedAssets(source())).candidates.find((c) => c.kind === kind)!;
  return readDiscoveredManagedAsset(source(), candidate.id);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-discovery-'));
  worktree = path.join(root, 'agent');
  write('.github/skills/review/SKILL.md', '---\nname: review\ndescription: Review changes.\n---\nRead supporting files.\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('scoped managed asset discovery (#2855)', () => {
  it('uses only the selected provider folder and never reports loading or runs content', async () => {
    const marker = path.join(root, 'must-not-exist');
    write('.github/skills/review/scripts/check.sh', `#!/bin/sh\ntouch "${marker}"\n`);
    write('.claude/skills/not-this-provider/SKILL.md', 'Not this provider.\n');
    write('.github/mcp.json', JSON.stringify({ mcpServers: { server: { command: 'touch', args: [marker] }, clubhouse: { command: 'bridge' } } }));
    const result = await discoverManagedAssets(source());
    expect(result).toMatchObject({ scope: 'agent_provider_folder', providerLoaded: 'not_confirmed' });
    expect(result.candidates.map((c) => [c.kind, c.nativeName, c.evidence])).toEqual([['skill', 'review', 'discovered'], ['mcp', 'server', 'discovered']]);
    expect(JSON.stringify(result)).not.toContain(worktree);
    expect(result.notes.join(' ')).toContain('Inherited, global');
    await selected('skill');
    await selected('mcp');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('reads the complete bundle with supporting/binary files and executable flags', async () => {
    write('.github/skills/review/assets/data.bin', Buffer.from([0, 255, 17]));
    write('.github/skills/review/scripts/check.sh', '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(worktree, '.github/skills/review/scripts/check.sh'), 0o755);
    const result = await selected('skill');
    expect(result.content).toMatchObject({ kind: 'skill', skillName: 'review', files: [
      { path: 'SKILL.md' },
      { path: 'assets/data.bin', content: 'AP8R', encoding: 'base64' },
      { path: 'scripts/check.sh', ...(process.platform !== 'win32' && { executable: true }) },
    ] });
    const before = result.fingerprint;
    write('.github/skills/review/scripts/check.sh', '#!/bin/sh\nexit 1\n');
    expect((await selected('skill')).fingerprint).not.toBe(before);
  });

  it.each(['.github', '.github/skills', '.github/skills/review'])('refuses a link in %s without following it', async (relative) => {
    const outside = path.join(root, 'outside');
    fs.renameSync(path.join(worktree, relative), outside);
    fs.symlinkSync(outside, path.join(worktree, relative), 'dir');
    const result = await discoverManagedAssets(source());
    expect(result.candidates.filter((c) => c.kind === 'skill')).toEqual([]);
    expect(result.notes.join(' ')).toContain('symbolic link');
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it('refuses the whole bundle when a supporting member is a link, even inside the root', async () => {
    write('other.txt', 'Not part of the selected bundle.\n');
    fs.symlinkSync(path.join(worktree, 'other.txt'), path.join(worktree, '.github/skills/review/linked.txt'));
    await expect(selected('skill')).rejects.toThrow('symbolic link');
  });

  it('refuses registered-root links and provider path traversal', async () => {
    const linked = path.join(root, 'linked');
    fs.symlinkSync(worktree, linked, 'dir');
    expect((await discoverManagedAssets({ ...source(), root: linked })).candidates).toEqual([]);
    const result = await discoverManagedAssets({ ...source(), conventions: { ...conventions, skillsRoot: '../outside', mcpConfigFile: '../outside.json' } });
    expect(result.candidates).toEqual([]);
    expect(result.notes.join(' ')).toContain('safe relative path');
    await expect(readDiscoveredManagedAsset(source(), '../../outside')).rejects.toThrow('no longer discoverable');
  });

  it.each([
    ['.env', 'TOKEN=private-value'],
    ['assets/private.txt', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['assets/private.bin', Buffer.from('\0ghp_abcdefghijklmnopqrstuvwxyz0123456789')],
  ])('refuses credentials anywhere in the complete bundle without echoing them: %s', async (file, value) => {
    write(`.github/skills/review/${file}`, value);
    const error = await selected('skill').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('credentials');
    expect(String(error)).not.toContain('private-value');
    expect(String(error)).not.toContain('ghp_');
    expect(String(error)).not.toContain(worktree);
  });

  it('bounds individual reads before allocating the file and refuses rather than truncating', async () => {
    const file = path.join(worktree, '.github/skills/review/huge.bin');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, MAX_SKILL_FILE_BYTES + 1);
    await expect(selected('skill')).rejects.toThrow('size limit');
  });

  it('refuses hard-linked files instead of treating an external alias as an owned bundle member', async () => {
    const external = path.join(root, 'external.txt');
    fs.writeFileSync(external, 'Not owned by the skill folder.\n');
    fs.linkSync(external, path.join(worktree, '.github/skills/review/external.txt'));
    await expect(selected('skill')).rejects.toThrow('multiple hard links');
  });

  describe.each(['files', 'depth'])('a bundle exceeding the %s limit', (limit) => {
    beforeEach(() => {
      if (limit === 'files') {
        const dir = path.join(worktree, '.github/skills/review');
        // The directory already exists; avoid 500 redundant recursive mkdirs.
        for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), '');
      } else write(`.github/skills/review/${Array(18).fill('d').join('/')}/nested.txt`, '');
    });

    it('refuses without importing a truncated bundle', async () => {
      await expect(selected('skill')).rejects.toThrow(limit === 'files' ? 'file limit' : 'depth limit');
    });
  });

  it('preserves local MCP siblings, extracts external env names only and fingerprints literal changes', async () => {
    const raw = { mcpServers: { server: { command: 'test-mcp', env: { SERVICE_TOKEN: 'private-value', MODE: '${MODE}' } }, unrelated: { url: 'https://example.test/mcp' } }, other: { untouched: true } };
    const bytes = JSON.stringify(raw);
    write('.github/mcp.json', bytes);
    const first = await selected('mcp');
    expect(first).toMatchObject({ content: { kind: 'mcp', serverKey: 'server', transport: 'stdio', command: 'test-mcp', envVars: ['SERVICE_TOKEN', 'MODE'] }, droppedEnvValues: ['SERVICE_TOKEN'] });
    expect(JSON.stringify(first)).not.toContain('private-value');
    raw.mcpServers.server.env.SERVICE_TOKEN = 'different-value';
    write('.github/mcp.json', JSON.stringify(raw));
    expect((await selected('mcp')).fingerprint).not.toBe(first.fingerprint);
    expect(fs.readFileSync(path.join(worktree, '.github/mcp.json'), 'utf8')).toBe(JSON.stringify(raw));
  });

  it.each([
    { command: 'test-mcp', args: ['--token', 'private-value'] },
    { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer private-value' } },
    { command: 'test-mcp', env: { MODE: 123 } },
    { command: 'test-mcp', env_vars: [1] },
  ])('refuses secret-bearing or unsupported MCP definitions without returning content', async (server) => {
    write('.github/mcp.json', JSON.stringify({ mcpServers: { server } }));
    const error = await selected('mcp').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('private-value');
    expect(String(error)).not.toContain(worktree);
  });

  it('returns sanitized diagnostics for malformed JSON and explicitly unsupported TOML', async () => {
    write('.github/mcp.json', '"private-value"');
    const invalid = await discoverManagedAssets(source());
    expect(invalid.notes.join(' ')).toContain('mcpServers object');
    expect(JSON.stringify(invalid)).not.toContain('private-value');
    const toml = await discoverManagedAssets({ ...source(), conventions: { ...conventions, settingsFormat: 'toml' } });
    expect(toml.notes.join(' ')).toContain('non-JSON');
    expect(toml.candidates.filter((c) => c.kind === 'mcp')).toEqual([]);
  });

  it.each([
    '{"mcpServers":{"server":{"command":"one"},"server":{"command":"two"}}}',
    '{"mcpServers":{"server":{"command":"one","command":"two"}}}',
    '{"mcpServers":{"server":{"command":"one"}},"mcpServers":{}}',
    '{"mcpServers":{"server":{"command":"one"},"ser\\u0076er":{"command":"two"}}}',
  ])('refuses duplicate native definitions instead of guessing precedence', async (raw) => {
    write('.github/mcp.json', raw);
    const result = await discoverManagedAssets(source());
    expect(result.notes.join(' ')).toContain('duplicate fields');
    expect(result.candidates.filter((c) => c.kind === 'mcp')).toEqual([]);
  });
});
