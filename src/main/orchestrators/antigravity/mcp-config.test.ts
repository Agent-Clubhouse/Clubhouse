/**
 * Antigravity workspace MCP merge, cleanup, collisions, ACP servers and the
 * identity fence (#3793, #3794). Every file lives under a temp folder used as
 * both HOME and the worktree; the real home folder is never touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/clubhouse-test' } }));
vi.mock('../../services/log-service', () => ({ appLog: vi.fn() }));

import {
  addAntigravityTemplateMcpServers, antigravityWorkspaceMcpPath, awaitAuthenticatedBridge, AntigravityMcpConfigError,
  bridgeMemberText, buildAntigravityAcpBridgeServer, checkClubhouseCollisions, CREATED_SKELETON, fileReceiptStore,
  findClubhouseCollision, isAntigravityWorkspaceMcpPath, managedMemberText, memoryReceiptStore,
  mergeAntigravityMcpServers, mergeAntigravityWorkspaceMcp, planAntigravityAcpMcpServers, restoreAntigravityWorkspaceMcp,
  setAntigravityReceiptStore, type BridgeIdentityDeps, type ReceiptStore,
} from './mcp-config';
import { emptyOwnership, insertLines, slotOf, stripOwned } from './workspace-json';
import * as configPipeline from '../../services/config-pipeline';
import { injectClubhouseMcp, getBridgeScriptPath } from '../../services/clubhouse-mcp/injection';

const BRIDGE = '/app/.webpack/main/bridge/clubhouse-mcp-bridge.js';
const OLD_BRIDGE = '/old/build/bridge/clubhouse-mcp-bridge.js';

/** A user file with a BOM, comments, a trailing comma, odd spacing and extra keys. */
const USER_FILE = '﻿{\n  // my servers\n  "mcpServers": {\n    "github": { "command": "gh-mcp", "env": { "TOKEN": "${GH_TOKEN}" } }, /* keep */\n    "docs": {"serverUrl": "https://example.test/mcp", "headers": {"X-Key": "abc"}},\n  },\n  "extra": [1, 2, 3]\n}\n';

describe('text primitives', () => {
  const owned = (text: string, original = '') => ({
    created: false, createdDir: false,
    members: { [slotOf('mcpServers', 'clubhouse')]: [createHash('sha256').update(text).digest('hex')] },
    containers: original.includes('mcpServers') ? [] : ['mcpServers'],
  });
  const all = () => true;
  const line = bridgeMemberText(BRIDGE);

  it.each([
    ['user file with BOM, comments, trailing comma and extra keys', USER_FILE],
    ['empty object', '{}'],
    ['empty servers', '{"mcpServers": {}}\n'],
    ['no servers key, other keys', '{\n\t"other": true\n}'],
    ['one-line servers', '{"mcpServers":{"a":{"command":"x"}}}'],
    ['CRLF file', '{\r\n  "mcpServers": {\r\n    "a": {"command": "x"}\r\n  }\r\n}\r\n'],
  ])('insert then owned strip restores %s byte for byte', (_label, original) => {
    const ins = insertLines(original, 'mcpServers', [line]) as { ok: true; text: string };
    expect(ins.ok).toBe(true);
    expect(stripOwned(ins.text, owned(line, original), all)).toMatchObject({ ok: true, text: original, removed: [slotOf('mcpServers', 'clubhouse')] });
  });

  it('never matches nested values or comments that look like the line', () => {
    const lookalike = `{\n  // ${line}\n  "nested": {${line}},\n  "mcpServers": {"x": {"inner": {${line}}}}\n}`;
    expect(stripOwned(lookalike, owned(line), all)).toMatchObject({ ok: true, text: lookalike, removed: [] });
  });

  it('drops the separator before the line when it was the last member', () => {
    const text = `{"mcpServers": {\n    "x": {"command": "x"},\n    ${line}}}`;
    const r = stripOwned(text, owned(line), all) as { text: string };
    expect(JSON.parse(r.text)).toEqual({ mcpServers: { x: { command: 'x' } } });
  });

  it('an exact-form line with no committed hash is not removed', () => {
    const ins = insertLines(USER_FILE, 'mcpServers', [line]) as { text: string };
    expect(stripOwned(ins.text, emptyOwnership(), all)).toMatchObject({ removed: [], text: ins.text });
  });
});

