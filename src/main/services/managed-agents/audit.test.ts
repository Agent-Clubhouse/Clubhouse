import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';

/** Settings-audit rows for managed agents' library writes (D13). */

const W = vi.hoisted(() => ({ home: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore, withDispatcherCatalogWrites } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, readSettingsAudit, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS } from './builtins';

const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

let service: ManagedAgentsService;
let agents: Map<string, DurableAgentConfig>;

/** Managed rows only, oldest first, without timestamps. */
async function managedRows() {
  const rows = await readSettingsAudit(50);
  return rows.reverse().map(({ ts: _ts, ...row }) => row).filter((r) => r.key.startsWith('managed.'));
}

beforeEach(async () => {
  W.home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-audit-'));
  agents = new Map();
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(W.home, 'catalog') }),
    state: createManagedStateStore(path.join(W.home, 'managed')),
    listProjects: async () => [{ path: path.join(W.home, 'project'), name: 'Project' }],
    listAgents: async () => [...agents.values()],
    getAgent: async (_p, id) => agents.get(id) ?? null,
    setManagedSetup: async (_p, id, setup) => {
      const a = agents.get(id);
      if (!a) throw new Error('missing');
      if (setup) a.managed = setup; else delete a.managed;
    },
    isRunning: () => false,
  });
  await service.ensureBuiltins();
  _resetSettingsAuditForTesting(true);
});

afterEach(() => {
  _resetSettingsAuditForTesting(false);
  fs.rmSync(W.home, { recursive: true, force: true });
});

describe('managed agents settings audit (D13)', () => {
  it('records part create, update and delete by id, with who asked and never the content', async () => {
    const part = await user(() => service.createPart({
      name: 'Secret server', description: 'Uses the vault',
      content: { kind: 'mcp', serverKey: 'vault', transport: 'stdio', command: 'vault-mcp', envVars: ['VAULT_TOKEN', 'VAULT_REGION'], args: ['--region', 'region-hunter2'] },
    }));
    const updated = await user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, description: 'Now with a new token',
      content: { kind: 'mcp', serverKey: 'vault', transport: 'stdio', command: 'vault-mcp', envVars: ['VAULT_TOKEN', 'VAULT_REGION'], args: ['--region', 'region-another'] } }));
    await user(() => service.deletePart({ id: part.id, expectedRevision: updated.revision, mode: 'remove' }));
    expect(await managedRows()).toEqual([
      { surface: 'ui', scope: 'app', key: 'managed.part.created', targetId: part.id, changed: true, outcome: 'ok' },
      { surface: 'ui', scope: 'app', key: 'managed.part.updated', targetId: part.id, changed: true, outcome: 'ok' },
      { surface: 'ui', scope: 'app', key: 'managed.part.deleted', targetId: part.id, changed: true, outcome: 'ok' },
    ]);
    const raw = fs.readFileSync(path.join(W.home, '.clubhouse-dev', 'settings-audit.jsonl'), 'utf-8');
    for (const secret of ['region-hunter2', 'region-another', 'VAULT_TOKEN', 'Secret server', 'vault-mcp', 'Uses the vault']) expect(raw).not.toContain(secret);
  });

  it('records a description-only edit, which writes no catalog revision', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'Be brief.' } }));
    await user(() => service.updatePart({ id: part.id, expectedRevision: part.revision, description: 'Short answers' }));
    expect((await managedRows()).map((r) => r.key)).toEqual(['managed.part.created', 'managed.part.updated']);
  });

  it('says the Dispatcher did it when the Dispatcher asked', async () => {
    const part = await withDispatcherCatalogWrites('dispatcher-1', () => service.createPart({ name: 'Notes', content: { kind: 'block', content: 'Take notes.' } }));
    expect(await managedRows()).toEqual([
      { surface: 'dispatcher', actorId: 'dispatcher-1', scope: 'app', key: 'managed.part.created', targetId: part.id, changed: true, outcome: 'ok' },
    ]);
  });

  it('records a fork, and the copies a delete makes, as created parts', async () => {
    const part = await user(() => service.createPart({ name: 'Rules', content: { kind: 'block', content: 'one' } }));
    agents.set('a1', { id: 'a1', name: 'ada', color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', managed: { version: 1, blocks: [part.id], skills: [], mcps: [] } });
    const fork = await user(() => service.forkPart({ id: BUILTIN_BLOCK_IDS.identity }));
    await user(() => service.deletePart({ id: part.id, expectedRevision: part.revision, mode: 'copy' }));
    const copyId = agents.get('a1')!.managed!.blocks[0];
    expect((await managedRows()).map((r) => [r.key, r.targetId])).toEqual([
      ['managed.part.created', part.id],
      ['managed.part.created', fork.id],
      ['managed.part.created', copyId],
      ['managed.part.deleted', part.id],
    ]);
  });

  it('records template save, push and delete, and the helper settings with their values', async () => {
    const template = await user(() => service.saveTemplate({ name: 'Release', description: 'Ships', setup: { blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] }, settings: {} }));
    await user(() => service.pushTemplate(template.id, { setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [] }, settings: {} }, []));
    await user(() => service.setDefaultHelperTemplateId(template.id));
    await user(() => service.setHelperTemplateChoice(true));
    await user(() => service.deleteTemplate(template.id));
    expect(await managedRows()).toEqual([
      { surface: 'ui', scope: 'app', key: 'managed.template.saved', targetId: template.id, changed: true, outcome: 'ok' },
      { surface: 'ui', scope: 'app', key: 'managed.template.pushed', targetId: template.id, changed: true, outcome: 'ok' },
      { surface: 'ui', scope: 'app', key: 'managed.defaultHelperTemplate', before: 'builtin-template-helper', after: template.id, outcome: 'ok' },
      { surface: 'ui', scope: 'app', key: 'managed.helperTemplateChoice', before: false, after: true, outcome: 'ok' },
      { surface: 'ui', scope: 'app', key: 'managed.template.deleted', targetId: template.id, changed: true, outcome: 'ok' },
    ]);
  });

  it('records nothing for a setting set to what it already was', async () => {
    await user(() => service.setHelperTemplateChoice(false));
    await user(() => service.setDefaultHelperTemplateId('builtin-template-helper'));
    expect(await managedRows()).toEqual([]);
  });
});
