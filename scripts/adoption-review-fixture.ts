/** Fixture preparation only. No production imports call this and no runtime is started. */
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BaseAdoption } from '../src/shared/asset-catalog-types';
import { createAssetCatalogStore } from '../src/main/services/asset-catalog/store';
import { emptyComposition } from '../src/main/services/asset-catalog/planner';
import { establishDeliveryCapability } from '../src/main/services/managed-activation/capability';
import { createManagedActivationService } from '../src/main/services/managed-activation/service';
import type { ActivationReceipt, PreparedGeneration } from '../src/main/services/managed-activation/types';

export const REVIEW_AGENT = 'adoption-review-agent';
export const SEEDED_AGENT = 'adoption-review-seeded';
export const REVIEW_PROJECT = 'adoption-review-project';
const execute = promisify(execFile);
const adoption: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'accepted' } };
const stamp = '2000-01-01T00:00:00.000Z';
export interface ReviewManifest { sourceHead: string; root: string; profile: string; project: string; binary: string; seededAgent: string; reviewAgent: string }

export async function prepareAdoptionReviewFixture(root: string, sourceHead: string): Promise<ReviewManifest> {
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('A pinned source head is required');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(root)).length) throw new Error('Fixture root must be an empty private directory');
  await fs.chmod(root, 0o700); root = await fs.realpath(root);
  const profile = path.join(root, 'profile'); const project = path.join(root, 'project');
  const base = path.join(profile, '.clubhouse-dev');
  const agents = [
    { id: REVIEW_AGENT, name: 'review-agent', displayName: 'Fake adoption review, no live agent' },
    { id: SEEDED_AGENT, name: 'seeded-receipts', displayName: 'Seeded receipts only, not observed' },
  ].map((agent) => ({ ...agent, worktreePath: path.join(project, '.clubhouse', 'agents', agent.name),
    color: 'indigo', createdAt: stamp, orchestrator: 'claude-code', runtimeMode: 'terminal' }));
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const json = async (file: string, value: unknown) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 }); };
  // Explicit FIXTURE settings, written before launch. The adoption API changes none of these.
  for (const [name, value] of Object.entries({
    'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true, hookServerEnabled: { 'claude-code': false } },
    'mcp-settings.json': { enabled: false, projectOverrides: {} }, 'clubhouse-mode-settings.json': { enabled: false, projectOverrides: {} },
    'chat-runtime-settings.json': { 'claude-code': { mode: 'terminal' } }, 'dispatcher-settings.json': { enabled: false },
    'experimental-settings.json': { newChrome: true, chat: false },
    'update-settings.json': { autoUpdate: false, previewChannel: false, lastSeenVersion: '0.42.0' },
    'telemetry-settings.json': { enabled: false, consentVersion: 0, destinations: [] },
  })) await json(path.join(profile, name), value);
  for (const agent of agents) {
    await fs.mkdir(agent.worktreePath, { recursive: true });
    await fs.writeFile(path.join(agent.worktreePath, 'CLAUDE.md'), 'Ambient fixture instructions. Adoption must leave this unchanged.\n');
  }
  await json(path.join(project, '.clubhouse/agents.json'), agents);
  await json(path.join(project, '.clubhouse/wires.json'), []);
  await json(path.join(base, 'projects.json'), { version: 1, projects: [{ id: REVIEW_PROJECT, name: 'Fake adoption review', path: project }] });
  await fs.writeFile(path.join(project, 'README.md'), '# Isolated visual fixture\nNo live agent or real provider may run.\n');
  await fs.writeFile(path.join(project, '.gitignore'), '.clubhouse/\n');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  for (const args of [['init', '-q'], ['add', 'README.md', '.gitignore'], ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'visual fixture']]) await execute('git', args, { cwd: project, env });
  const binary = path.join(root, 'capability-only-claude');
  // No command forwarding or provider binary lookup. Refusals never log argv/prompt text.
  await fs.writeFile(binary, `#!/bin/sh
if [ "$#" -eq 1 ]; then
  case "$1" in
    --version) printf '%s\\n' '2.1.316 (Claude Code)'; exit 0 ;;
    --help)
      if [ -f "$0.delay-help" ]; then sleep 2; fi
      printf '%s\\n' '  --append-system-prompt-file <path>' '  --plugin-dir <path>'; exit 0 ;;
  esac
fi
printf '%s\\n' 'REFUSED_NON_CAPABILITY_INVOCATION' >> "$0.refused.log"
printf '%s\\n' 'Fixture refuses every command except exact --help or --version.' >&2
exit 64
`, { mode: 0o700 });
  const catalog = createAssetCatalogStore({ dir: path.join(base, 'asset-catalog') });
  const skill = await catalog.createAsset({ kind: 'skill', name: 'Fixture review', payload: { skillName: 'review', files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review fixture text only\n---\nRead @@AgentName literally. No command interpolation.' }] } });
  for (const agent of agents) {
    const block = await catalog.createAsset({ kind: 'block', name: 'Fixture identity', owner: { kind: 'agent', agentId: agent.id },
      payload: { content: 'Fixture instructions for @@AgentName. Keep @@Path literal.\n\nThis is a visual review, with no live agent or real provider.' } });
    const composition = { ...emptyComposition(), entries: [{ localId: 'identity', source: { kind: 'local' as const, blockId: block.id } }], additions: [skill.id] };
    const request = { agentId: agent.id, projectId: REVIEW_PROJECT, adoption };
    const plan = await catalog.plan({ ...request, draft: composition });
    await catalog.saveComposition({ ...request, composition, expectedRevision: 0, previewFingerprint: plan.fingerprint });
  }
  // Creates valid frozen/pinned metadata through the same service; no launch/lease is invoked.
  // This Darwin evidence is fixture data. Actual app entry still rejects non-macOS delivery.
  const capability = await establishDeliveryCapability(binary, 'darwin');
  const service = createManagedActivationService({ dir: path.join(base, 'managed-activation'), catalog, platform: 'darwin' });
  const selected = agents[1];
  const request = { agentId: selected.id, projectId: REVIEW_PROJECT, adoption, expectedRevision: 0, capability,
    workspace: { projectPath: project, workspacePath: selected.worktreePath, agentName: selected.name, provider: 'claude-code', otherWorkspaces: [agents[0].worktreePath] } };
  const preview = await service.preview(request); const state = await service.adopt({ ...request, previewToken: preview.token });
  const sample = state.generations[state.desired!];
  const generation = (id: string, runs: PreparedGeneration['runs'] = [], materialized = false): PreparedGeneration => ({
    ...sample, id, preparedAt: stamp, runs, ...(materialized ? { materializedAt: stamp } : {}),
  });
  const intended = { attemptId: 'seeded-attempt', intendedAt: stamp };
  const examples = [generation('generation-seeded-prepared'), generation('generation-seeded-materialized', [], true),
    generation('generation-seeded-created', [{ ...intended, outcome: 'pty_process_created', startedAt: stamp, runtimeIdentity: 'SEEDED-NO-PROCESS', endedAt: stamp }], true),
    generation('generation-seeded-receipt-error', [{ ...intended, outcome: 'process_started_receipt_failed', startedAt: stamp, runtimeIdentity: 'SEEDED-NO-PROCESS', cleanupRequested: true, cleanupConfirmed: false }], true),
    generation('generation-seeded-not-created', [{ ...intended, outcome: 'process_not_created', endedAt: stamp }], true),
    generation('generation-seeded-intent', [intended], true)];
  const seeded: ActivationReceipt = { ...state, revision: 1, desired: examples[0].id, materialized: examples[1].id,
    generations: Object.fromEntries(examples.map((item) => [item.id, item])) };
  await json(path.join(base, 'managed-activation', selected.id, 'state.json'), seeded);
  const manifest = { sourceHead, root, profile, project, binary, reviewAgent: REVIEW_AGENT, seededAgent: SEEDED_AGENT };
  await json(path.join(root, 'review-manifest.json'), manifest);
  await fs.writeFile(path.join(root, 'README.txt'), 'VISUAL FIXTURE ONLY. NO REAL CLI OR LIVE AGENTS.\nThe seeded-receipts agent contains synthetic presentation samples. No process, exit, private publication or receipt failure was observed. No private generation files were staged.\nThe review-agent starts with saved catalog blocks/skill but no adoption receipt. Its human preview/adopt/unassign use ordinary production IPC and private fake CLI help/version only.\nDo not Start, wake, resume, sign in, or probe a provider.\n');
  return manifest;
}
