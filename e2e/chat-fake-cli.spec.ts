import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp } from './launch';
import { addProject } from './smoke-helpers';
import type { ChatFixtureCli } from '../src/main/orchestrators/adapters/testing/fake-cli';

/**
 * Native chat end to end over fake CLIs: zero tokens, real protocol traffic.
 *
 * `installFakeClis` pins every provider's binary to a fixture-replaying fake
 * (test/chat-fixtures/<cli>/<fixture>.jsonl) through the unpackaged-only
 * CLUBHOUSE_TEST_CLI_BINARIES seam, so resolution never reaches a real CLI at
 * a well-known install path, and each test checks the fake is what the app
 * spawned before it sends anything. The fake fails with a mismatch on any
 * message the fixture doesn't expect, and its report says whether the app
 * drove the whole fixture, so each test ends by asserting the CLI side as
 * well as the ChatView.
 *
 * The same three flows run one layer down, without the UI, in
 * src/main/services/agent-runtime/chat-fake-cli-flows.test.ts.
 */

interface ProviderCase {
  cli: ChatFixtureCli;
  orchestrator: string;
  /**
   * Whether `registerBuiltinChatDrivers()` registers a driver for this
   * provider on this branch. Without one the agent opens in the terminal.
   */
  registered: boolean;
}

const PROVIDERS: ProviderCase[] = [
  { cli: 'claude', orchestrator: 'claude-code', registered: true },
  // Registered by #1966 (CodexChatDriver) and #1961 (copilot_acp); flip
  // these to true when each lands.
  { cli: 'codex', orchestrator: 'codex-cli', registered: false },
  { cli: 'copilot', orchestrator: 'copilot-cli', registered: false },
];

const USER_DATA_FILES = {
  // Every provider enabled, so the create dialog offers all three without the
  // first-run CLI probe (which would find no real CLI).
  'orchestrator-settings.json': { enabled: PROVIDERS.map((p) => p.orchestrator), autoDetected: true },
  // Chat for every provider. Claude is pinned to the stream-json transport,
  // which is what its fixtures record (the Agent SDK is the default).
  'chat-runtime-settings.json': {
    'claude-code': { mode: 'chat', driver: 'claude_stream_json' },
    'codex-cli': { mode: 'chat' },
    'copilot-cli': { mode: 'chat' },
  },
};

const ENDED_TIMEOUT = 20_000;

let fakes: FakeClis | undefined;
let projectDir: string | undefined;

test.afterEach(async () => {
  await fakes?.cleanup();
  fakes = undefined;
  if (projectDir) await fs.promises.rm(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  projectDir = undefined;
});

/** Launch with Chat on and the fake CLI installed, add a project, create a durable agent and open its chat. */
async function openChat(p: ProviderCase, fixture: string) {
  fakes = await installFakeClis({ [p.cli]: fixture });
  projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `chat-e2e-${p.cli}-`));
  const app = await launchApp({ experimental: { chat: true }, userDataFiles: USER_DATA_FILES, env: fakes.env });
  const { electronApp, window } = app;

  await addProject(electronApp, window, projectDir);
  const name = `chat-${p.cli}-${Date.now()}`;
  await window.locator('button:has-text("+ Agent")').first().click();
  await expect(window.locator('h2:has-text("New Agent")')).toBeVisible({ timeout: 5_000 });
  await window.locator('input[type="text"]').first().fill(name);
  await window.locator('label:has-text("Runs on") select').selectOption(p.orchestrator);
  // Free Agent Mode stays off: the agent runs at the 'ask' level, so the
  // permission fixtures' approval reaches the dock.
  await window.locator('button:has-text("Create Agent")').click();

  const item = window.locator(`[data-agent-name="${name}"][data-testid^="agent-item-durable_"]`);
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();

  const chat = window.locator('[data-testid="chat-view"]');
  await expect(chat).toBeVisible({ timeout: 20_000 });
  await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await expectFakeInUse(p.cli);
  return { electronApp, window, chat };
}

