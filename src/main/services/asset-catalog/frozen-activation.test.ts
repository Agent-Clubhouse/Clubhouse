import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseAdoption } from '../../../shared/asset-catalog-types';
const W = vi.hoisted(() => ({ home: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
import { createAssetCatalogStore, prepareFrozenActivation, previewFrozenActivation, readFrozenActivation } from './store';
import { emptyComposition } from './planner';
import { withSettingsSurface } from '../settings-audit';

const adoption: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'accepted' } };
let store: ReturnType<typeof createAssetCatalogStore>;
let blockId: string;
beforeEach(async () => {
  W.home = await fs.mkdtemp(path.join(os.tmpdir(), 'frozen-activation-'));
  store = createAssetCatalogStore({ dir: path.join(W.home, 'catalog') });
  const block = await store.createAsset({ kind: 'block', name: 'Identity', payload: { content: 'Literal @@AgentName.\n日本語' }, owner: { kind: 'agent', agentId: 'agent-1' } });
  blockId = block.id;
  const composition = { ...emptyComposition(), entries: [{ localId: 'identity', source: { kind: 'local' as const, blockId } }] };
  const plan = await store.plan({ agentId: 'agent-1', adoption, draft: composition });
  await store.saveComposition({ agentId: 'agent-1', adoption, composition, expectedRevision: 0, previewFingerprint: plan.fingerprint });
});
afterEach(async () => { await fs.rm(W.home, { recursive: true, force: true }); });
const freeze = async () => {
  const plan = await store.plan({ agentId: 'agent-1', adoption });
  return prepareFrozenActivation(store, { agentId: 'agent-1', adoption, expectedFingerprint: plan.fingerprint, pinId: 'activation-pin-test' });
};

describe('main-internal retained activation payloads', () => {
  it('freezes literal exact bytes and survives edits, composition removal, tombstone and sweep', async () => {
    const { frozen, hash } = await freeze();
    expect(frozen.instructions).toBe('Literal @@AgentName.\n日本語');
    const impact = await store.previewAssetEdit({ assetId: blockId, payload: { content: 'new text' } });
    await store.saveRevision({ assetId: blockId, expectedRevision: 1, payload: { content: 'new text' }, impactFingerprint: impact.fingerprint });
    expect((await previewFrozenActivation(store, { agentId: 'agent-1', adoption })).instructions).toBe('new text');
    await store.removeAgent({ agentId: 'agent-1', expectedRevision: 1 });
    await store.sweep();
    const reopened = createAssetCatalogStore({ dir: path.join(W.home, 'catalog') });
    expect(await readFrozenActivation(reopened, frozen.pinId, hash)).toEqual(frozen);
    expect((await reopened.read()).runs[frozen.pinId]).toBeDefined();
  });
  it('reserves activation pins from generic recording/release and agent writes', async () => {
    const { frozen } = await freeze();
    await expect(store.recordRun({ runId: 'activation-pin-other', plan: frozen.plan })).rejects.toMatchObject({ code: 'agent_not_permitted' });
    await expect(store.releaseRun(frozen.pinId)).rejects.toMatchObject({ code: 'agent_not_permitted' });
    await withSettingsSurface('mcp', 'agent-1', async () => {
      await expect(freeze()).rejects.toMatchObject({ code: 'agent_not_permitted' });
      await expect(store.previewInstructions({ agentId: 'agent-1', adoption })).rejects.toMatchObject({ code: 'agent_not_permitted' });
    });
  });
  it('refuses stale adoption, forged hashes, and corrupted retained payloads without leaking text', async () => {
    await expect(prepareFrozenActivation(store, { agentId: 'agent-1', adoption, expectedFingerprint: '0'.repeat(64), pinId: 'activation-pin-test' })).rejects.toMatchObject({ code: 'stale_preview' });
    const { frozen, hash } = await freeze();
    await expect(readFrozenActivation(store, frozen.pinId, '0'.repeat(64))).rejects.toMatchObject({ code: 'payload_corrupt' });
    const file = path.join(W.home, 'catalog', 'revisions', blockId, '1.json');
    await fs.writeFile(file, 'SECRET broken content');
    await expect(readFrozenActivation(store, frozen.pinId, hash)).rejects.toThrow('payload_corrupt');
  });
  it('requires explicit adoption and refuses unsupported catalog MCP/native/operational delivery', async () => {
    await expect(previewFrozenActivation(store, { agentId: 'agent-1' } as never)).rejects.toMatchObject({ code: 'adoption_policy_required' });
    const mcp = await store.createAsset({ kind: 'mcp', name: 'MCP', payload: { serverKey: 'work', transport: 'stdio', command: 'example' } });
    const state = (await store.read()).compositions['agent-1'];
    const composition = { ...emptyComposition(), entries: state.entries, additions: [mcp.id] };
    const plan = await store.plan({ agentId: 'agent-1', adoption, draft: composition });
    await store.saveComposition({ agentId: 'agent-1', adoption, composition, expectedRevision: 1, previewFingerprint: plan.fingerprint });
    await expect(freeze()).rejects.toMatchObject({ code: 'plan_blocked' });
  });
});
