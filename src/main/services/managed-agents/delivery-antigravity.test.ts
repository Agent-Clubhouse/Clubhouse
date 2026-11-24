import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
// The copy Codex delivery keeps goes to app data; here it is recorded in memory, so no test writes outside its folder.
const h = vi.hoisted(() => ({ copies: [] as Array<{ agentId: string; file: string; content: string }> }));
vi.mock('./before-managed', () => ({
  backupInstructions: async (agentId: string, file: string, content: string) => { h.copies.push({ agentId, file, content }); return file; },
}));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { withSettingsSurface, _resetSettingsAuditForTesting } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { deliverManagedSetup } from './delivery';
import { ANTIGRAVITY_BLOCK_BEGIN, ANTIGRAVITY_BLOCK_END, commitAntigravityInstructions, planAntigravityInstructions } from './antigravity-instructions';
import { memoryReceiptStore, setAntigravityReceiptStore } from '../../orchestrators/antigravity/workspace-json';
import { isManagedStartRefused } from './start-refused';
import { ANTIGRAVITY_INSTRUCTIONS_MAX_BYTES, ANTIGRAVITY_PATHS, ANTIGRAVITY_PROVIDER_ID } from '../../../shared/providers/antigravity';
import type { OrchestratorProvider } from '../../orchestrators/types';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

let root: string;
let project: string;
let wt: string;
let service: ManagedAgentsService;
let agent: DurableAgentConfig;

/** Conventions as the Antigravity provider declares them; writeInstructions must never be used for it. */
function antigravity(): OrchestratorProvider {
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    displayName: 'Antigravity CLI',
    conventions: {
      configDir: ANTIGRAVITY_PATHS.configDir, localInstructionsFile: ANTIGRAVITY_PATHS.instructions, legacyInstructionsFile: ANTIGRAVITY_PATHS.instructions,
      mcpConfigFile: ANTIGRAVITY_PATHS.mcpConfig, skillsDir: 'skills', skillsRoot: ANTIGRAVITY_PATHS.skillsRoot, agentTemplatesDir: 'agents',
      localSettingsFile: 'hooks.json', hooksFile: 'hooks.json', settingsFormat: 'json',
    },
    writeInstructions: async () => { throw new Error('writeInstructions must not be used for Antigravity'); },
  } as unknown as OrchestratorProvider;
}

