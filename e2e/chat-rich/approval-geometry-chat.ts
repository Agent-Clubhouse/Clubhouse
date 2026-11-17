import { expect, type Locator } from '@playwright/test';
import type { ChatFixtureCli } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import type { ScriptApproval, ScriptTurn } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { GeometryLog, originalSize, setWindowSize, WINDOW_SIZES } from '../approval-geometry';
import { chatDom, openRichChat, TURN_TIMEOUT } from './harness';

/**
 * The pinned native permission card (#3606, S1): three consecutive approvals
 * of different lengths, answered one after another, at each window size. The
 * request scrolls inside the card, and Allow and Decline stay in one place,
 * inside the window. Claude's cards offer fewer options than Codex's, so the
 * two specs between them cover two option counts. See e2e/approval-geometry.ts.
 */

const SENTENCE = 'which touches the build, the release notes and the migration guide, so it needs a decision before the helpers carry on';

/** Short, medium and long: the marker names the request in the card (its title, or for Codex its command). */
const REQUESTS: ScriptApproval[] = [
  { tool: 'Bash', input: { command: 'echo probe-r1' }, title: 'Run probe-r1' },
  {
    tool: 'Bash',
    input: { command: ['echo probe-r2', 'npm run build -- --workspace packages/web', 'npm run build -- --workspace packages/desktop'].join(' && \\\n  ') },
    title: 'Run probe-r2: build the release bundle for the web client and the desktop shell',
    description: `This builds both bundles, ${SENTENCE}.`,
  },
  {
    tool: 'Bash',
    input: { command: ['echo probe-r3', ...Array.from({ length: 11 }, (_, i) => `npm run step-${i + 1} -- --workspace packages/helper-${i + 1} --verbose`)].join(' && \\\n  ') },
    title: `Run probe-r3: every step of the release build in each helper workspace, one after another, ${SENTENCE}`,
    description: Array.from({ length: 6 }, (_, i) => `Part ${i + 1}: this command ${SENTENCE}.`).join(' '),
  },
];

const turns = (): ScriptTurn[] => WINDOW_SIZES.map((size) => ({
  prompt: `Run the checks at ${size.label}.`,
  steps: [{ type: 'text', text: `Starting the checks (${size.label}).` }, ...REQUESTS.map((approval) => ({ type: 'approval' as const, approval })), { type: 'text', text: 'All checks ran.' }],
}));

export async function expectPinnedApprovalsAnchored(cli: ChatFixtureCli): Promise<void> {
  const s = await openRichChat({ cli, script: { description: 'three approvals of different lengths, once per window size', turns: turns() } });
  const log = new GeometryLog(`pinned-card-${cli}`);
  try {
    const { window } = s;
    const dom = chatDom(window);
    const original = await originalSize(window);
    for (const [turn, size] of WINDOW_SIZES.entries()) {
      await setWindowSize(s.electronApp, window, size, original);
      await s.send(`Run the checks at ${size.label}.`);
      const pinned = window.locator('[data-testid="chat-pinned-approval"]');
      for (const [i] of REQUESTS.entries()) {
        await expect(pinned).toContainText(`probe-r${i + 1}`, { timeout: TURN_TIMEOUT });
        const allow = pinned.locator('[data-option-kind="allow_once"]');
        const decline = pinned.locator('[data-option-kind="reject_once"]');
        const notes = await pinned.evaluate((region) => {
          const card = region.querySelector('[data-testid="chat-permission"]')!.getBoundingClientRect();
          const r = region.getBoundingClientRect();
          return {
            options: region.querySelectorAll('[data-option-kind]').length,
            regionTop: Math.round(r.top), regionHeight: Math.round(r.height), cardTop: Math.round(card.top), cardHeight: Math.round(card.height),
            bodyScrolls: (() => { const body = region.querySelector('[data-testid="chat-permission-body"]'); return !!body && body.scrollHeight > body.clientHeight; })(),
          };
        });
        await log.record(window, size, i + 1, { allow, decline }, notes);
        await clickAllow(allow);
      }
      await expect(dom.turnFooters).toHaveCount(turn + 1, { timeout: TURN_TIMEOUT });
    }
    await s.expectScriptComplete();
  } catch (err) {
    // A measurement that failed part-way still says what it saw.
    console.log(`\n[approval-geometry] ${log.table()}\n`);
    throw err;
  } finally {
    await s.close();
  }
  await log.assertAnchored();
}

/** Allow is always on screen, so this never scrolls to reach it. */
async function clickAllow(allow: Locator): Promise<void> {
  await expect(allow).toBeEnabled();
  await allow.click();
}
