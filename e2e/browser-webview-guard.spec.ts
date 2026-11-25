/**
 * #3869: the Browser webview guards in the real app.
 *
 * A Browser widget on the app-wide canvas (seeded, then opened from the app
 * row) shows a page from a local server bound to 127.0.0.1. Then:
 * - Agent tools: main accepts that webview's webContents as the widget's
 *   target and refuses the main window's own. An agent on a fake `claude`,
 *   bound to the widget, reads the page with one browser tool call over the
 *   real Clubhouse MCP bridge.
 * - file://: with "Allow file:// URLs" off in every scope (the default), a
 *   load the renderer starts on the webview itself, which skips will-navigate,
 *   is stopped by the did-start-navigation backstop and never commits.
 *
 * No model and no network: the fake replays a committed fixture and the page
 * comes from this test.
 *
 * NOTE: E2E runs only in CI; it is not run locally.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { chatFixturePath } from '../src/main/orchestrators/adapters/testing/fake-cli';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { connectMcp } from './mcp-agent';
import { launchApp, type LaunchedApp } from './launch';
import { createDisposableProfile, type DisposableProfile } from './app-profile';
import { addProject, assertRunLayout } from './smoke-helpers';

const AGENT = 'durable_browser_guard';
const VIEW_ID = 'cv_e2e_browser';
const PAGE_MARKER = 'browser-guard-page';
const FILE_MARKER = 'browser-guard-local-file';

let fakes: FakeClis | undefined;
let profile: DisposableProfile | undefined;
let app: LaunchedApp | undefined;
let server: http.Server | undefined;
let scratch: string | undefined;

test.afterEach(async () => {
  await app?.electronApp.close().catch(() => {});
  app = undefined;
  profile?.dispose();
  profile = undefined;
  await fakes?.cleanup();
  fakes = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  scratch = undefined;
});

/** A page with a marker, on 127.0.0.1 only. */
async function startPageServer(): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>guard</title><body><p id="m">${PAGE_MARKER}</p></body>`);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}

/** A git repo with one durable agent. */
function makeProject(root: string): string {
  const dir = path.join(root, 'browser-guard-project');
  fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify([
    { id: AGENT, name: 'surfer', color: 'emerald', createdAt: new Date().toISOString(), orchestrator: 'claude-code' },
  ]));
  fs.writeFileSync(path.join(dir, 'README.md'), '# browser guard e2e\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test.local', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test.local' };
  execSync('git init -q && git add -A && git commit -qm init', { cwd: dir, env, stdio: 'pipe' });
  return dir;
}

/** Opens a session and goes quiet, so the agent stays up and holds the MCP bridge. */
async function writeQuietFixture(dir: string): Promise<string> {
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  const file = path.join(dir, 'quiet.jsonl');
  await fs.promises.writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** Seed the profile before launch: the Browser's app settings and an app-wide canvas holding one Browser widget. */
function seedProfile(userDataDir: string, pageUrl: string): void {
  const plugins = path.join(userDataDir, '.clubhouse', 'plugin-data');
  const systemKv = path.join(plugins, '_system', 'kv');
  fs.mkdirSync(systemKv, { recursive: true });
  // Localhost on so the widget shows the local page; file:// stays off (the default).
  fs.writeFileSync(path.join(systemKv, 'settings-app-browser.json'), JSON.stringify({ allowLocalhost: true, allowFileProtocol: false }));

  const canvasKv = path.join(plugins, 'canvas', 'kv');
  fs.mkdirSync(canvasKv, { recursive: true });
  const instances = [{
    id: 'canvas_e2e_browser', name: 'browser-board',
    views: [{
      id: VIEW_ID, type: 'plugin', pluginWidgetType: 'plugin:browser:webview', pluginId: 'browser',
      position: { x: 40, y: 40 }, size: { width: 640, height: 480 },
      title: 'Browser', displayName: 'Browser', zIndex: 0, metadata: { url: pageUrl },
    }],
    viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1,
  }];
  for (const [key, value] of Object.entries({ 'canvas-instances': instances, 'canvas-instances-backup': instances, 'canvas-active-id': 'canvas_e2e_browser' })) {
    for (const name of [`${key}.json`, `${key}.json.bak`]) fs.writeFileSync(path.join(canvasKv, name), JSON.stringify(value));
  }
}

/** Main-process core:security diag lines, with their meta. */
async function securityLines(userDataDir: string): Promise<Array<{ msg: string; meta?: Record<string, unknown> }>> {
  const logDir = path.join(userDataDir, '.clubhouse', 'logs');
  if (!fs.existsSync(logDir)) return [];
  const files = fs.readdirSync(logDir).filter((name) => name.startsWith('telemetry-') && name.endsWith('.jsonl'));
  const out: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  for (const name of files) {
    for (const raw of (await fs.promises.readFile(path.join(logDir, name), 'utf-8')).split('\n')) {
      try {
        const line = JSON.parse(raw);
        if (line.t === 'diag' && line.ns === 'core:security') out.push({ msg: String(line.msg), meta: line.meta });
      } catch {
        // A blank line, or one still being written.
      }
    }
  }
  return out;
}

const registerWebview = (w: Page, widgetId: string, wcId: number) =>
  w.evaluate(({ id, wc }) => window.clubhouse.mcpBinding.registerWebview(id, String(wc)), { id: widgetId, wc: wcId }) as Promise<unknown>;

test('a Browser webview takes agent tools and refuses programmatic file:// loads', async () => {
  test.setTimeout(180_000);
  scratch = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'browser-guard-e2e-')));
  const pageUrl = await startPageServer();
  const localFile = path.join(scratch, 'local.html');
  fs.writeFileSync(localFile, `<!doctype html><body>${FILE_MARKER}</body>`);
  const fileUrl = pathToFileURL(localFile).href;
  const projectDir = makeProject(scratch);

  fakes = await installFakeClis({ claude: await writeQuietFixture(scratch) });
  profile = createDisposableProfile({ label: 'browser-guard' });
  seedProfile(profile.userDataDir, pageUrl);
  app = await launchApp({
    profile,
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
    },
    env: fakes.env,
  });
  const { electronApp, window: w } = app;
  await assertRunLayout(w);

  // An agent on the fake CLI, as an MCP client.
  await addProject(electronApp, w, projectDir);
  await w.evaluate(({ id, dir }) => window.clubhouse.agent.spawnAgent({ agentId: id, projectPath: dir, cwd: dir, kind: 'durable', orchestrator: 'claude-code' }), { id: AGENT, dir: projectDir });
  await expect.poll(async () => (await fakes!.report('claude').catch((): undefined => undefined))?.env.CLUBHOUSE_AGENT_ID, { timeout: 30_000 }).toBe(AGENT);
  const mcp = await connectMcp((await fakes.report('claude')).env);

  // The real Browser widget, on the app-wide canvas.
  await w.getByTestId('app-row-canvas').click();
  const webview = w.locator('webview[partition="persist:plugin-browser"]');
  await expect(webview).toHaveCount(1, { timeout: 20_000 });
  const guestUrl = () => electronApp.evaluate(({ webContents }) =>
    webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview').map((wc) => wc.getURL()));
  await expect.poll(guestUrl, { timeout: 20_000 }).toEqual([pageUrl]);

  await test.step('main accepts the Browser webview as a tool target and refuses the app window', async () => {
    let guestId = -1;
    await expect.poll(async () => {
      guestId = await webview.evaluate((el) => (el as unknown as { getWebContentsId(): number }).getWebContentsId()).catch(() => -1);
      return guestId;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    const windowId = await electronApp.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().find((wc) => wc.getType() === 'window' && wc.getURL() === url)?.id ?? -1, w.url());
    expect(windowId).toBeGreaterThan(0);

    expect(await registerWebview(w, 'e2e-not-a-webview', windowId)).toBe(false);
    expect(await registerWebview(w, VIEW_ID, guestId)).toBe(true);
    await expect.poll(async () => (await securityLines(app!.userDataDir))
      .some((l) => l.msg === 'Browser webview registration refused' && l.meta?.widgetId === 'e2e-not-a-webview'), { timeout: 15_000 }).toBe(true);
  });

  await test.step('a bound agent reads the page over the MCP bridge', async () => {
    await w.evaluate(({ agentId, targetId }) => window.clubhouse.mcpBinding.bind(agentId, { targetId, targetKind: 'browser', label: 'Browser' }), { agentId: AGENT, targetId: VIEW_ID });
    let tool = '';
    await expect.poll(async () => {
      tool = (await mcp.toolNames()).find((n) => n.startsWith('browser__') && n.endsWith('__get_page_content')) ?? '';
      return tool;
    }, { timeout: 15_000 }).not.toBe('');
    const read = await mcp.callText(tool, { selector: '#m' });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain(PAGE_MARKER);
  });

  await test.step('a programmatic file:// load is stopped before it commits', async () => {
    // Record every main-frame commit in the guest from here on.
    await electronApp.evaluate(({ webContents }) => {
      const g = globalThis as unknown as { __e2eCommits: string[] };
      g.__e2eCommits = [];
      for (const wc of webContents.getAllWebContents()) {
        if (wc.getType() === 'webview') wc.on('did-navigate', (_e, url) => g.__e2eCommits.push(url));
      }
    });
    // Both skip will-navigate: loadURL on the element, and a src change after attach.
    await webview.evaluate((el, url) => {
      void (el as unknown as { loadURL(u: string): Promise<void> }).loadURL(url).catch(() => {});
    }, fileUrl);
    const fileBlocks = async () => (await securityLines(app!.userDataDir))
      .filter((l) => l.meta?.stage === 'did-start-navigation' && l.meta?.protocol === 'file:').length;
    await expect.poll(fileBlocks, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const afterLoadUrl = await fileBlocks();
    await webview.evaluate((el, url) => el.setAttribute('src', url), fileUrl);
    await expect.poll(fileBlocks, { timeout: 15_000 }).toBeGreaterThan(afterLoadUrl);

    // Give a load that slipped through time to commit, then check it didn't.
    await w.waitForTimeout(2_000);
    const commits = await electronApp.evaluate(() => (globalThis as unknown as { __e2eCommits: string[] }).__e2eCommits);
    expect(commits.filter((url) => url.startsWith('file:'))).toEqual([]);
    expect((await guestUrl()).some((url) => url.startsWith('file:'))).toBe(false);
    // The guest is still on the page.
    expect(await guestUrl()).toEqual([pageUrl]);
  });
});
