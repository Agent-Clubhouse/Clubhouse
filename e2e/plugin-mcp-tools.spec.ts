/**
 * Plugin MCP tools in the production webpack build (#2078 follow-up).
 *
 * Plugin MCP calls carry a per-plugin token, which the renderer's plugin host
 * can only mint after main lets it claim the issuer. Main allows that only
 * for the main window's top frame showing the app entry URL, comparing the
 * frame's URL with MAIN_WINDOW_WEBPACK_ENTRY. In a packaged-style build that
 * entry is a raw file:// path, so this is where a spelling mismatch between
 * Node's and Chromium's URLs would surface: the claim would be refused and
 * every plugin MCP call would fail closed.
 *
 * The fixture plugin (fixtures/community-plugins/e2e-mcp-tools) holds
 * `mcp.tools`, is enabled at app level, contributes one tool in activate(),
 * and records what the host lists for it. No agent and no provider are
 * involved: nothing here spends tokens.
 *
 * NOTE: E2E runs only in CI; it is not run locally.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchApp } from './launch';
import { createDisposableProfile, type DisposableProfile } from './app-profile';

const PLUGIN_ID = 'e2e-mcp-tools';
const FIXTURE_SRC = path.resolve(__dirname, 'fixtures/community-plugins', PLUGIN_ID);
const MARKER = 'data-e2e-mcp-tools';

let electronApp: Awaited<ReturnType<typeof launchApp>>['electronApp'];
let window: Page;
let profile: DisposableProfile;
let pluginsDir: string;

/** Write a `_system` plugin-storage key the way the app stores it (global scope, kv/<key>.json). */
function seedSystemKey(userDataDir: string, key: string, value: unknown): void {
  const kvDir = path.join(userDataDir, '.clubhouse', 'plugin-data', '_system', 'kv');
  fs.mkdirSync(kvDir, { recursive: true });
  fs.writeFileSync(path.join(kvDir, `${key}.json`), JSON.stringify(value), 'utf-8');
}

/**
 * Every diag line (#2299) recorded so far this session, as `ns level msg`
 * text: main's appLog and the renderer's logging both land there (#2301,
 * #2302). userData is the app home under E2E.
 */
async function readDiagLog(userDataDir: string): Promise<string> {
  const logDir = path.join(userDataDir, '.clubhouse', 'logs');
  if (!fs.existsSync(logDir)) return '';
  const files = fs.readdirSync(logDir).filter((name) => name.startsWith('telemetry-') && name.endsWith('.jsonl'));
  const bodies = await Promise.all(files.map((name) => fs.promises.readFile(path.join(logDir, name), 'utf-8')));
  const lines: string[] = [];
  for (const raw of bodies.join('\n').split('\n')) {
    let line: { t?: unknown; ns?: unknown; level?: unknown; msg?: unknown };
    try {
      line = JSON.parse(raw);
    } catch {
      // A blank line, or one still being written.
      continue;
    }
    if (line.t === 'diag') lines.push(`${line.ns} ${line.level} ${line.msg}`);
  }
  return lines.join('\n');
}

test.beforeAll(async () => {
  pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-plugins-'));
  fs.cpSync(FIXTURE_SRC, path.join(pluginsDir, PLUGIN_ID), { recursive: true });

  profile = createDisposableProfile({ label: 'plugin-mcp' });
  // Community plugins load only with external plugins on; main reads this
  // flag at startup to trust the fixture's manifest (and its mcp.tools).
  seedSystemKey(profile.userDataDir, 'external-plugins-enabled', true);
  seedSystemKey(profile.userDataDir, 'app-enabled', [PLUGIN_ID]);

  ({ electronApp, window } = await launchApp({ profile, pluginsDir }));
  // The point of this spec: the packaged-style file:// renderer.
  expect(window.url().startsWith('file://')).toBe(true);
});

test.afterAll(async () => {
  await electronApp?.close();
  profile?.dispose();
  if (pluginsDir) fs.rmSync(pluginsDir, { recursive: true, force: true });
});

test('the plugin host claims the issuer, and a plugin with mcp.tools contributes a listed tool', async () => {
  const marker = () => window.evaluate((attr) => document.documentElement.getAttribute(attr), MARKER);

  await expect.poll(marker, { timeout: 30_000 }).not.toBeNull();
  // The plugin's own view: contributeTools and listContributedTools both
  // succeeded with its token, so the issuer claim and token issue did too.
  expect(await marker()).toBe(`listed:plugin__e2e_mcp_tools__e2e_echo`);

  // Main's view: it registered the tool, and never refused the host's claim.
  await expect.poll(() => readDiagLog(profile.userDataDir), { timeout: 15_000 })
    .toContain(`Plugin ${PLUGIN_ID} registered 1 MCP tools`);
  const log = await readDiagLog(profile.userDataDir);
  expect(log).not.toContain('Rejected plugin MCP issuer claim');
  expect(log).not.toContain('Could not claim the plugin MCP issuer');
});