describe('workspace files on disk', () => {
  let tmp: string;
  let home: string;
  let worktree: string;
  let store: ReceiptStore;
  let previousStore: ReceiptStore;
  let file: string;
  const opts = () => ({ home, bridgeScriptPath: BRIDGE });

  const listTree = (dir: string): string[] => fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).map(String).sort()
    : [];

  beforeEach(async () => {
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-')));
    home = path.join(tmp, 'home');
    worktree = path.join(tmp, 'wt');
    await fsp.mkdir(path.join(home, '.gemini', 'config'), { recursive: true });
    await fsp.mkdir(worktree);
    file = antigravityWorkspaceMcpPath(worktree);
    store = memoryReceiptStore();
    previousStore = setAntigravityReceiptStore(store);
    configPipeline._resetForTesting();
  });

  afterEach(async () => {
    setAntigravityReceiptStore(previousStore);
    configPipeline._resetForTesting();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const writeUserFile = async (text = USER_FILE) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text);
  };
  const read = () => fsp.readFile(file, 'utf-8');

  it('merge, then restore, is byte-identical and leaves no receipt', async () => {
    await writeUserFile();
    expect(await mergeAntigravityWorkspaceMcp(worktree, opts())).toEqual({ file, created: false });
    expect(await read()).toContain(bridgeMemberText(BRIDGE));
    expect(await read()).not.toMatch(/NONCE|AGENT_ID|FALLBACK/);
    expect(await restoreAntigravityWorkspaceMcp(file, opts())).toBe('restored');
    expect(await read()).toBe(USER_FILE);
    expect(await store.get(file)).toBeUndefined();
  });

  it('keeps edits the person made while the agent ran', async () => {
    await writeUserFile();
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    await fsp.writeFile(file, (await read()).replace('"extra": [1, 2, 3]', '"extra": [4],\n  "added": "later"'));
    await restoreAntigravityWorkspaceMcp(file, opts());
    expect(await read()).toBe(USER_FILE.replace('"extra": [1, 2, 3]', '"extra": [4],\n  "added": "later"'));
  });

  it('a file and folder Clubhouse created are removed; a server the person added keeps the file', async () => {
    expect(await mergeAntigravityWorkspaceMcp(worktree, opts())).toEqual({ file, created: true });
    expect(await read()).toBe(`{\n  "mcpServers": {\n    ${bridgeMemberText(BRIDGE)}}\n}\n`);
    expect(await restoreAntigravityWorkspaceMcp(file, opts())).toBe('deleted');
    expect(fs.existsSync(path.dirname(file))).toBe(false);

    await mergeAntigravityWorkspaceMcp(worktree, opts());
    await fsp.writeFile(file, (await read()).replace('"mcpServers": {', '"mcpServers": {\n    "mine": {"command": "m"},'));
    expect(await restoreAntigravityWorkspaceMcp(file, opts())).toBe('restored');
    expect(JSON.parse(await read())).toEqual({ mcpServers: { mine: { command: 'm' } } });
  });

  it('never deletes a skeleton-shaped file the person created', async () => {
    await writeUserFile(CREATED_SKELETON);
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    expect(await restoreAntigravityWorkspaceMcp(file, opts())).toBe('restored');
    expect(await read()).toBe(CREATED_SKELETON);
  });

  it('keeps the .agents folder when the person put something else in it', async () => {
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    await fsp.writeFile(path.join(worktree, '.agents', 'AGENTS.md'), 'mine');
    await restoreAntigravityWorkspaceMcp(file, opts());
    expect(fs.existsSync(file)).toBe(false);
    expect(await fsp.readFile(path.join(worktree, '.agents', 'AGENTS.md'), 'utf-8')).toBe('mine');
  });

  it('crash after commit: a later run replaces and cleans up the leftover line via the persisted receipt', async () => {
    const persisted = fileReceiptStore(() => path.join(tmp, 'userData', 'receipts.json'));
    setAntigravityReceiptStore(persisted);
    await writeUserFile();
    await mergeAntigravityWorkspaceMcp(worktree, { home, bridgeScriptPath: OLD_BRIDGE });
    configPipeline._resetForTesting(); // the crash: in-memory snapshots are gone
    setAntigravityReceiptStore(fileReceiptStore(() => path.join(tmp, 'userData', 'receipts.json')));
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    expect((await read()).match(/clubhouse-mcp-bridge\.js/g)).toHaveLength(1);
    await restoreAntigravityWorkspaceMcp(file, opts());
    expect(await read()).toBe(USER_FILE);
    const receipts = await fsp.readFile(path.join(tmp, 'userData', 'receipts.json'), 'utf-8');
    expect(receipts).not.toContain('gh-mcp');
    // Permission bits are POSIX-only; Windows reports them as 0o666.
    if (process.platform !== 'win32') expect((fs.statSync(path.join(tmp, 'userData', 'receipts.json')).mode & 0o077)).toBe(0);
  });

  it('crash between pending record and write: nothing is owned, the file is untouched', async () => {
    await writeUserFile();
    await store.set(file, { committed: emptyOwnership(), pending: { txid: 't', beforeHash: null, afterHash: 'x' } });
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    await restoreAntigravityWorkspaceMcp(file, opts());
    expect(await read()).toBe(USER_FILE);
  });

  it('crash after write but before commit: the line is not adopted, the start is refused, bytes kept', async () => {
    await writeUserFile();
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    const committed = await store.get(file);
    const written = await read();
    // Roll the receipt back to "pending, nothing committed", as a crash before commit leaves it.
    await store.set(file, { committed: { ...committed!.committed, members: {} }, pending: { txid: 't', beforeHash: 'b', afterHash: 'a' } });
    const err = await mergeAntigravityWorkspaceMcp(worktree, opts()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'collision' });
    expect(await read()).toBe(written);
    expect(await restoreAntigravityWorkspaceMcp(file, opts())).toMatchObject({ repair: expect.any(String) });
    expect(await read()).toBe(written);
  });

  it('identical bytes created by someone else confer no ownership', async () => {
    await writeUserFile((insertLines(USER_FILE, 'mcpServers', [bridgeMemberText(BRIDGE)]) as { text: string }).text);
    const before = await read();
    await expect(mergeAntigravityWorkspaceMcp(worktree, opts())).rejects.toMatchObject({ code: 'collision' });
    expect(await restoreAntigravityWorkspaceMcp(file, opts())).toMatchObject({ repair: expect.any(String) });
    expect(await read()).toBe(before);
  });

  it('a user clubhouse server with a custom command is refused and kept', async () => {
    const impostor = '﻿{"mcpServers": {"clubhouse": {"command": "node", "args": ["/mine/clubhouse-mcp-bridge.js"]}}}';
    await writeUserFile(impostor);
    const err = await mergeAntigravityWorkspaceMcp(worktree, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AntigravityMcpConfigError);
    expect((err as AntigravityMcpConfigError).code).toBe('collision');
    expect(await read()).toBe(impostor);
  });

  it.each([
    ['invalid JSON', '{"mcpServers": {'],
    ['servers not an object', '{"mcpServers": []}'],
    ['duplicate mcpServers', '{"mcpServers": {}, "mcpServers": {}}'],
  ])('refuses %s and keeps the bytes', async (_label, text) => {
    await writeUserFile(text);
    await expect(mergeAntigravityWorkspaceMcp(worktree, opts())).rejects.toMatchObject({ code: 'unparsable' });
    expect(await read()).toBe(text);
  });

  it('a tampered owned line is reported for repair and kept', async () => {
    await writeUserFile();
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    const tampered = (await read()).replace('"command": "node"', '"command":"node"');
    await fsp.writeFile(file, tampered);
    expect(await restoreAntigravityWorkspaceMcp(file, opts())).toMatchObject({ repair: expect.any(String) });
    expect(await read()).toBe(tampered);
  });

  it('config-pipeline restore routes here and reports repair through onRepairRequired', async () => {
    await writeUserFile();
    await configPipeline.snapshotFile('agent-1', file);
    await mergeAntigravityWorkspaceMcp(worktree, { bridgeScriptPath: BRIDGE });
    await configPipeline.restoreForAgent('agent-1');
    expect(await read()).toBe(USER_FILE);

    await writeUserFile('{"mcpServers": {"clubhouse": {"command": "x"}}}');
    await configPipeline.snapshotFile('agent-2', file);
    const onRepairRequired = vi.fn();
    await configPipeline.restoreForAgent('agent-2', { onRepairRequired });
    expect(onRepairRequired).toHaveBeenCalledTimes(1);
    expect(await read()).toBe('{"mcpServers": {"clubhouse": {"command": "x"}}}');
  });

  it('shared worktree: the first agent to stop leaves the line for the one still running (QA M2)', async () => {
    await writeUserFile();
    await configPipeline.snapshotFile('agent-a', file);
    await mergeAntigravityWorkspaceMcp(worktree, { bridgeScriptPath: BRIDGE });
    await configPipeline.snapshotFile('agent-b', file);
    await mergeAntigravityWorkspaceMcp(worktree, { bridgeScriptPath: BRIDGE });
    expect((await read()).match(/clubhouse-mcp-bridge\.js/g)).toHaveLength(1);
    await configPipeline.restoreForAgent('agent-a');
    expect(await read()).toContain(bridgeMemberText(BRIDGE));
    await configPipeline.restoreForAgent('agent-b');
    expect(await read()).toBe(USER_FILE);
  });

  it('shared worktree through a symlink alias shares one refcount', async () => {
    await writeUserFile();
    const alias = path.join(tmp, 'wt-alias');
    await fsp.symlink(worktree, alias);
    const aliasFile = antigravityWorkspaceMcpPath(alias);
    await configPipeline.snapshotFile('agent-a', aliasFile);
    await mergeAntigravityWorkspaceMcp(alias, { bridgeScriptPath: BRIDGE });
    await configPipeline.snapshotFile('agent-b', file);
    await mergeAntigravityWorkspaceMcp(worktree, { bridgeScriptPath: BRIDGE });
    await configPipeline.restoreForAgent('agent-a');
    expect(await read()).toContain(bridgeMemberText(BRIDGE));
    await configPipeline.restoreForAgent('agent-b');
    expect(await read()).toBe(USER_FILE);
  });

  it('an interrupted start\'s own line is refused with a repair hint, not adopted (QA M1)', async () => {
    await writeUserFile((insertLines(USER_FILE, 'mcpServers', [bridgeMemberText(BRIDGE)]) as { text: string }).text);
    await expect(mergeAntigravityWorkspaceMcp(worktree, opts())).rejects.toThrow(/interrupted Clubhouse start/);
  });

  describe('symlinks', () => {
    it('refuses a .agents link into HOME/.gemini and leaves the target bytes', async () => {
      const target = path.join(home, '.gemini', 'config');
      const globalFile = path.join(target, 'mcp_config.json');
      await fsp.writeFile(globalFile, '{"mcpServers": {}}');
      await fsp.symlink(target, path.join(worktree, '.agents'));
      await expect(mergeAntigravityWorkspaceMcp(worktree, opts())).rejects.toMatchObject({ code: 'unsafe_path' });
      await expect(mergeAntigravityMcpServers(worktree, { m: { command: 'm' } }, opts())).rejects.toMatchObject({ code: 'unsafe_path' });
      expect(await restoreAntigravityWorkspaceMcp(file, opts())).toMatchObject({ repair: expect.any(String) });
      expect(await fsp.readFile(globalFile, 'utf-8')).toBe('{"mcpServers": {}}');
      expect(listTree(target)).toEqual(['mcp_config.json']);
    });

    it('refuses a linked mcp_config.json and leaves the target bytes', async () => {
      const outside = path.join(tmp, 'outside.json');
      await fsp.writeFile(outside, '{}');
      await fsp.mkdir(path.join(worktree, '.agents'));
      await fsp.symlink(outside, file);
      await expect(mergeAntigravityWorkspaceMcp(worktree, opts())).rejects.toMatchObject({ code: 'unsafe_path' });
      expect(await fsp.readFile(outside, 'utf-8')).toBe('{}');
    });

    it('refuses a worktree inside HOME/.gemini', async () => {
      const inside = path.join(home, '.gemini', 'proj');
      await fsp.mkdir(inside);
      await expect(mergeAntigravityWorkspaceMcp(inside, opts())).rejects.toMatchObject({ code: 'unsafe_path' });
      expect(fs.existsSync(path.join(inside, '.agents'))).toBe(false);
    });
  });

  it('injectClubhouseMcp routes the Antigravity path to the merge with no identity in the file', async () => {
    await writeUserFile();
    expect(fs.existsSync(getBridgeScriptPath())).toBe(true);
    await injectClubhouseMcp(worktree, 'agent-secret-id', 4242, { configDir: '.agents', mcpConfigFile: '.agents/mcp_config.json' });
    const text = await read();
    expect(text).not.toContain('agent-secret-id');
    expect(text).not.toContain('4242');
    expect(text.startsWith('﻿')).toBe(true);
    await restoreAntigravityWorkspaceMcp(file);
    expect(await read()).toBe(USER_FILE);
  });

  describe('managed servers (#3792 seam)', () => {
    const A = { command: 'a-mcp', args: ['--x'] };
    const B = { command: 'b-mcp' };

    it('merges beside user entries, drops servers removed from the setup, and restores exactly', async () => {
      await writeUserFile();
      await mergeAntigravityMcpServers(worktree, { a: A, b: B }, opts());
      expect(await read()).toContain(managedMemberText('a', A));
      await mergeAntigravityMcpServers(worktree, { b: B }, opts());
      expect(await read()).not.toContain('a-mcp');
      await mergeAntigravityMcpServers(worktree, {}, opts());
      expect(await read()).toBe(USER_FILE);
    });

    it('survives an app restart with a persisted receipt', async () => {
      setAntigravityReceiptStore(fileReceiptStore(() => path.join(tmp, 'ud', 'r.json')));
      await writeUserFile();
      await mergeAntigravityMcpServers(worktree, { a: A }, opts());
      setAntigravityReceiptStore(fileReceiptStore(() => path.join(tmp, 'ud', 'r.json')));
      await mergeAntigravityMcpServers(worktree, {}, opts());
      expect(await read()).toBe(USER_FILE);
    });

    it('refuses a managed name the person already uses, even in Clubhouse\'s exact form', async () => {
      await writeUserFile((insertLines(USER_FILE, 'mcpServers', [managedMemberText('a', A)]) as { text: string }).text);
      const before = await read();
      await expect(mergeAntigravityMcpServers(worktree, { a: A }, opts())).rejects.toMatchObject({ code: 'ambiguous_ownership' });
      await expect(mergeAntigravityMcpServers(worktree, { github: B }, opts())).rejects.toMatchObject({ code: 'ambiguous_ownership' });
      expect(await read()).toBe(before);
    });

    it('a managed line the person edited becomes theirs', async () => {
      await writeUserFile();
      await mergeAntigravityMcpServers(worktree, { a: A }, opts());
      const edited = (await read()).replace('"--x"', '"--y"');
      await fsp.writeFile(file, edited);
      await mergeAntigravityMcpServers(worktree, {}, opts());
      expect(await read()).toBe(edited);
    });

    it('managed lines and the bridge coexist; a created file goes once both are gone', async () => {
      await mergeAntigravityMcpServers(worktree, { a: A }, opts());
      await mergeAntigravityWorkspaceMcp(worktree, opts());
      expect(await restoreAntigravityWorkspaceMcp(file, opts())).toBe('restored');
      expect(await read()).toContain('a-mcp');
      await mergeAntigravityMcpServers(worktree, {}, opts());
      expect(fs.existsSync(file)).toBe(false);
    });

    it('refuses a managed server named clubhouse', async () => {
      await expect(mergeAntigravityMcpServers(worktree, { clubhouse: A }, opts())).rejects.toMatchObject({ code: 'collision' });
    });
  });

  it('template servers become the person\'s and a taken name is refused', async () => {
    await writeUserFile();
    await addAntigravityTemplateMcpServers(worktree, { t: { command: 't' } }, opts());
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    await restoreAntigravityWorkspaceMcp(file, opts());
    expect(await read()).toContain('"t": {"command":"t"}');
    await expect(addAntigravityTemplateMcpServers(worktree, { github: { command: 'g' } }, opts())).rejects.toMatchObject({ code: 'ambiguous_ownership' });
  });

  it('no path writes under HOME/.gemini; global bytes unchanged', async () => {
    const globalFile = path.join(home, '.gemini', 'config', 'mcp_config.json');
    const globalBytes = '﻿{ // global\n "mcpServers": {"g": {"command": "g", "env": {"SECRET": "s3cr3t"}}}}';
    await fsp.writeFile(globalFile, globalBytes);
    const before = listTree(path.join(home, '.gemini'));
    const beforeMtime = fs.statSync(globalFile).mtimeMs;

    expect(await checkClubhouseCollisions({ home })).toEqual({ ok: true });
    await mergeAntigravityWorkspaceMcp(worktree, opts());
    await mergeAntigravityMcpServers(worktree, { m: { command: 'm' } }, opts());
    await restoreAntigravityWorkspaceMcp(file, opts());
    await mergeAntigravityMcpServers(worktree, {}, opts());

    expect(await fsp.readFile(globalFile, 'utf-8')).toBe(globalBytes);
    expect(fs.statSync(globalFile).mtimeMs).toBe(beforeMtime);
    expect(listTree(path.join(home, '.gemini'))).toEqual(before);
  });
});

