/** Switch to plain (#2927, D98) on real files: delivered by managed delivery, with the copies the switch to managed keeps. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';

const h = vi.hoisted(() => ({ stateDir: '', failMcpRename: false }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
// A rename onto the MCP file can be refused (Windows, the file open elsewhere).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const rename = async (from: string, to: string) => {
    if (h.failMcpRename && String(to).endsWith('.mcp.json')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return actual.rename(from, to);
  };
  return { ...actual, default: { ...actual, rename }, rename };
});
vi.mock('./state-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state-store')>()),
  managedStateDir: () => h.stateDir,
}));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS, BUILTIN_SKILL_IDS } from './builtins';
import { deliverManagedSetup } from './delivery';
import { backupInstructions } from './before-managed';
import { backupMcpFile } from './mcp-backup';
import { linesAddedSince, previewSwitchToPlain, switchToPlain, withAddedLines, type PlainDeps } from './plain';
import type { OrchestratorProvider } from '../../orchestrators/types';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

const conventions = { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json', settingsFormat: 'json' };
const provider = (conv: Record<string, unknown> = conventions, id = 'claude-code') => ({
  id,
  displayName: id,
  conventions: conv,
  readInstructions: async (wt: string) => fs.readFileSync(path.join(wt, conv.legacyInstructionsFile as string), 'utf-8'),
  writeInstructions: async (wt: string, content: string) => { fs.writeFileSync(path.join(wt, conv.legacyInstructionsFile as string), content); },
}) as unknown as OrchestratorProvider;

const BEFORE_INSTRUCTIONS = '# How we work\n\nUse pnpm, never npm.\n';
const BEFORE_MCP = '{\n  "mcpServers": {\n    "docs": { "command": "docs-server" }\n  }\n}\n';

let root: string;
let project: string;
let wt: string;
let service: ManagedAgentsService;
let agent: DurableAgentConfig;
let unmanaged: number;
let deps: PlainDeps;

const read = (rel: string) => fs.readFileSync(path.join(wt, rel), 'utf-8');

/** As at the switch to managed and its first start: the earlier files kept, then the managed ones written, then the bridge. */
async function switchedToManaged(): Promise<void> {
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), BEFORE_INSTRUCTIONS);
  fs.writeFileSync(path.join(wt, '.mcp.json'), BEFORE_MCP);
  await backupInstructions(agent.id, 'CLAUDE.md', BEFORE_INSTRUCTIONS);
  await backupMcpFile(wt, conventions);
  const github = await user(() => service.createPart({ name: 'GitHub', content: { kind: 'mcp', serverKey: 'github', transport: 'stdio', command: 'github-mcp' } }));
  agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [BUILTIN_SKILL_IDS.build], mcps: [CLUBHOUSE_MCP_PART_ID, github.id] };
  await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
  // Every start injects the Clubhouse bridge into the MCP file after delivery.
  const mcp = JSON.parse(read('.mcp.json'));
  mcp.mcpServers.clubhouse = { type: 'http', url: 'http://127.0.0.1:1/mcp' };
  fs.writeFileSync(path.join(wt, '.mcp.json'), JSON.stringify(mcp, null, 2));
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-plain-'));
  h.stateDir = path.join(root, 'app-data', 'managed-agents');
  project = path.join(root, 'project');
  wt = path.join(project, '.clubhouse', 'agents', 'cool-gazelle');
  fs.mkdirSync(wt, { recursive: true });
  _resetSettingsAuditForTesting(false);
  unmanaged = 0;
  h.failMcpRename = false;
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [],
    listAgents: async () => [agent],
    getAgent: async () => agent,
    setManagedSetup: async (_p, _id, setup) => { if (setup) agent.managed = { version: 1, ...setup }; else delete agent.managed; },
    isRunning: () => false,
    onUnmanaged: async () => { unmanaged++; },
  });
  await service.ensureBuiltins();
  agent = {
    id: 'a1', name: 'cool-gazelle', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt,
    branch: 'cool-gazelle/standby', lastSessionId: 'session-1', orchestration: { canStartHelpers: true } as DurableAgentConfig['orchestration'],
  };
  deps = { service, getAgent: async () => agent, providerFor: async () => provider(), deliveredInstructions: () => undefined };
});

