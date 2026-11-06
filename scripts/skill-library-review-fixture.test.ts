import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ profile: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.profile } }));
vi.mock('../src/main/services/log-service', () => ({ appLog: vi.fn() }));
import { prepareSkillLibraryReview } from './skill-library-review-fixture';
import { createAssetCatalogStore } from '../src/main/services/asset-catalog/store';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-skill-library-test-')); state.profile = path.join(root, 'profile'); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('prepares complete catalog fixtures through the real store, with no agents or running receipts', async () => {
  const fixture = await prepareSkillLibraryReview(root, 'a'.repeat(40));
  const catalog = createAssetCatalogStore({ dir: fixture.catalogDir }); const index = await catalog.read();
  expect(index.compositions).toEqual({}); expect(index.runs).toEqual({});
  const original = await catalog.readRevision(fixture.assets.editable, 1);
  expect(original).toMatchObject({ skillName: 'editable-review', files: expect.arrayContaining([
    { path: 'assets/sample.bin', content: 'AAECA/7/', encoding: 'base64' },
    expect.objectContaining({ path: 'scripts/check.sh', executable: true }),
  ]) });
  expect(index.assets[fixture.assets.builtin].source.kind).toBe('builtin');
  const impact = await catalog.previewAssetEdit({ assetId: fixture.assets.shared, payload: await catalog.readRevision(fixture.assets.shared, 1) });
  expect(impact.templates).toHaveLength(1);
  for (const project of fixture.projects) expect(JSON.parse(await fs.readFile(path.join(project.path, '.clubhouse', 'agents.json'), 'utf8'))).toEqual([]);
  await expect(prepareSkillLibraryReview(root, 'a'.repeat(40))).rejects.toThrow('Empty private');
});
it.runIf(process.env.CLUBHOUSE_PREPARE_SKILL_LIBRARY_REVIEW === '1')('prepares persistent skill library visual fixture', async () => {
  const directory = process.env.CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT; const head = process.env.CLUBHOUSE_SKILL_LIBRARY_REVIEW_HEAD;
  if (!directory || !head || path.dirname(await fs.realpath(directory)) !== await fs.realpath(os.tmpdir())
    || !path.basename(directory).startsWith('clubhouse-skill-library-review-')) throw new Error('Use the guarded temporary fixture launcher');
  state.profile = path.join(directory, 'profile');
  const fixture = await prepareSkillLibraryReview(directory, head);
  console.log(`Prepared only; no app/provider launched. Manifest: ${path.join(fixture.root, 'review-manifest.json')}`);
});
