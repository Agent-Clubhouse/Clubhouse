import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodexCliProvider } from '../orchestrators/codex-cli-provider';
import { buildHookCurlCommand } from '../orchestrators/shared';
import { _resetForTesting, restoreForAgent, snapshotFile, stripClubhouseHooksFromFile } from './config-pipeline';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

describe('Codex hook directory cleanup', () => {
  let cwd: string;
  let codexDir: string;
  let hooksPath: string;

  beforeEach(async () => {
    _resetForTesting();
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-codex-hooks-'));
    codexDir = path.join(cwd, '.codex');
    hooksPath = path.join(codexDir, 'hooks.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetForTesting();
    await fsp.rm(cwd, { recursive: true, force: true });
  });

  /** A hooks.json group as an older Clubhouse wrote it: env-read port, or the port baked in before #1727. */
  const legacyGroup = (command = buildHookCurlCommand('http://127.0.0.1:9999/hook')) => ({ hooks: [{ type: 'command', command, async: true, timeout: 5 }] });
  const bakedPortCommand = "cat | curl -s -X POST http://127.0.0.1:51234/hook/${CLUBHOUSE_AGENT_ID} -H 'Content-Type: application/json' -H \"X-Clubhouse-Nonce: ${CLUBHOUSE_HOOK_NONCE}\" --data-binary @- || true";
  const userGroup = { hooks: [{ type: 'command', command: 'echo user' }] };

  // agent-system runs stripClubhouseHooksFromFile on the Codex hooks path once before every start.
  it('creates no .codex folder in a clean agent folder (#1728)', async () => {
    await new CodexCliProvider().writeHooksConfig(cwd, 'http://127.0.0.1:9999/hook');
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('strips hooks an older Clubhouse wrote, then removes the folder they leave empty', async () => {
    await fsp.mkdir(codexDir);
    await fsp.writeFile(hooksPath, JSON.stringify({ hooks: { Stop: [legacyGroup()], PreToolUse: [legacyGroup(bakedPortCommand)] } }));
    await stripClubhouseHooksFromFile(hooksPath);
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the user\'s hooks, settings and other files when stripping older entries', async () => {
    await fsp.mkdir(codexDir);
    const configPath = path.join(codexDir, 'config.toml');
    const config = 'model = "saved-legacy-model"\n';
    await fsp.writeFile(configPath, config);
    await fsp.writeFile(hooksPath, JSON.stringify({ custom: 'kept', hooks: { Stop: [userGroup, legacyGroup()], PostToolUse: [legacyGroup()] } }));
    await stripClubhouseHooksFromFile(hooksPath);
    expect(await fsp.readFile(configPath, 'utf-8')).toBe(config);
    expect(JSON.parse(await fsp.readFile(hooksPath, 'utf-8'))).toEqual({ custom: 'kept', hooks: { Stop: [userGroup] } });
  });

  it('keeps the user\'s handler from a group it shares with a Clubhouse one', async () => {
    await fsp.mkdir(codexDir);
    const mixed = { hooks: [...legacyGroup().hooks, ...userGroup.hooks] };
    await fsp.writeFile(hooksPath, JSON.stringify({ hooks: { Stop: [mixed] } }));
    await stripClubhouseHooksFromFile(hooksPath);
    expect(JSON.parse(await fsp.readFile(hooksPath, 'utf-8'))).toEqual({ hooks: { Stop: [userGroup] } });
  });

  it('leaves a hooks file it cannot parse untouched', async () => {
    await fsp.mkdir(codexDir);
    const broken = `// commented\n${JSON.stringify({ hooks: { Stop: [legacyGroup()] } })}`;
    await fsp.writeFile(hooksPath, broken);
    await stripClubhouseHooksFromFile(hooksPath);
    expect(await fsp.readFile(hooksPath, 'utf-8')).toBe(broken);
  });

  it('leaves user-only hooks byte-identical', async () => {
    await fsp.mkdir(codexDir);
    const raw = JSON.stringify({ hooks: { Stop: [userGroup] } });
    await fsp.writeFile(hooksPath, raw);
    await stripClubhouseHooksFromFile(hooksPath);
    expect(await fsp.readFile(hooksPath, 'utf-8')).toBe(raw);
  });

  it('removes a leftover empty directory even when hooks are already absent', async () => {
    await fsp.mkdir(codexDir);
    expect(await stripClubhouseHooksFromFile(hooksPath)).toBe(false);
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a user hooks file a running agent had snapshotted', async () => {
    await fsp.mkdir(codexDir);
    const userHooks = { hooks: { Stop: [userGroup] } };
    await fsp.writeFile(hooksPath, JSON.stringify(userHooks));
    await snapshotFile('dispatcher', hooksPath);
    await restoreForAgent('dispatcher');
    expect(JSON.parse(await fsp.readFile(hooksPath, 'utf-8'))).toEqual(userHooks);
  });
});
