import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

/** Settings-audit rows when a managed setup or the Clubhouse features switch is written (D13). */

const files = new Map<string, string>();

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (...args: unknown[]) => void) => { cb(null, ''); return {}; }),
  execFile: vi.fn((_f: string, _a: string[], _opts: unknown, cb: (...args: unknown[]) => void) => { cb(null, ''); return {}; }),
}));
vi.mock('fs', () => ({ watch: vi.fn(() => ({ on: vi.fn().mockReturnThis(), close: vi.fn() })) }));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const data = files.get(String(p));
    if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return data;
  }),
  writeFile: vi.fn(async (p: string, data: string) => { files.set(String(p), String(data)); }),
  rename: vi.fn(async (src: string, dest: string) => {
    const data = files.get(String(src));
    if (data !== undefined) files.set(String(dest), data);
    files.delete(String(src));
  }),
  stat: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
  copyFile: vi.fn(async () => undefined),
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
}));
vi.mock('./fs-utils', () => ({ pathExists: vi.fn(async (p: string) => files.has(String(p))) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./git-service', () => ({ isInsideGitRepo: vi.fn(async () => false) }));
vi.mock('./agent-settings-service', () => ({
  applyAgentDefaults: vi.fn(async () => undefined),
  readProjectAgentDefaults: vi.fn(async () => ({})),
}));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn() }));

const audited = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./settings-audit', async (original) => ({
  ...await original<typeof import('./settings-audit')>(),
  auditChanges: vi.fn(async (...args: unknown[]) => { audited.calls.push(args); }),
}));

import { clearAgentConfigCache, flushAgentConfig, getDurableConfig, setClubhouseFeatures, setManagedMigration, setManagedSetup } from './agent-config';
import { CLUBHOUSE_MCP_PART_ID } from '../../shared/managed-agents-types';

const PROJECT_PATH = path.resolve('managed-audit-project');
const CONFIG_PATH = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');

/** The before and after each audit call compared, keyed as auditChanges keys them. */
function lastAudit() {
  const [scope, prefix, targetId, before, after, catalog] = audited.calls.at(-1)!;
  return { scope, prefix, targetId, before, after, catalog };
}

beforeEach(() => {
  clearAgentConfigCache();
  files.clear();
  audited.calls = [];
  files.set(CONFIG_PATH, JSON.stringify([{ id: 'a1', name: 'ada', color: 'blue', persona: 'qa', worktreePath: path.join(PROJECT_PATH, 'wt') }]));
});

describe('managed setup audit (D13)', () => {
  it('checks the authorized record after async preparation and before mutating or auditing it', async () => {
    let allowed = true;
    const check = vi.fn((agent: { id: string }) => {
      expect(agent.id).toBe('a1');
      if (!allowed) throw new Error('permission revoked');
    });
    await expect(setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: [] }, {
      prepare: async () => { allowed = false; }, check,
    })).rejects.toThrow('permission revoked');
    expect(check).toHaveBeenCalledOnce();
    expect((await getDurableConfig(PROJECT_PATH, 'a1'))?.managed).toBeUndefined();
    expect(JSON.parse(files.get(CONFIG_PATH)!)[0].managed).toBeUndefined();
    expect(audited.calls).toEqual([]);
  });
  it.each(['renamed', 'disposed'] as const)('refuses the current record %s during preparation without restoring its stale snapshot', async (change) => {
    // Warm the cache so preparation can replace the exact snapshot an early read would capture.
    await getDurableConfig(PROJECT_PATH, 'a1');
    const changed = { ...JSON.parse(files.get(CONFIG_PATH)!)[0],
      ...(change === 'renamed' ? { name: 'new-name' } : { disposedAt: '2026-11-14T00:00:00Z' }),
    };
    const check = vi.fn((agent: { name: string; disposedAt?: string }) => {
      if (agent.name !== 'ada' || agent.disposedAt) throw new Error('target changed');
    });
    await expect(setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: [] }, {
      prepare: async () => {
        files.set(CONFIG_PATH, JSON.stringify([changed]));
        clearAgentConfigCache(PROJECT_PATH);
        await getDurableConfig(PROJECT_PATH, 'a1');
      },
      check,
    })).rejects.toThrow('target changed');
    await flushAgentConfig(PROJECT_PATH);
    expect(check).toHaveBeenCalledOnce();
    expect(JSON.parse(files.get(CONFIG_PATH)!)).toEqual([changed]);
    expect((await getDurableConfig(PROJECT_PATH, 'a1'))?.managed).toBeUndefined();
    expect(audited.calls).toEqual([]);
  });

  it('records managing an agent: the template as a value, the part lists as changed', async () => {
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: 'builtin-template-helper' });
    const audit = lastAudit();
    expect(audit).toMatchObject({ scope: 'agent', prefix: 'agent', targetId: 'a1' });
    expect(audit.before).toMatchObject({ managed: false, persona: 'qa' });
    // The saved persona stays: legacy values are never deleted, only ignored while managed.
    expect(audit.after).toMatchObject({ managed: true, 'managed.templateId': 'builtin-template-helper', 'managed.blocks': ['b1'], persona: 'qa' });
    expect(audit.after).not.toHaveProperty('mcpOverride');
    expect(audit.catalog).toEqual({
      managed: 'value', 'managed.templateId': 'value', 'managed.blocks': 'changed', 'managed.skills': 'changed', 'managed.mcps': 'changed',
      clubhouseFeatures: 'value', persona: 'value',
    });
  });

  it('records a setup change and unmanaging', async () => {
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: [] });
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1', 'b2'], skills: [], mcps: [] });
    expect(lastAudit().before).toMatchObject({ 'managed.blocks': ['b1'] });
    expect(lastAudit().after).toMatchObject({ 'managed.blocks': ['b1', 'b2'] });
    await setManagedSetup(PROJECT_PATH, 'a1', null);
    expect(lastAudit().after).toMatchObject({ managed: false, 'managed.blocks': undefined });
  });

  it('records the Clubhouse features switch with its values', async () => {
    await setClubhouseFeatures(PROJECT_PATH, 'a1', false);
    expect(lastAudit()).toMatchObject({
      targetId: 'a1', before: { clubhouseFeatures: undefined }, after: { clubhouseFeatures: false },
      catalog: { clubhouseFeatures: 'value' },
    });
    // Hooks only: an agent's Clubhouse MCP is never turned off (D70).
    expect(await getDurableConfig(PROJECT_PATH, 'a1')).not.toHaveProperty('mcpOverride');
  });

  it('adds the Clubhouse MCP part first when a setup leaves it out (D69)', async () => {
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: ['m1'] });
    expect((await getDurableConfig(PROJECT_PATH, 'a1'))?.managed?.mcps).toEqual([CLUBHOUSE_MCP_PART_ID, 'm1']);
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: ['m1', CLUBHOUSE_MCP_PART_ID] });
    expect((await getDurableConfig(PROJECT_PATH, 'a1'))?.managed?.mcps).toEqual(['m1', CLUBHOUSE_MCP_PART_ID]);
  });

  it('keeps who saved it, when, and start_helper\'s changes, none of them as settings rows (D90, D91)', async () => {
    await setManagedSetup(PROJECT_PATH, 'a1', {
      version: 1, blocks: ['b1'], skills: [], mcps: [], helperChanges: { added: ['b1'], removed: ['b0'] }, updatedAt: 't1', updatedBy: 'Dispatcher',
    });
    expect((await getDurableConfig(PROJECT_PATH, 'a1'))?.managed).toMatchObject({ helperChanges: { added: ['b1'], removed: ['b0'] }, updatedAt: 't1', updatedBy: 'Dispatcher' });
    expect(Object.keys(lastAudit().after as object).some((k) => /updated|helper/i.test(k))).toBe(false);
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: [] });
    const after = (await getDurableConfig(PROJECT_PATH, 'a1'))?.managed;
    expect(after).not.toHaveProperty('updatedBy');
    expect(after).not.toHaveProperty('helperChanges');
  });
});