describe('Switch to plain, not edited since the switch (#2927)', () => {
  it('previews the files that stay, and brings the earlier files back exactly', async () => {
    await switchedToManaged();
    const managedText = read('CLAUDE.md');
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    expect(preview.instructions).toMatchObject({ file: 'CLAUDE.md', exists: true, changedSince: false, addedLines: 0 });
    expect(preview.instructions.before?.result).toBe(BEFORE_INSTRUCTIONS);
    expect(preview.mcp).toMatchObject({ file: '.mcp.json', exists: true, servers: ['github'], added: [], before: { copy: '.clubhouse-before-managed/.mcp.json', servers: ['docs'], result: ['docs'] } });
    expect(preview.skills).toEqual(['.claude/skills/build/']);
    // Nothing is written by the preview.
    expect(read('CLAUDE.md')).toBe(managedText);
    expect(agent.managed).toBeDefined();

    const parts = await service.listParts('mcp');
    await user(() => switchToPlain(deps, project, agent.id, { restoreInstructions: true, restoreMcp: true, token: preview.token }));
    expect(read('CLAUDE.md')).toBe(BEFORE_INSTRUCTIONS);
    expect(read('.mcp.json')).toBe(BEFORE_MCP);
    // Plain now; its id, session, branch and wires are as they were, and the parts stay in the library.
    expect(agent.managed).toBeUndefined();
    expect(unmanaged).toBe(1);
    expect(agent).toMatchObject({ id: 'a1', lastSessionId: 'session-1', branch: 'cool-gazelle/standby', orchestration: { canStartHelpers: true } });
    expect((await service.listParts('mcp')).map((p) => p.id)).toEqual(parts.map((p) => p.id));
    // The skill folder stays as the person's; Clubhouse's list of what it wrote goes.
    expect(fs.existsSync(path.join(wt, '.claude', 'skills', 'build', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(wt, '.claude', 'skills', '.clubhouse-managed-skills.json'))).toBe(false);
  });

  it('keeps the files Clubhouse last wrote when nothing is brought back', async () => {
    await switchedToManaged();
    const managedText = read('CLAUDE.md');
    const managedMcp = read('.mcp.json');
    await user(async () => switchToPlain(deps, project, agent.id, { token: (await previewSwitchToPlain(deps, project, agent.id)).token }));
    expect(read('CLAUDE.md')).toBe(managedText);
    expect(read('.mcp.json')).toBe(managedMcp);
    expect(agent.managed).toBeUndefined();
  });
});

describe('Switch to plain, edited after the switch (#2927)', () => {
  it('keeps the instructions and MCP servers added since when the earlier files come back', async () => {
    await switchedToManaged();
    fs.appendFileSync(path.join(wt, 'CLAUDE.md'), '\n\nAlso run the linter before you push.\n');
    const mcp = JSON.parse(read('.mcp.json'));
    mcp.mcpServers.mine = { command: 'my-server' };
    fs.writeFileSync(path.join(wt, '.mcp.json'), JSON.stringify(mcp, null, 2));

    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    expect(preview.instructions).toMatchObject({ changedSince: true, addedLines: 1 });
    expect(preview.instructions.before?.result).toBe('# How we work\n\nUse pnpm, never npm.\n\nAlso run the linter before you push.\n');
    expect(preview.mcp).toMatchObject({ servers: ['github', 'mine'], added: ['mine'], before: { servers: ['docs'], result: ['docs', 'mine'] } });

    await user(() => switchToPlain(deps, project, agent.id, { restoreInstructions: true, restoreMcp: true, token: preview.token }));
    expect(read('CLAUDE.md')).toBe(preview.instructions.before!.result);
    const after = JSON.parse(read('.mcp.json')).mcpServers;
    expect(Object.keys(after)).toEqual(['docs', 'mine']);
    expect(after.mine).toEqual({ command: 'my-server' });
  });

  it('keeps the edited files as they are when nothing is brought back', async () => {
    await switchedToManaged();
    fs.appendFileSync(path.join(wt, 'CLAUDE.md'), '\nMy own line.\n');
    const edited = read('CLAUDE.md');
    await user(async () => switchToPlain(deps, project, agent.id, { token: (await previewSwitchToPlain(deps, project, agent.id)).token }));
    expect(read('CLAUDE.md')).toBe(edited);
  });

  it('refuses when the files changed after the preview, and changes nothing', async () => {
    await switchedToManaged();
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    fs.appendFileSync(path.join(wt, 'CLAUDE.md'), '\nAdded while the dialog was open.\n');
    const edited = read('CLAUDE.md');
    await expect(user(() => switchToPlain(deps, project, agent.id, { restoreInstructions: true, token: preview.token }))).rejects.toMatchObject({ code: 'stale' });
    expect(agent.managed).toBeDefined();
    expect(read('CLAUDE.md')).toBe(edited);
  });

  it('won\'t merge into an MCP file that isn\'t valid JSON, since what was added can\'t be told', async () => {
    await switchedToManaged();
    fs.writeFileSync(path.join(wt, '.mcp.json'), '{ "mcpServers": { broken');
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    expect(preview.mcp?.before).toBeNull();
    expect(preview.mcp?.note).toContain('isn\'t valid JSON');
    await expect(user(() => switchToPlain(deps, project, agent.id, { restoreMcp: true, token: preview.token }))).rejects.toMatchObject({ code: 'invalid' });
    expect(agent.managed).toBeDefined();
  });
});

describe('Switch to plain when a write fails (#2927)', () => {
  it('says the agent is plain now and where the earlier copy is', async () => {
    await switchedToManaged();
    const failing = { ...provider(), writeInstructions: async () => { throw new Error('read-only'); } } as unknown as OrchestratorProvider;
    deps.providerFor = async () => failing;
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    const err = await user(() => switchToPlain(deps, project, agent.id, { restoreInstructions: true, token: preview.token })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'failed' });
    expect((err as Error).message).toBe(`cool-gazelle is plain now. Its earlier instructions file couldn't be written (read-only). The copy is still at ${preview.instructions.before!.copy}.`);
    expect(agent.managed).toBeUndefined();
  });
});

