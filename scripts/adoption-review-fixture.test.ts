import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const W = vi.hoisted(() => ({ profile: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.profile } }));
vi.mock('../src/main/services/log-service', () => ({ appLog: vi.fn() }));
import { prepareAdoptionReviewFixture, REVIEW_AGENT, SEEDED_AGENT, REVIEW_PROJECT } from './adoption-review-fixture';
import { createAssetCatalogStore } from '../src/main/services/asset-catalog/store';
import { createAgentBuilder, builderSnapshotAdoption } from '../src/main/services/asset-catalog/builder';
import { createManagedActivationService } from '../src/main/services/managed-activation/service';
import { establishDeliveryCapability } from '../src/main/services/managed-activation/capability';
const execute = promisify(execFile);
const head = 'a'.repeat(40);
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-adoption-review-test-')); W.profile = path.join(root, 'profile'); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('prepares isolated saved selection and clearly seeded receipt samples without a runtime', async () => {
  const fixture = await prepareAdoptionReviewFixture(root, head);
  const catalog = createAssetCatalogStore({ dir: path.join(fixture.profile, '.clubhouse-dev/asset-catalog') });
  const index = await catalog.read(); expect(index.compositions[REVIEW_AGENT].revision).toBe(1);
  const complete = await catalog.readRevision(fixture.coverage.completeSkill, 1);
  expect(complete).toMatchObject({ files: expect.arrayContaining([
    { path: 'assets/sample.bin', content: 'AAECA/7/', encoding: 'base64' },
    { path: 'scripts/check.sh', content: '#!/bin/sh\nexit 64\n', executable: true },
  ]) });
  const builder = createAgentBuilder(catalog, REVIEW_PROJECT);
  const skillComposition = await builder.compositionOf(fixture.coverage.skillAgent);
  const held = await builderSnapshotAdoption(catalog, skillComposition);
  const skillView = await builder.read(fixture.coverage.skillAgent, held);
  expect(skillView.skills?.map((item) => item.assetId)).toContain(fixture.coverage.completeSkill);
  const removedPreview = await builder.command(fixture.coverage.skillAgent, skillView.revision,
    { type: 'removeSkill', assetId: fixture.coverage.completeSkill, confirm: false }, held);
  const removed = await builder.command(fixture.coverage.skillAgent, skillView.revision,
    { type: 'removeSkill', assetId: fixture.coverage.completeSkill, confirm: true, fingerprint: removedPreview.skillFingerprint }, held);
  expect(removed.excludedSkills?.map((item) => item.assetId)).toContain(fixture.coverage.completeSkill);
  const restore = { type: 'skill' as const, assetId: fixture.coverage.completeSkill, expectedRevision: 1, confirm: false };
  const restoredPreview = await builder.command(fixture.coverage.skillAgent, removed.revision, restore, held);
  const restored = await builder.command(fixture.coverage.skillAgent, removed.revision,
    { ...restore, confirm: true, fingerprint: restoredPreview.skillFingerprint }, held);
  expect(restored.skills?.map((item) => item.assetId)).toContain(fixture.coverage.completeSkill);
  expect(await catalog.readRevision(fixture.coverage.completeSkill, 1)).toEqual(complete);
  for (const id of [fixture.coverage.nativeAgent, fixture.coverage.mcpAgent]) {
    await expect(builderSnapshotAdoption(catalog, await builder.compositionOf(id))).rejects.toMatchObject({ code: 'unsupported' });
  }

  const service = createManagedActivationService({ dir: path.join(fixture.profile, '.clubhouse-dev/managed-activation'), catalog, platform: 'darwin' });
  expect(await service.read(REVIEW_AGENT)).toBeNull();
  const seeded = (await service.read(SEEDED_AGENT))!;
  expect(Object.values(seeded.generations)).toHaveLength(6);
  expect(Object.values(seeded.generations).every((item) => item.preparedAt.startsWith('2000-'))).toBe(true);
  expect(await fs.readFile(path.join(root, 'README.txt'), 'utf8')).toContain('synthetic presentation samples');
  await expect(fs.stat(path.join(fixture.profile, '.clubhouse-dev/managed-activation', SEEDED_AGENT, 'generations'))).rejects.toMatchObject({ code: 'ENOENT' });
  // Validate the ordinary service contract with this actual executable and frozen catalog,
  // without invoking launch or a PTY. The real app retains all of its entry-point restrictions.
  const workspacePath = path.join(fixture.project, '.clubhouse/agents/review-agent');
  const ambient = await fs.readFile(path.join(workspacePath, 'CLAUDE.md'), 'utf8');
  const capability = await establishDeliveryCapability(fixture.binary, 'darwin');
  const request = { agentId: REVIEW_AGENT, projectId: REVIEW_PROJECT, expectedRevision: 0,
    adoption: { content: { mode: 'takeable' as const }, structure: { mode: 'accepted' as const } }, capability,
    workspace: { projectPath: fixture.project, workspacePath, agentName: 'review-agent', provider: 'claude-code', otherWorkspaces: [path.join(fixture.project, '.clubhouse/agents/seeded-receipts')] } };
  const preview = await service.preview(request); expect(preview.instructions).toContain('@@AgentName'); expect(preview.skillNames[0]).toMatch(/^clubhouse-agent-.*:review$/);
  const adopted = await service.adopt({ ...request, previewToken: preview.token });
  const restarted = createManagedActivationService({ dir: path.join(fixture.profile, '.clubhouse-dev/managed-activation'), catalog, platform: 'darwin' });
  expect((await restarted.read(REVIEW_AGENT))?.desired).toBe(adopted.desired);
  expect((await restarted.unassign(REVIEW_AGENT, adopted.revision)).desired).toBeNull();
  expect(await fs.readFile(path.join(workspacePath, 'CLAUDE.md'), 'utf8')).toBe(ambient);
  const privateFiles = await fs.readdir(path.join(fixture.profile, '.clubhouse-dev/managed-activation', REVIEW_AGENT)); expect(privateFiles).toEqual(['state.json']);
});
it.skipIf(process.platform === 'win32')('fake CLI accepts only exact capability queries and refuses everything else without logging text', async () => {
  const fixture = await prepareAdoptionReviewFixture(root, head);
  expect((await execute(fixture.binary, ['--version'])).stdout).toContain('2.1.316');
  expect((await execute(fixture.binary, ['--help'])).stdout).toContain('--plugin-dir');
  for (const args of [[], ['--version', 'extra'], ['--help', 'extra'], ['-p', 'PRIVATE_TEXT'], ['--resume', 'session']]) await expect(execute(fixture.binary, args)).rejects.toMatchObject({ code: 64 });
  const refused = await fs.readFile(`${fixture.binary}.refused.log`, 'utf8'); expect(refused.trim().split('\n')).toHaveLength(5); expect(refused).not.toContain('PRIVATE_TEXT');
  await expect(prepareAdoptionReviewFixture(root, head)).rejects.toThrow('empty private directory');
});
it.runIf(process.env.CLUBHOUSE_PREPARE_ADOPTION_REVIEW === '1')('prepares the persistent visual fixture', async () => {
  const persistent = process.env.CLUBHOUSE_ADOPTION_REVIEW_ROOT; const pinned = process.env.CLUBHOUSE_ADOPTION_REVIEW_HEAD;
  if (!persistent || !pinned || path.dirname(await fs.realpath(persistent)) !== await fs.realpath(os.tmpdir())
    || !path.basename(persistent).startsWith('clubhouse-adoption-review-')) throw new Error('Use the guarded review launcher and a fresh temporary root');
  W.profile = path.join(persistent, 'profile');
  const fixture = await prepareAdoptionReviewFixture(persistent, pinned);
  console.log(`Fixture prepared only; no Electron/provider launched. Manifest: ${path.join(fixture.root, 'review-manifest.json')}`);
});
