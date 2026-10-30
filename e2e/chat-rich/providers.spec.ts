import { test, expect } from '@playwright/test';
import { chatDom, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Provider bring-up (#2480 area 0, #2484): Codex and Copilot chat over their
 * fake CLIs, through the real app. e2e/chat-fake-cli.spec.ts runs these four
 * scenarios for Claude only (it marks the other two unregistered), so until
 * this spec their chat UI never ran end to end. Each test replays a committed
 * fixture (test/chat-fixtures/<cli>/), so a driver whose traffic drifts from
 * the fixture fails on the fake's mismatch.
 *
 * Two turns and the narrow-pane layout share one launch: the layout check
 * only needs finished turns on screen.
 */

const PROVIDERS = ['codex', 'copilot'] as const;

for (const cli of PROVIDERS) {
  test.describe(`${cli} chat over the fake CLI`, () => {
    test.describe('multi-turn', () => {
      test.describe.configure({ mode: 'serial' });
      let session: RichChat;
      test.beforeAll(async () => {
        session = await openRichChat({ cli, script: 'multi-turn' });
      });
      test.afterAll(async () => {
        await session?.close();
      });

      test('send, stream and finish two turns', async () => {
        const { window, chat } = session;
        const dom = chatDom(window);
        if (cli === 'copilot') {
          // The app passed COPILOT_HOME through to the CLI's environment, so
          // the driver reads session journals from the same place.
          const report = await session.fakes.report(cli);
          expect(report.env.COPILOT_HOME).toBe(session.copilotHome);
        }

        await session.send('Reply with the word one.');
        await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
        await expect(dom.turnFooters.first()).toHaveAttribute('data-stop-reason', 'end_turn');
        await expect(dom.agentMessages.first()).toHaveText(/\S/);
        await expect(dom.agentMessages.first().getByLabel('Streaming')).toHaveCount(0);
        await expect(chat).toHaveAttribute('data-state', 'idle');

        await session.send('Reply with the word two.');
        await expect(dom.turnFooters).toHaveCount(2, { timeout: TURN_TIMEOUT });
        await expect(dom.turnFooters.nth(1)).toHaveAttribute('data-stop-reason', 'end_turn');
        await expect(window.locator('[data-testid="chat-user-message"]')).toHaveCount(2);
        expect(await dom.agentMessages.count()).toBeGreaterThanOrEqual(2);

        await session.expectScriptComplete();
      });

      test('long tokens and wide tables stay inside a narrow pane (#2292)', async () => {
        const { electronApp, window } = session;
        await expect(chatDom(window).turnFooters).toHaveCount(2);
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
      });
    });

    test.describe('one launch per test', () => {
      let session: RichChat | undefined;
      test.afterEach(async () => {
        await session?.close();
        session = undefined;
      });

      test('approve a permission request and the turn finishes', async () => {
        session = await openRichChat({ cli, script: 'permission-approve-edit' });
        const { window, chat } = session;
        const dom = chatDom(window);
        await session.send('Make the edit.');
        await expect(dom.permission).toBeVisible({ timeout: TURN_TIMEOUT });
        await expect(chat).toHaveAttribute('data-state', 'waiting_permission');
        await dom.permission.locator('[data-option-kind="allow_once"]').click();

        await expect(dom.permission).toHaveCount(0, { timeout: TURN_TIMEOUT });
        await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
        await expect(dom.turnFooters).toHaveAttribute('data-stop-reason', 'end_turn');

        // The fixture pins the native allow answer (`match`), so completing
        // it proves the click sent an approval, not a denial.
        await session.expectScriptComplete();
      });

      test('Stop interrupts a running turn', async () => {
        session = await openRichChat({ cli, script: 'interrupt' });
        const { window, chat } = session;
        const dom = chatDom(window);
        await session.send('Run the long command.');
        await expect(chat).toHaveAttribute('data-state', 'running', { timeout: TURN_TIMEOUT });
        await expect(window.locator('[data-testid="chat-tool-row"], [data-testid="chat-command-card"], [data-testid="chat-tool-card"]').first())
          .toBeVisible({ timeout: TURN_TIMEOUT });
        await window.locator('[data-testid="chat-stop"]').click();

        await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
        await expect(dom.turnFooters).toHaveAttribute('data-stop-reason', 'cancelled');
        await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: TURN_TIMEOUT });

        await session.expectScriptComplete();
      });
    });
  });
}