describe('collision checks', () => {
  let home: string;
  beforeEach(async () => { home = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-home-')); });
  afterEach(async () => { await fsp.rm(home, { recursive: true, force: true }); });
  const writeGlobal = async (text: string) => {
    await fsp.mkdir(path.join(home, '.gemini', 'config'), { recursive: true });
    await fsp.writeFile(path.join(home, '.gemini', 'config', 'mcp_config.json'), text);
  };

  it('passes with no global file', async () => {
    expect(await checkClubhouseCollisions({ home })).toEqual({ ok: true });
  });

  it('refuses a global clubhouse server and never echoes its definition', async () => {
    await writeGlobal('﻿{/* c */ "mcpServers": {"clubhouse": {"command": "x", "env": {"TOKEN": "hunter2"}}}}');
    const result = await checkClubhouseCollisions({ home });
    expect(result).toMatchObject({ ok: false, code: 'collision' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('refuses when the global file cannot be parsed', async () => {
    await writeGlobal('{"mcpServers": {"a": ');
    expect(await checkClubhouseCollisions({ home })).toMatchObject({ ok: false, code: 'unparsable' });
  });

  it('refuses a project server named clubhouse', async () => {
    expect(await checkClubhouseCollisions({ home, projectServers: { clubhouse: {} } })).toMatchObject({ ok: false, code: 'collision' });
    expect(findClubhouseCollision(['a', 'clubhouse'])).toBeTruthy();
    expect(findClubhouseCollision({ a: {} })).toBeUndefined();
  });
});

describe('ACP mcpServers', () => {
  it('builds the bridge with explicit env and nothing in args but the script', () => {
    const server = buildAntigravityAcpBridgeServer({ agentId: 'ag-1', nonce: 'n-1', mcpPort: 5000, bridgeScriptPath: BRIDGE });
    expect(server).toEqual({
      name: 'clubhouse', command: 'node', args: [BRIDGE],
      env: [{ name: 'CLUBHOUSE_AGENT_ID', value: 'ag-1' }, { name: 'CLUBHOUSE_HOOK_NONCE', value: 'n-1' }, { name: 'CLUBHOUSE_MCP_PORT', value: '5000' }],
    });
  });

  it.each([
    [{ agentId: '', nonce: 'n', mcpPort: 1 }],
    [{ agentId: 'a', nonce: '', mcpPort: 1 }],
    [{ agentId: 'a', nonce: 'n', mcpPort: 0 }],
  ])('refuses an incomplete identity %#', (input) => {
    expect(() => buildAntigravityAcpBridgeServer({ ...input, bridgeScriptPath: BRIDGE })).toThrow();
  });

  const bridge = buildAntigravityAcpBridgeServer({ agentId: 'a', nonce: 'n', mcpPort: 1, bridgeScriptPath: BRIDGE });

  it('puts the bridge first, passes stdio servers, gates HTTP on mcpCapabilities.http', () => {
    const projectServers = { s: { command: 'srv', args: ['1'], env: { K: 'v' } }, h: { url: 'https://h.test/mcp', headers: { A: 'b' } }, w: { type: 'sse', url: 'x' } };
    const without = planAntigravityAcpMcpServers({ bridge, projectServers });
    expect(without).toMatchObject({ ok: true, servers: [bridge, { name: 's', command: 'srv', args: ['1'], env: [{ name: 'K', value: 'v' }] }] });
    expect((without as { notices: string[] }).notices).toHaveLength(2);
    const withHttp = planAntigravityAcpMcpServers({ bridge, projectServers, mcpCapabilities: { http: true } }) as { servers: unknown[] };
    expect(withHttp.servers).toContainEqual({ type: 'http', name: 'h', url: 'https://h.test/mcp', headers: [{ name: 'A', value: 'b' }] });
  });

  it('refuses a project server named clubhouse', () => {
    expect(planAntigravityAcpMcpServers({ bridge, projectServers: { clubhouse: { command: 'x' } } })).toMatchObject({ ok: false });
  });
});

describe('identity fence', () => {
  function fakeDeps(nonce: string | undefined) {
    const connected = new Set<(id: string) => void>();
    const auth = new Set<(id: string) => void>();
    const state = { nonce, conn: null as { connectedAt: number } | null };
    const deps: BridgeIdentityDeps = {
      getAgentNonce: () => state.nonce,
      getCurrentAgentConnection: () => state.conn,
      onAgentMcpConnected: (l) => { connected.add(l); return () => connected.delete(l); },
      onAuthChange: (l) => { auth.add(l); return () => auth.delete(l); },
    };
    return { deps, state, connected, auth, emitConnected: (id: string) => connected.forEach((l) => l(id)), emitAuth: (id: string) => auth.forEach((l) => l(id)) };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves ok only after a nonce-verified handshake for this launch', async () => {
    const f = fakeDeps('n-1');
    const p = awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 5000 }, f.deps);
    f.emitConnected('other-agent');
    f.state.conn = { connectedAt: 1500 };
    f.emitConnected('a');
    await expect(p).resolves.toEqual({ ok: true, connectedAt: 1500 });
    expect(f.connected.size + f.auth.size).toBe(0);
  });

  it('a dependency that throws, at start or from a later event, rejects and releases its listeners', async () => {
    const f = fakeDeps('n-1');
    f.deps.getCurrentAgentConnection = () => { throw new Error('first'); };
    await expect(awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 5000 }, f.deps)).rejects.toThrow('first');
    expect(f.connected.size + f.auth.size).toBe(0);

    const g = fakeDeps('n-1');
    const p = awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 5000 }, g.deps);
    g.deps.getCurrentAgentConnection = () => { throw new Error('later'); };
    expect(() => g.emitConnected('a')).not.toThrow();
    await expect(p).rejects.toThrow('later');
    expect(g.connected.size + g.auth.size).toBe(0);
  });

  it('a listener registration that throws rejects and releases the registrations made before it', async () => {
    const f = fakeDeps('n-1');
    f.deps.onAuthChange = () => { throw new Error('registry closed'); };
    await expect(awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 5000 }, f.deps)).rejects.toThrow('registry closed');
    expect(f.connected.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an impostor server that answers as clubhouse but never authenticates times out', async () => {
    const f = fakeDeps('n-1');
    const p = awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 5000 }, f.deps);
    f.emitConnected('a'); // an event alone, with no verified connection, is not trust
    vi.advanceTimersByTime(5000);
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('ignores a handshake from an earlier run', async () => {
    const f = fakeDeps('n-1');
    f.state.conn = { connectedAt: 500 };
    const p = awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 100 }, f.deps);
    vi.advanceTimersByTime(100);
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('fails when the registered nonce is not this launch\'s, or changes', async () => {
    const stale = fakeDeps('n-other');
    stale.state.conn = { connectedAt: 2000 };
    await expect(awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 100 }, stale.deps))
      .resolves.toEqual({ ok: false, reason: 'nonce_changed' });
    const f = fakeDeps('n-1');
    const p = awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 1000, deadlineMs: 5000 }, f.deps);
    f.state.nonce = 'n-2';
    f.emitAuth('a');
    await expect(p).resolves.toEqual({ ok: false, reason: 'nonce_changed' });
  });

  it('honours an abort signal', async () => {
    const f = fakeDeps('n-1');
    const ac = new AbortController();
    const p = awaitAuthenticatedBridge({ agentId: 'a', expectedNonce: 'n-1', launchedAt: 0, deadlineMs: 5000, signal: ac.signal }, f.deps);
    ac.abort();
    await expect(p).resolves.toEqual({ ok: false, reason: 'aborted' });
  });
});

describe('path detection', () => {
  it('matches only <dir>/.agents/mcp_config.json', () => {
    expect(isAntigravityWorkspaceMcpPath('/w/.agents/mcp_config.json')).toBe(true);
    expect(isAntigravityWorkspaceMcpPath('/w/.mcp.json')).toBe(false);
    expect(isAntigravityWorkspaceMcpPath('/w/.agents/hooks.json')).toBe(false);
  });
});
