/** Private synthetic review data only. No app, process, provider or native scan. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAssetCatalogStore, installBuiltinAsset } from '../src/main/services/asset-catalog/store';

export async function prepareSkillLibraryReview(root: string, sourceHead: string) {
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('Exact reviewed head required');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(root)).length) throw new Error('Empty private fixture directory required');
  await fs.chmod(root, 0o700); root = await fs.realpath(root);
  const profile = path.join(root, 'profile'); const base = path.join(profile, '.clubhouse-dev');
  const json = async (file: string, value: unknown) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 }); };
  const projects = ['one', 'two'].map((id) => ({ id: `skill-review-${id}`, name: `Skill review ${id}`, path: path.join(root, `project-${id}`) }));
  for (const project of projects) {
    await json(path.join(project.path, '.clubhouse', 'agents.json'), []);
    await fs.writeFile(path.join(project.path, 'CLAUDE.md'), 'Synthetic ambient fixture. Catalog edits leave this file unchanged.\n');
  }
  await json(path.join(base, 'projects.json'), { version: 1, projects });
  for (const [name, value] of Object.entries({
    'orchestrator-settings.json': { enabled: [], autoDetected: true, hookServerEnabled: { 'claude-code': false } },
    'dispatcher-settings.json': { enabled: false }, 'mcp-settings.json': { enabled: false, projectOverrides: {} },
    'experimental-settings.json': { newChrome: true, chat: false },
    'update-settings.json': { autoUpdate: false, previewChannel: false, lastSeenVersion: '0.42.0' },
    'telemetry-settings.json': { enabled: false, consentVersion: 0, destinations: [] },
  })) await json(path.join(profile, name), value);
  const catalogDir = path.join(base, 'asset-catalog');
  let next = 0;
  const catalog = createAssetCatalogStore({ dir: catalogDir, newId: () => `asset-review-${++next}` });
  const payload = (skillName: string) => ({ skillName, files: [
    { path: 'SKILL.md', content: `# ${skillName}\n\nSee [guide](references/guide.md). Literal @@AgentName.\n` },
    { path: 'references/guide.md', content: '../scripts/check.sh and ../assets/sample.bin are literal relative paths.\n' },
    { path: 'scripts/check.sh', content: '#!/bin/sh\nprintf "Synthetic fixture only. Do not execute.\\n"\n', executable: true },
    { path: 'assets/sample.bin', content: 'AAECA/7/', encoding: 'base64' as const },
  ] });
  const editable = await catalog.createAsset({ kind: 'skill', name: 'Editable complete bundle', payload: payload('editable-review') });
  const projectOwned = await catalog.createAsset({ kind: 'skill', name: 'Project-owned bundle', owner: { kind: 'project', projectId: projects[0].id }, payload: payload('project-review') });
  const builtin = await installBuiltinAsset(catalog, { assetId: 'builtin-review-skill', builtinId: 'review-fixture-only', kind: 'skill', name: 'Read-only built-in fixture', expectedRevision: 0, payload: payload('builtin-review') });
  const shared = await catalog.createAsset({ kind: 'skill', name: 'Shared consumer blocks edits', payload: payload('shared-review') });
  const block = await catalog.createAsset({ kind: 'block', name: 'Fixture role', payload: { content: 'Synthetic fixture only.' } });
  await catalog.createAsset({ kind: 'template', name: 'Synthetic consumer', payload: { entries: [{ entryId: 'Role', blockId: block.id, blockRevision: 1 }], subagents: [], skills: [shared.id], mcps: [] } });
  const manifest = { sourceHead, root, profile, projects, catalogDir, assets: { editable: editable.id, projectOwned: projectOwned.id, builtin: builtin.id, shared: shared.id } };
  await json(path.join(root, 'review-manifest.json'), manifest);
  await fs.writeFile(path.join(root, 'README.txt'), 'Synthetic catalog review only. No agents or providers. Use unpackaged guarded launcher; do not create/start agents, enable providers, scan/import or run scripts.\n');
  return manifest;
}