describe('the automatic switch marker (D59)', () => {
  it('records a failure, which a switch clears, then the switch, and a dismissal that keeps the marker; none of it is a settings row', async () => {
    await setManagedMigration(PROJECT_PATH, 'a1', { failed: { at: 't0', code: 'invalid', message: 'No.' } });
    expect((await getDurableConfig(PROJECT_PATH, 'a1'))?.managedMigrationFailure).toEqual({ at: 't0', code: 'invalid', message: 'No.' });
    expect(audited.calls).toEqual([]);

    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: [], skills: [], mcps: [] });
    expect((await getDurableConfig(PROJECT_PATH, 'a1'))?.managedMigrationFailure).toBeUndefined();

    audited.calls = [];
    await setManagedMigration(PROJECT_PATH, 'a1', { migrated: { at: 't1', from: 'persona', backup: 'b' } });
    await setManagedMigration(PROJECT_PATH, 'a1', { dismissed: true });
    await setManagedMigration(PROJECT_PATH, 'a1', { layerCarriedAt: 't2' });
    const after = await getDurableConfig(PROJECT_PATH, 'a1');
    expect(after?.managedMigration).toEqual({ at: 't1', from: 'persona', backup: 'b', dismissed: true });
    expect(after?.personaLayerCarriedAt).toBe('t2');
    expect(audited.calls).toEqual([]);
    // A missing agent is a no-op.
    await expect(setManagedMigration(PROJECT_PATH, 'nobody', { dismissed: true })).resolves.toBeUndefined();
  });

  it('marks the first switch from unmanaged to managed in the same write as the setup, and keeps it through setup changes and Stop managing', async () => {
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: [], skills: [], mcps: [] });
    await flushAgentConfig(PROJECT_PATH);
    // In agents.json itself, beside the setup: one write.
    const written = (JSON.parse(files.get(CONFIG_PATH)!) as Array<Record<string, unknown>>)[0];
    expect(written.managed).toBeDefined();
    const at = written.switchedToManagedAt;
    expect(at).toEqual(expect.any(String));

    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: [] });
    await setManagedSetup(PROJECT_PATH, 'a1', null);
    const after = await getDurableConfig(PROJECT_PATH, 'a1');
    expect(after?.managed).toBeUndefined();
    expect(after?.switchedToManagedAt).toBe(at);
    // Bookkeeping, not a setting: not in the audit rows.
    expect(audited.calls.every((c) => !Object.keys(c[4] as object).includes('switchedToManagedAt'))).toBe(true);
  });
});
