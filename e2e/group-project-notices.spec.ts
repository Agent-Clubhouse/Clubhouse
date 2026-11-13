/**
 * #3362: a burst of group project posts reaches a member as one notice, with
 * no polling. The member is a chat agent on a fake `claude` that replays a
 * committed fixture, so no tokens are spent. A new group project in the
 * project's scope has the agent as a member (#3357), subscribed to `general`.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp, type LaunchedApp } from './launch';
import { addProject } from './smoke-helpers';

const AGENT = 'durable_gp_notice';

let fakes: FakeClis | undefined;
let app: LaunchedApp | undefined;
let projectDir: string | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  await fakes?.cleanup();
  fakes = undefined;
  if (projectDir) await fs.promises.rm(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  projectDir = undefined;
});

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-notices-e2e-'));
  fs.mkdirSync(path.join(dir, '.clubhouse'));
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([
    { id: AGENT, name: 'listener', color: 'emerald', createdAt: new Date().toISOString(), orchestrator: 'claude-code' },
  ]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# group project notices e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

test('three posts in a burst reach a member as one notice', async () => {
  test.setTimeout(120_000);
  fakes = await installFakeClis({ claude: 'multi-turn' });
  projectDir = makeProject();
  app = await launchApp({
    label: 'gp-notices',
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
    },
    env: fakes.env,
  });
  const w = app.window;
  await addProject(app.electronApp, w, projectDir);
  const projectId = await w.evaluate(async (dir) => {
    const projects = await window.clubhouse.project.list() as Array<{ id: string; path: string }>;
    return projects.find((p) => p.path.endsWith(dir.split(/[\\/]/).pop()!))!.id;
  }, projectDir);
  const gp = await w.evaluate((id) => window.clubhouse.groupProject.create('Release', { projectId: id }), projectId) as { id: string };

  // The agent is a member with no wire drawn; start it on the fake CLI.
  await expect.poll(async () => {
    const bindings = await w.evaluate(() => window.clubhouse.mcpBinding.getBindings()) as Array<{ agentId: string; targetId: string }>;
    return bindings.some((b) => b.agentId === AGENT && b.targetId === gp.id);
  }, { timeout: 15_000 }).toBe(true);
  await w.evaluate(({ id, dir }) => window.clubhouse.agent.spawnAgent({ agentId: id, projectPath: dir, cwd: dir, kind: 'durable', orchestrator: 'claude-code' }), { id: AGENT, dir: projectDir });
  await expect.poll(async () => (await fakes!.report('claude').catch(() => undefined))?.consumed ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  // Three posts in quick succession, from the user.
  for (const body of ['first', 'second', 'third']) {
    await w.evaluate(({ id, text }) => window.clubhouse.groupProject.postBulletinMessage(id, 'general', text), { id: gp.id, text: body });
  }

  // One notice, after the coalescing window, covering all three.
  const notices = async () => {
    const events = await w.evaluate((id) => window.clubhouse.chat.readTranscript(id), AGENT) as Array<{ type: string; data?: { source?: string; content?: Array<{ type: string; text?: string }> } }>;
    return events
      .filter((e) => e.type === 'user_message' && e.data?.source === 'group_project')
      .map((e) => (e.data?.content ?? []).map((c) => c.text ?? '').join(''));
  };
  await expect.poll(notices, { timeout: 45_000 }).toHaveLength(1);
  expect((await notices())[0]).toContain('3 new messages in #general from the user.');
  const report = await fakes.report('claude');
  expect(report.mismatch).toBeNull();
});
