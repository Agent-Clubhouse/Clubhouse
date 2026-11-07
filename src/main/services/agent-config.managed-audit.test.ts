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

import { clearAgentConfigCache, setClubhouseFeatures, setManagedSetup } from './agent-config';
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
  it('records managing an agent: the template and switches as values, the part lists as changed', async () => {
    await setManagedSetup(PROJECT_PATH, 'a1', { version: 1, blocks: ['b1'], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: 'builtin-template-helper' });
    const audit = lastAudit();
    expect(audit).toMatchObject({ scope: 'agent', prefix: 'agent', targetId: 'a1' });
    expect(audit.before).toMatchObject({ managed: false, persona: 'qa', mcpOverride: undefined });
    expect(audit.after).toMatchObject({ managed: true, 'managed.templateId': 'builtin-template-helper', 'managed.blocks': ['b1'], mcpOverride: true, persona: undefined });
    expect(audit.catalog).toEqual({
      managed: 'value', 'managed.templateId': 'value', 'managed.blocks': 'changed', 'managed.skills': 'changed', 'managed.mcps': 'changed',
      mcpOverride: 'value', clubhouseFeatures: 'value', persona: 'value',
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
      targetId: 'a1', before: { clubhouseFeatures: undefined, mcpOverride: undefined }, after: { clubhouseFeatures: false, mcpOverride: false },
      catalog: { clubhouseFeatures: 'value', mcpOverride: 'value' },
    });
  });
});