function other(id: 'claude-code' | 'codex-cli'): OrchestratorProvider {
  const conventions = id === 'claude-code'
    ? { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json' }
    : { configDir: '.codex', skillsDir: 'skills', skillsRoot: '.agents/skills', previousSkillsRoots: ['.codex/skills'], mcpConfigFile: '.codex/config.toml', legacyInstructionsFile: 'AGENTS.md', settingsFormat: 'toml' };
  return {
    id, displayName: id, conventions,
    writeInstructions: async (dir: string, content: string) => { fs.writeFileSync(path.join(dir, conventions.legacyInstructionsFile), content); },
  } as unknown as OrchestratorProvider;
}

const agentsMd = () => path.join(wt, 'AGENTS.md');
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Bytes Clubhouse adds around instructions that end without a newline. */
const OVERHEAD = Buffer.byteLength(ANTIGRAVITY_BLOCK_BEGIN) + 1 + 1 + Buffer.byteLength(ANTIGRAVITY_BLOCK_END) + 1;

async function blockPart(content: string) {
  return user(() => service.createPart({ name: `Rules ${Math.random()}`, content: { kind: 'block', content } }));
}

async function deliver(provider: OrchestratorProvider = antigravity()) {
  return user(() => deliverManagedSetup({ service, projectPath: project, agent, provider, backupRoot: path.join(root, 'backup') }));
}

/** Everything under the worktree, as relative path → sha256, for "nothing changed" checks. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out[path.relative(dir, p)] = `link:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = sha(p);
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  // MCP ownership receipts stay in memory, never in the real app data.
  setAntigravityReceiptStore(memoryReceiptStore());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-agy-'));
  project = path.join(root, 'project');
  wt = path.join(project, '.clubhouse', 'agents', 'cool-gazelle');
  fs.mkdirSync(wt, { recursive: true });
  h.copies = [];
  _resetSettingsAuditForTesting(false);
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [], listAgents: async () => [], getAgent: async () => agent,
    setManagedSetup: async () => {}, isRunning: () => false,
  });
  agent = { id: 'a1', name: 'cool-gazelle', color: 'indigo', createdAt: '2026-11-23T00:00:00.000Z', worktreePath: wt, branch: 'cool-gazelle/standby' };
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('Antigravity managed delivery (#3792)', () => {
  it('writes the managed block to AGENTS.md and skills to .agents/skills, records the per-file receipt, and writes no GEMINI.md', async () => {
    const rules = await blockPart('Work on @@StandbyBranch.');
    const skill = await user(() => service.createPart({ name: 'Ship', content: { kind: 'skill', skillName: 'ship', files: [{ path: 'SKILL.md', content: '# Ship' }] } }));
    agent.managed = { version: 1, blocks: [rules.id], skills: [skill.id], mcps: [] };
    const record = await deliver();
    const text = fs.readFileSync(agentsMd(), 'utf-8');
    expect(text).toBe(`${ANTIGRAVITY_BLOCK_BEGIN}\nWork on cool-gazelle/standby.\n${ANTIGRAVITY_BLOCK_END}\n`);
    expect(record?.instructionsLimit).toEqual({ file: 'AGENTS.md', bytes: Buffer.byteLength(text), maxBytes: 24_000, status: 'within_per_file_limit_aggregate_unverified' });
    expect(record?.provider).toBe(ANTIGRAVITY_PROVIDER_ID);
    expect(fs.readFileSync(path.join(wt, '.agents', 'skills', 'ship', 'SKILL.md'), 'utf-8')).toBe('# Ship');
    expect(JSON.parse(fs.readFileSync(path.join(wt, '.agents', 'skills', '.clubhouse-managed-skills.json'), 'utf-8'))).toEqual({ skills: ['ship'] });
    expect(fs.existsSync(path.join(wt, 'GEMINI.md'))).toBe(false);
    expect(fs.existsSync(path.join(wt, '.agents', 'rules'))).toBe(false);
    expect(fs.existsSync(path.join(wt, '.agents', 'mcp_config.json'))).toBe(false);
  });

  it('keeps the person\'s text byte for byte and replaces only the block, where it is', async () => {
    // CRLF, no trailing newline, and bytes that aren't valid UTF-8: all must survive.
    const mine = Buffer.concat([Buffer.from('# Project rules\r\nUse tabs. é😀\r\n'), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('\r\nlast line')]);
    fs.writeFileSync(agentsMd(), mine);
    const rules = await blockPart('one');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await deliver();
    const first = fs.readFileSync(agentsMd());
    const block1 = Buffer.from(`${ANTIGRAVITY_BLOCK_BEGIN}\none\n${ANTIGRAVITY_BLOCK_END}\n`);
    expect(first.equals(Buffer.concat([block1, mine]))).toBe(true);

    // The person moves the block to the end and adds text after it; an edit replaces it in place.
    const after = Buffer.from('\r\ntrailing é\n');
    fs.writeFileSync(agentsMd(), Buffer.concat([mine, Buffer.from('\n'), block1, after]));
    await user(() => service.updatePart({ id: rules.id, expectedRevision: rules.revision, content: { kind: 'block', content: 'two' } }));
    await deliver();
    const block2 = Buffer.from(`${ANTIGRAVITY_BLOCK_BEGIN}\ntwo\n${ANTIGRAVITY_BLOCK_END}\n`);
    expect(fs.readFileSync(agentsMd()).equals(Buffer.concat([mine, Buffer.from('\n'), block2, after]))).toBe(true);

    // The same setup again writes nothing.
    const mtime = fs.statSync(agentsMd()).mtimeMs;
    await deliver();
    expect(fs.statSync(agentsMd()).mtimeMs).toBe(mtime);
  });

  it('delivers exactly 24,000 bytes and refuses 24,001, counting multibyte text in bytes, with nothing written', async () => {
    expect(ANTIGRAVITY_INSTRUCTIONS_MAX_BYTES).toBe(24_000);
    // 1,000 characters, 4,000 bytes: the limit is in bytes, not characters.
    const mine = '😀'.repeat(1_000);
    expect(Buffer.byteLength(mine)).toBe(4_000);
    const fill = 24_000 - OVERHEAD - 4_000;
    const at = await blockPart('é'.repeat(Math.floor(fill / 2)) + 'x'.repeat(fill % 2));
    fs.writeFileSync(agentsMd(), mine);
    agent.managed = { version: 1, blocks: [at.id], skills: [], mcps: [] };
    const record = await deliver();
    expect(fs.statSync(agentsMd()).size).toBe(24_000);
    expect(record?.instructionsLimit?.bytes).toBe(24_000);
    expect(fs.readFileSync(agentsMd()).subarray(24_000 - 4_000).toString('utf-8')).toBe(mine);

    // One byte more: refused, the file exactly as it was, skills not written, no record.
    const skill = await user(() => service.createPart({ name: 'Ship', content: { kind: 'skill', skillName: 'ship', files: [{ path: 'SKILL.md', content: '# Ship' }] } }));
    await user(() => service.updatePart({ id: at.id, expectedRevision: at.revision, content: { kind: 'block', content: 'é'.repeat(Math.floor(fill / 2)) + 'x'.repeat(fill % 2) + 'x' } }));
    agent.managed = { version: 1, blocks: [at.id], skills: [skill.id], mcps: [] };
    const before = snapshot(wt);
    const err = await deliver().catch((e: unknown) => e);
    expect(isManagedStartRefused(err)).toBe(true);
    expect(err).toMatchObject({ code: 'antigravity_instructions_too_large' });
    const message = (err as Error).message;
    expect(message).toContain('24,001 bytes');
    expect(message).toContain('24,000-byte per-file limit');
    expect(message).toContain('text outside Clubhouse\'s block: 4,000 bytes');
    expect(message).toMatch(/Shorten the agent's instruction blocks/);
    expect(message).toMatch(/never cuts text/);
    expect(snapshot(wt)).toEqual(before);
    expect(fs.existsSync(path.join(wt, '.agents', 'skills', 'ship'))).toBe(false);
  });

  it('refuses when multibyte text passes the limit in bytes though not in characters', async () => {
    const mine = 'é'.repeat(12_000); // 12,000 characters, 24,000 bytes
    fs.writeFileSync(agentsMd(), mine);
    const rules = await blockPart('x');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    const hash = sha(agentsMd());
    await expect(deliver()).rejects.toMatchObject({ code: 'antigravity_instructions_too_large' });
    expect(sha(agentsMd())).toBe(hash);
  });

  it('refuses a linked AGENTS.md and leaves its target alone', async () => {
    const target = path.join(root, 'elsewhere.md');
    fs.writeFileSync(target, 'outside');
    try { fs.symlinkSync(target, agentsMd()); } catch { return; /* no symlink rights (Windows without developer mode) */ }
    const rules = await blockPart('x');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await expect(deliver()).rejects.toMatchObject({ code: 'antigravity_instructions_unsafe' });
    expect(fs.readFileSync(target, 'utf-8')).toBe('outside');
    expect(fs.lstatSync(agentsMd()).isSymbolicLink()).toBe(true);
  });

  it('refuses repeated or unpaired markers instead of guessing, and instructions that contain a marker', async () => {
    const rules = await blockPart('x');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    for (const body of [`${ANTIGRAVITY_BLOCK_BEGIN}\na\n${ANTIGRAVITY_BLOCK_END}\n${ANTIGRAVITY_BLOCK_BEGIN}\nb\n${ANTIGRAVITY_BLOCK_END}\n`, `mine\n${ANTIGRAVITY_BLOCK_BEGIN}\nno end\n`, `${ANTIGRAVITY_BLOCK_END}\n${ANTIGRAVITY_BLOCK_BEGIN}\n`]) {
      fs.writeFileSync(agentsMd(), body);
      await expect(deliver()).rejects.toMatchObject({ code: 'antigravity_instructions_markers' });
      expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe(body);
    }
    fs.rmSync(agentsMd());
    const sneaky = await blockPart(`a\n${ANTIGRAVITY_BLOCK_END}\nb`);
    agent.managed = { version: 1, blocks: [sneaky.id], skills: [], mcps: [] };
    await expect(deliver()).rejects.toMatchObject({ code: 'antigravity_instructions_markers' });
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('merges managed MCP servers into the person\'s MCP file, keeping their entries, and removes ones taken out of the setup', async () => {
    const mcpFile = path.join(wt, '.agents', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    const mine = '{\n  // my servers\n  "mcpServers": {\n    "mine": { "command": "mine" }\n  }\n}\n';
    fs.writeFileSync(mcpFile, mine);
    const workiq = await user(() => service.createPart({ name: 'WorkIQ', content: { kind: 'mcp', serverKey: 'workiq', transport: 'stdio', command: 'npx', args: ['-y', 'workiq-mcp'] } }));
    const docs = await user(() => service.createPart({ name: 'Docs', content: { kind: 'mcp', serverKey: 'docs', transport: 'http', url: 'https://example.test/mcp' } }));
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [workiq.id, docs.id] };
    const first = await deliver();
    const merged = fs.readFileSync(mcpFile, 'utf-8');
    expect(merged).toContain('// my servers');
    expect(merged).toContain('"mine": { "command": "mine" }');
    expect(merged).toContain('"workiq": {"command":"npx","args":["-y","workiq-mcp"]}');
    expect(merged).toContain('"docs": {"type":"http","url":"https://example.test/mcp"}');
    expect(first?.provider).toBe(ANTIGRAVITY_PROVIDER_ID);

    // Docs taken out of the setup: its line goes (by the ownership receipt), the person's text and WorkIQ stay.
    agent.managed = { version: 1, blocks: [], skills: [], mcps: [workiq.id] };
    await deliver();
    const after = fs.readFileSync(mcpFile, 'utf-8');
    expect(after).not.toContain('"docs"');
    expect(after).toContain('"workiq"');
    expect(after).toContain('// my servers');
    expect(after).toContain('"mine": { "command": "mine" }');

    // A start on another CLI takes Clubhouse's servers out and leaves the person's file as it was.
    await deliver(other('claude-code'));
    expect(fs.readFileSync(mcpFile, 'utf-8')).toBe(mine);
  });

  it('refuses the start, writing nothing, when a managed MCP server name is already the person\'s', async () => {
    const mcpFile = path.join(wt, '.agents', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, '{ "mcpServers": { "workiq": { "command": "my-own" } } }\n');
    const workiq = await user(() => service.createPart({ name: 'WorkIQ', content: { kind: 'mcp', serverKey: 'workiq', transport: 'stdio', command: 'npx' } }));
    const rules = await blockPart('x');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [workiq.id] };
    const before = snapshot(wt);
    const err = await deliver().catch((e: unknown) => e);
    expect(isManagedStartRefused(err)).toBe(true);
    expect(err).toMatchObject({ code: 'antigravity_mcp_ambiguous_ownership' });
    expect((err as Error).message).toMatch(/did not start/);
    expect(snapshot(wt)).toEqual(before);
  });

  it('refuses the start when a write fails after the checks, and returns no record', async () => {
    fs.mkdirSync(path.join(wt, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.agents', 'skills'), 'a file where the skills folder goes');
    const rules = await blockPart('x');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    const err = await deliver().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'antigravity_delivery_incomplete' });
    expect(isManagedStartRefused(err)).toBe(true);
  });

  it('switching to another CLI takes out only the block; an AGENTS.md Clubhouse alone wrote goes', async () => {
    const rules = await blockPart('x');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    const mine = Buffer.from('# mine\r\nkeep é\n');
    fs.writeFileSync(agentsMd(), mine);
    await deliver();
    await deliver(other('claude-code'));
    expect(fs.readFileSync(agentsMd()).equals(mine)).toBe(true);

    fs.rmSync(agentsMd());
    await deliver();
    expect(fs.existsSync(agentsMd())).toBe(true);
    await deliver(other('claude-code'));
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('keeps an AGENTS.md git tracks when only the block was in it', async () => {
    execFileSync('git', ['init', '-q'], { cwd: wt });
    fs.writeFileSync(agentsMd(), '');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: wt });
    const rules = await blockPart('x');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await deliver();
    await deliver(other('claude-code'));
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe('');
  });

  it('leaves Codex delivery as it was (AGENTS.md written whole), keeping a copy of the person\'s text beside the block first', async () => {
    const rules = await blockPart('codex text');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    const before = `${ANTIGRAVITY_BLOCK_BEGIN}\nold\n${ANTIGRAVITY_BLOCK_END}\nmine\n`;
    fs.writeFileSync(agentsMd(), before);
    const record = await deliver(other('codex-cli'));
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe('codex text');
    expect(record?.instructionsLimit).toBeUndefined();
    expect(h.copies).toEqual([{ agentId: agent.id, file: 'AGENTS.md', content: before }]);
    // No block, or only the block: nothing to keep, so no copy.
    await deliver(other('codex-cli'));
    fs.writeFileSync(agentsMd(), `${ANTIGRAVITY_BLOCK_BEGIN}\nold\n${ANTIGRAVITY_BLOCK_END}\n`);
    await deliver(other('codex-cli'));
    expect(h.copies).toHaveLength(1);
  });

  it('keeps untracked text that equals the instructions as the person\'s, through a delivery and a switch away', async () => {
    // Equal text isn't proof Clubhouse wrote it (an earlier Codex start would also leave it), so it is kept.
    fs.writeFileSync(agentsMd(), 'same text');
    const rules = await blockPart('same text');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await deliver();
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe(`${ANTIGRAVITY_BLOCK_BEGIN}\nsame text\n${ANTIGRAVITY_BLOCK_END}\nsame text`);
    await deliver(other('claude-code'));
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe('same text');
  });

  it('reads markers only as whole lines: CRLF is fine, extra text on a marker line or an edited marker is refused', async () => {
    const rules = await blockPart('new');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    const crlf = `mine\r\n${ANTIGRAVITY_BLOCK_BEGIN}\r\nold\r\n${ANTIGRAVITY_BLOCK_END}\r\nafter\r\n`;
    fs.writeFileSync(agentsMd(), crlf);
    await deliver();
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe(`mine\r\n${ANTIGRAVITY_BLOCK_BEGIN}\nnew\n${ANTIGRAVITY_BLOCK_END}\nafter\r\n`);
    for (const body of [
      `${ANTIGRAVITY_BLOCK_BEGIN} my note\nold\n${ANTIGRAVITY_BLOCK_END}\n`,
      `${ANTIGRAVITY_BLOCK_BEGIN}\nold\n${ANTIGRAVITY_BLOCK_END}trailing\n`,
      `<!-- BEGIN clubhouse-managed antigravity-cli -->\nold\n${ANTIGRAVITY_BLOCK_END}\n`,
      `mine\n<!-- END clubhouse-managed\n`,
    ]) {
      fs.writeFileSync(agentsMd(), body);
      await expect(deliver(), body).rejects.toMatchObject({ code: 'antigravity_instructions_markers' });
      expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe(body);
    }
    // A marker in the middle of a line is the person's text.
    fs.writeFileSync(agentsMd(), `see ${ANTIGRAVITY_BLOCK_BEGIN}\n`);
    await deliver();
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe(`${ANTIGRAVITY_BLOCK_BEGIN}\nnew\n${ANTIGRAVITY_BLOCK_END}\nsee ${ANTIGRAVITY_BLOCK_BEGIN}\n`);
  });

  it('never writes over an edit made between reading AGENTS.md and writing it', async () => {
    fs.writeFileSync(agentsMd(), 'mine\n');
    const plan = await planAntigravityInstructions(wt, 'managed');
    fs.writeFileSync(agentsMd(), 'mine, edited meanwhile\n');
    await expect(commitAntigravityInstructions(plan)).rejects.toMatchObject({ code: 'antigravity_instructions_changed' });
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe('mine, edited meanwhile\n');
    // Created meanwhile, where there was no file.
    fs.rmSync(agentsMd());
    const fresh = await planAntigravityInstructions(wt, 'managed');
    fs.writeFileSync(agentsMd(), 'new file\n');
    await expect(commitAntigravityInstructions(fresh)).rejects.toMatchObject({ code: 'antigravity_instructions_changed' });
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe('new file\n');
    expect(fs.readdirSync(wt).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps a tracked AGENTS.md that happens to match the instructions as the project\'s text', async () => {
    execFileSync('git', ['init', '-q'], { cwd: wt });
    fs.writeFileSync(agentsMd(), 'same text');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: wt });
    const rules = await blockPart('same text');
    agent.managed = { version: 1, blocks: [rules.id], skills: [], mcps: [] };
    await deliver();
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe(`${ANTIGRAVITY_BLOCK_BEGIN}\nsame text\n${ANTIGRAVITY_BLOCK_END}\nsame text`);
    await deliver(other('claude-code'));
    expect(fs.readFileSync(agentsMd(), 'utf-8')).toBe('same text');
  });
});