/**
 * Before any prompt: the app spawned the fake, not a real CLI. The fake writes
 * its report from the moment it starts, and by the time the chat is idle it
 * has replayed the handshake, so a missing or untouched report means some
 * other binary answered.
 */
async function expectFakeInUse(cli: ChatFixtureCli): Promise<void> {
  const report = await fakes!.report(cli).catch((): undefined => undefined);
  expect(report, `the app did not spawn the fake ${cli}`).toBeDefined();
  expect(report!.mismatch).toBeNull();
  expect(report!.consumed).toBeGreaterThan(0);
}

async function send(window: Page, text: string): Promise<void> {
  const box = window.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

/** The fake CLI replayed its whole fixture with no unexpected message. */
async function expectFixtureComplete(cli: ChatFixtureCli): Promise<void> {
  await expect.poll(async (): Promise<{ mismatch: unknown; complete: boolean } | undefined> => {
    const report = await fakes!.report(cli).catch((): undefined => undefined);
    return report && { mismatch: report.mismatch, complete: report.complete };
  }, { timeout: ENDED_TIMEOUT }).toEqual({ mismatch: null, complete: true });
}

for (const p of PROVIDERS) {
  test.describe(`chat over a fake ${p.cli}`, () => {
    test.skip(!p.registered, `no ${p.orchestrator} chat driver is registered on this branch yet`);

    test('send, stream and finish two turns', async () => {
      const { electronApp, window, chat } = await openChat(p, 'multi-turn');
      try {
        await send(window, 'Reply with the word one.');
        const footers = window.locator('[data-testid="chat-turn-footer"]');
        await expect(footers).toHaveCount(1, { timeout: ENDED_TIMEOUT });
        await expect(footers.first()).toHaveAttribute('data-stop-reason', 'end_turn');
        const replies = window.locator('[data-testid="chat-agent-message"]');
        await expect(replies.first()).toHaveText(/\S/);
        await expect(replies.first().getByLabel('Streaming')).toHaveCount(0);
        await expect(chat).toHaveAttribute('data-state', 'idle');

        await send(window, 'Reply with the word two.');
        await expect(footers).toHaveCount(2, { timeout: ENDED_TIMEOUT });
        await expect(footers.nth(1)).toHaveAttribute('data-stop-reason', 'end_turn');
        await expect(window.locator('[data-testid="chat-user-message"]')).toHaveCount(2);
        expect(await replies.count()).toBeGreaterThanOrEqual(2);

        await expectFixtureComplete(p.cli);
      } finally {
        await electronApp.close();
      }
    });

    test('long tokens and wide tables stay inside a narrow pane (#2292)', async () => {
      const { electronApp, window } = await openChat(p, 'multi-turn');
      try {
        await send(window, 'Reply with the word one.');
        await expect(window.locator('[data-testid="chat-turn-footer"]')).toHaveCount(1, { timeout: ENDED_TIMEOUT });
        await electronApp.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.setMinimumSize(320, 320);
          win?.setSize(760, 720);
        });

        // The user's bubble ends at the same right edge as the content column (#2365).
        const bubbleGap = () => window.locator('[data-testid="chat-stream"]').evaluate((stream) => {
          const column = stream.firstElementChild!.getBoundingClientRect();
          const bubble = stream.querySelector('[data-testid="chat-user-message"] > :last-child')!.getBoundingClientRect();
          return Math.round(column.right - bubble.right);
        });
        expect(Math.abs(await bubbleGap())).toBeLessThanOrEqual(1);

        // Synthetic restored history: an unbroken token and a wide table in the
        // reply, and an unbroken token in the user's bubble.
        const token = `sha256-${'a1b2c3d4'.repeat(60)}`;
        await window.evaluate((t) => {
          const cells = (cell: string) => Array.from({ length: 20 }, () => `<td>${cell}</td>`).join('');
          const md = document.querySelector('[data-testid="chat-agent-message"] .chat-markdown');
          md?.insertAdjacentHTML('beforeend', `<p>${t}</p><p><code>${t}</code></p><table><tr>${cells('a fairly long cell value')}</tr></table>`);
          const bubble = document.querySelector('[data-testid="chat-user-message"]')?.lastElementChild;
          bubble?.append(` ${t}`);
        }, token);

        const layout = await window.locator('[data-testid="chat-stream"]').evaluate((stream) => {
          const box = stream.getBoundingClientRect();
          const messages = [...stream.querySelectorAll('[data-testid="chat-agent-message"], [data-testid="chat-user-message"] > :last-child')];
          return {
            overflow: stream.scrollWidth - stream.clientWidth,
            clippedLeft: messages.filter((m) => m.getBoundingClientRect().left < box.left - 1).length,
            clippedRight: messages.filter((m) => m.getBoundingClientRect().right > box.right + 1).length,
          };
        });
        expect(layout).toEqual({ overflow: 0, clippedLeft: 0, clippedRight: 0 });
        expect(Math.abs(await bubbleGap())).toBeLessThanOrEqual(1);
        // The wide table scrolls inside its own box instead.
        const table = await window.locator('[data-testid="chat-agent-message"] table').evaluate((t) => t.scrollWidth > t.clientWidth);
        expect(table).toBe(true);

        // Even with something wide enough to scroll, nothing leaves the stream scrolled sideways.
        const scrollLeft = await window.locator('[data-testid="chat-stream"]').evaluate(async (stream) => {
          stream.firstElementChild?.insertAdjacentHTML('beforeend', '<div style="width:3000px;flex-shrink:0;height:1px"></div>');
          stream.scrollLeft = 200;
          stream.dispatchEvent(new Event('scroll'));
          await new Promise((r) => requestAnimationFrame(r));
          return stream.scrollLeft;
        });
        expect(scrollLeft).toBe(0);
      } finally {
        await electronApp.close();
      }
    });

    test('approve a permission request and the turn finishes', async () => {
      const { electronApp, window, chat } = await openChat(p, 'permission-approve-edit');
      try {
        await send(window, 'Make the edit.');
        const permission = window.locator('[data-testid="chat-permission"]');
        await expect(permission).toBeVisible({ timeout: ENDED_TIMEOUT });
        await expect(chat).toHaveAttribute('data-state', 'waiting_permission');
        await permission.locator('[data-option-kind="allow_once"]').click();

        await expect(permission).toHaveCount(0, { timeout: ENDED_TIMEOUT });
        const footer = window.locator('[data-testid="chat-turn-footer"]');
        await expect(footer).toHaveCount(1, { timeout: ENDED_TIMEOUT });
        await expect(footer).toHaveAttribute('data-stop-reason', 'end_turn');

        // The fixture pins the native allow answer (`match`), so completing
        // it proves the click sent an approval, not a denial.
        await expectFixtureComplete(p.cli);
      } finally {
        await electronApp.close();
      }
    });

    test('Stop interrupts a running turn', async () => {
      const { electronApp, window, chat } = await openChat(p, 'interrupt');
      try {
        await send(window, 'Run the long command.');
        await expect(chat).toHaveAttribute('data-state', 'running', { timeout: ENDED_TIMEOUT });
        await expect(window.locator('[data-testid="chat-tool-row"], [data-testid="chat-command-card"], [data-testid="chat-tool-card"]').first())
          .toBeVisible({ timeout: ENDED_TIMEOUT });
        await window.locator('[data-testid="chat-stop"]').click();

        const footer = window.locator('[data-testid="chat-turn-footer"]');
        await expect(footer).toHaveCount(1, { timeout: ENDED_TIMEOUT });
        await expect(footer).toHaveAttribute('data-stop-reason', 'cancelled');
        await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: ENDED_TIMEOUT });

        await expectFixtureComplete(p.cli);
      } finally {
        await electronApp.close();
      }
    });
  });
}