describe('Switch to plain, review fixes (#2927)', () => {
  it('leaves no temporary MCP file behind when the rename is refused, since it can hold env values', async () => {
    await switchedToManaged();
    const mcp = JSON.parse(read('.mcp.json'));
    mcp.mcpServers.mine = { command: 'my-server' };
    fs.writeFileSync(path.join(wt, '.mcp.json'), JSON.stringify(mcp, null, 2));
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    h.failMcpRename = true;
    const err = await user(() => switchToPlain(deps, project, agent.id, { restoreMcp: true, token: preview.token })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'failed' });
    expect(fs.readdirSync(wt).filter((f) => f.startsWith('.mcp.json.tmp'))).toEqual([]);
  });

  it('refuses a switch without the token from a preview', async () => {
    await switchedToManaged();
    await expect(user(() => switchToPlain(deps, project, agent.id, {} as never))).rejects.toMatchObject({ code: 'invalid' });
    expect(agent.managed).toBeDefined();
  });

  it('refuses when the setup changed after the preview, even with the files as they were', async () => {
    await switchedToManaged();
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    // Renamed meanwhile: the Identity line Clubhouse wrote no longer matches, so it would count as added.
    agent.name = 'renamed-gazelle';
    await expect(user(() => switchToPlain(deps, project, agent.id, { restoreInstructions: true, token: preview.token }))).rejects.toMatchObject({ code: 'stale' });
    expect(agent.managed).toBeDefined();
  });

  it('matches lines whatever the line endings, and keeps the earlier file\'s', async () => {
    await switchedToManaged();
    // The file saved again with CRLF, plus one line.
    fs.writeFileSync(path.join(wt, 'CLAUDE.md'), `${read('CLAUDE.md').replace(/\n/g, '\r\n')}\r\nMy own line.\r\n`);
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    expect(preview.instructions.addedLines).toBe(1);
    expect(preview.instructions.before?.result).toBe(`${BEFORE_INSTRUCTIONS.trimEnd()}\n\nMy own line.\n`);
  });

  it('won\'t bring the earlier file back when the files differ too much to tell what was added', async () => {
    await switchedToManaged();
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
    fs.writeFileSync(path.join(wt, 'CLAUDE.md'), lines.join('\n'));
    const managed = Array.from({ length: 1500 }, (_, i) => `other ${i}`).join('\n');
    deps.deliveredInstructions = () => managed;
    // Neither the current setup nor the delivered text lines up within the limit.
    const big = await user(() => service.createPart({ name: 'Big', content: { kind: 'block', content: managed } }));
    agent.managed = { ...agent.managed!, blocks: [big.id] };
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    expect(preview.instructions.before).toBeNull();
    expect(preview.instructions.note).toContain('changed too much since Clubhouse wrote it');
    await expect(user(() => switchToPlain(deps, project, agent.id, { restoreInstructions: true, token: preview.token }))).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('Switch to plain without copies (#2927)', () => {
  it('offers nothing to bring back when Clubhouse kept no earlier files', async () => {
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider() }));
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    expect(preview.instructions.before).toBeNull();
    expect(preview.mcp?.before).toBeNull();
    expect(preview.mcp?.note).toBeUndefined();
    await expect(user(() => switchToPlain(deps, project, agent.id, { restoreInstructions: true, token: preview.token }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('has no MCP file section for a CLI that gets its servers as launch flags', async () => {
    const codex = { ...conventions, configDir: '.codex', legacyInstructionsFile: 'AGENTS.md', mcpConfigFile: '.codex/config.toml', settingsFormat: 'toml', skillsRoot: '.agents/skills' };
    deps.providerFor = async () => provider(codex, 'codex-cli');
    agent.managed = { version: 1, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] };
    await user(() => deliverManagedSetup({ service, projectPath: project, agent, provider: provider(codex, 'codex-cli') }));
    const preview = await user(() => previewSwitchToPlain(deps, project, agent.id));
    expect(preview.instructions.file).toBe('AGENTS.md');
    expect(preview.mcp).toBeNull();
  });

  it('refuses an agent that is already plain', async () => {
    await expect(user(() => previewSwitchToPlain(deps, project, agent.id))).rejects.toMatchObject({ code: 'not_managed' });
  });
});

describe('what was added since (#2927)', () => {
  it('takes the lines Clubhouse didn\'t write, against whichever written text fits best', () => {
    const now = 'A\nB\nmine\nC\n';
    expect(linesAddedSince(['A\nB\nC\n'], now)).toEqual([['mine']]);
    expect(linesAddedSince(['X\nY\n', 'A\nB\nC\n'], now)).toEqual([['mine']]);
    // An edited line counts as added; blank runs alone don't.
    expect(linesAddedSince(['A\nB\n'], 'A\nB changed\n\n\n')).toEqual([['B changed']]);
  });

  it('puts the added runs after the earlier text', () => {
    expect(withAddedLines('old\n\n', [['one'], ['two', 'three']])).toBe('old\n\none\n\ntwo\nthree\n');
    expect(withAddedLines('old\n', [])).toBe('old\n');
  });
});
