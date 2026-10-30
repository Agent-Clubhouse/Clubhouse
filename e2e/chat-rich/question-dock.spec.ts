import { test, expect, type Locator, type Page } from '@playwright/test';
import type { ChatFixtureCli } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import type { ScriptApproval, ScriptQuestion } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, expectNoPageScroll, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Question and approval dock (#2480 area 5, #2412). A request with many long
 * questions, or an approval with a long description and command, must not
 * outgrow the chat pane in a short window: the pane's header and the dock
 * stay on screen, the transcript keeps room and still scrolls, the stepper
 * walks the questions, the send button and the approval's options stay
 * reachable, and moving focus never scrolls the app around the pane.
 *
 * Claude asks the questions (AskUserQuestion); Codex and Copilot have no
 * question shape. The long approval runs on all three: a Bash call for
 * Claude, a command approval for Codex, an execute permission for Copilot.
 */

const LONG = 'which touches the build, the release notes and the migration guide, so it needs a decision before the helpers carry on with the rest of the plan';

/** 8 questions with long text, three options each with descriptions long enough to clamp; every third is multi-select. */
const QUESTIONS: ScriptQuestion[] = Array.from({ length: 8 }, (_, i) => ({
  question: `Question ${i + 1}: how should helper ${i + 1} handle its part of the change, ${LONG}?`,
  header: `Step ${i + 1}`,
  multiSelect: i % 3 === 2,
  options: ['Keep it', 'Rewrite it', 'Skip it'].map((label) => ({
    label: `${label} (${i + 1})`,
    description: `${label} for helper ${i + 1}: ${LONG}, and the helper reports back when it is done.`,
  })),
}));

/** What each question is answered with: a different option per question, two for multi-select. */
const PICKS: number[][] = QUESTIONS.map((q, i) => (q.multiSelect ? [0, 2] : [i % 3]));
const ANSWERS = Object.fromEntries(QUESTIONS.map((q, i) => [q.question, PICKS[i].map((k) => q.options[k].label).join(', ')]));

const COMMAND = Array.from({ length: 40 }, (_, i) => `npm run step-${i + 1} -- --workspace packages/helper-${i + 1} --verbose`).join(' && \\\n  ');
const DESCRIPTION = Array.from({ length: 12 }, (_, i) => `Part ${i + 1}: this command ${LONG}.`).join(' ');

/** Enough earlier text that the transcript overflows its share of a short window. */
const FILLER = Array.from({ length: 10 }, (_, i) => ({ type: 'text' as const, text: `Note ${i + 1}. ${LONG}. ${LONG}.` }));

/** A long shell command that asks first: Copilot shows no description, so its title is long too. */
const APPROVAL: ScriptApproval = {
  tool: 'Bash',
  input: { command: COMMAND },
  title: `Run every step of the release build in each helper workspace, one after another, ${LONG}`,
  description: DESCRIPTION,
};

/** The question card and the parts of it that must stay inside the dock. */
const QUESTION_PARTS = ['[data-testid="chat-question"]', '[data-testid="chat-question-body"]'];
const PERMISSION_PARTS = ['[data-testid="chat-permission-scroll"]', '[data-testid="chat-permission-level"]'];

/** A short window: the default minimum is 900x600, which is roomier than a laptop split. */
async function shrinkWindow(s: RichChat): Promise<void> {
  await s.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setMinimumSize(320, 320);
    win?.setSize(820, 520);
  });
  await expect.poll(() => s.window.evaluate(() => window.innerHeight)).toBeLessThan(560);
}

/** Nothing between the dock and the document scrolled: not the pane's column, the pane, the app shell or the page. */
async function expectNothingAroundScrolled(page: Page): Promise<void> {
  await expectNoPageScroll(page);
  const scrolled = await page.locator('[data-testid="chat-dock"]').evaluate((dock) => {
    const out: string[] = [];
    for (let el: Element | null = dock; el; el = el.parentElement) {
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) out.push(`${el.tagName}#${el.id}[${el.getAttribute('data-testid') ?? ''}] ${el.scrollTop},${el.scrollLeft}`);
    }
    return out;
  });
  expect(scrolled).toEqual([]);
}

/** `locator` lies inside the window and is what a click at its center hits (nothing covers it). */
async function expectReachable(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inside: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1, hit: !!top && el.contains(top) };
  })).toEqual({ inside: true, hit: true });
}

/**
 * With a request in the dock (#2412): the pane header and the dock are on
 * screen; the request is tall enough to reach the dock's cap and stays
 * inside it (every one of `contents` lies within the dock's box, so nothing
 * spills past a capped dock); the transcript keeps the rest of the column
 * and still scrolls under the wheel; nothing around the pane scrolled.
 */
async function expectDockBounded(page: Page, contents: string[]): Promise<void> {
  await expectReachable(page.locator('[data-testid="chat-view"] [data-testid="agent-pane-toolbar"]'));
  await expect.poll(() => page.locator('[data-testid="chat-dock"]').evaluate((dock, selectors) => {
    const column = dock.parentElement!.getBoundingClientRect();
    const box = dock.getBoundingClientRect();
    const stream = document.querySelector<HTMLElement>('[data-testid="chat-stream"]')!;
    const inside = (r: DOMRect) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    return {
      dockOnScreen: box.top >= 0 && box.bottom <= window.innerHeight + 1,
      columnOnScreen: column.top >= 0 && column.bottom <= window.innerHeight + 1,
      // At the cap: the request is long enough to test it, and the cap holds.
      dockAtCap: Math.abs(box.height - column.height * 0.6) <= 2,
      contentsInDock: selectors.map((sel) => [...document.querySelectorAll(sel)].every((el) => inside(el.getBoundingClientRect()))),
      // The transcript has the rest of the column, and more to scroll than it shows.
      streamFillsRest: Math.abs(stream.getBoundingClientRect().height + box.height - column.height) <= 2,
      streamOverflows: stream.scrollHeight > stream.clientHeight,
    };
  }, contents), { timeout: TURN_TIMEOUT }).toEqual({
    dockOnScreen: true, columnOnScreen: true, dockAtCap: true, contentsInDock: contents.map(() => true), streamFillsRest: true, streamOverflows: true,
  });

  // The transcript scrolls under the wheel, and only the transcript.
  const stream = page.locator('[data-testid="chat-stream"]');
  const bottom = await stream.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(bottom).toBeGreaterThan(0);
  await stream.hover({ position: { x: 24, y: 8 } });
  await page.mouse.wheel(0, -400);
  await expect.poll(() => stream.evaluate((el) => el.scrollTop)).toBeLessThan(bottom);
  await expectNothingAroundScrolled(page);
}

/** The scrolling part of a request card has more than it shows: the card scrolls inside the dock instead of growing. */
async function expectScrollsInside(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
}

/** The fake has had no unexpected message (a wrong answer or a denial fails here, not on a timeout later). */
async function expectNoMismatch(s: RichChat, cli: ChatFixtureCli): Promise<void> {
  await expect.poll(async () => (await s.fakes.report(cli)).mismatch, { timeout: TURN_TIMEOUT }).toBeNull();
}

/**
 * Send `prompt`, whose turn asks for APPROVAL: the long card scrolls inside
 * a bounded dock, Allow is reachable without scrolling the app, and the turn
 * (the `turn`th) finishes once it is allowed.
 */
async function approveLongRequest(s: RichChat, cli: ChatFixtureCli, prompt: string, turn: number): Promise<void> {
  const { window, chat } = s;
  const dom = chatDom(window);
  await s.send(prompt);
  await expect(dom.permission).toBeVisible({ timeout: TURN_TIMEOUT });
  await expect(chat).toHaveAttribute('data-state', 'waiting_permission');
  await expect(dom.permission).toContainText(cli === 'codex' ? 'Run npm run step-1 ' : 'Run every step of the release build');
  // Copilot's request has no description; the others carry theirs (Claude's description, Codex's reason).
  if (cli !== 'copilot') await expect(window.locator('[data-testid="chat-permission-description"]')).toContainText('Part 12');
  await expect(window.locator('[data-testid="chat-permission-text"]').first()).toContainText('npm run step-1 -- --workspace packages/helper-1 ');
  await expectDockBounded(window, PERMISSION_PARTS);
  // The card is taller than its share of the pane, so it scrolls inside the dock.
  await expectScrollsInside(window.locator('[data-testid="chat-permission-scroll"]'));
  // The level pill sits outside the scrolling card, always on screen.
  await expectReachable(window.locator('[data-testid="chat-permission-level"] button').first());

  // Allow is reachable by scrolling the card itself, never the app.
  const allow = dom.permission.locator('[data-option-kind="allow_once"]');
  await allow.scrollIntoViewIfNeeded();
  await expectReachable(allow);
  await expectNothingAroundScrolled(window);
  await allow.click();
  await expectNoMismatch(s, cli);

  await expect(dom.permission).toHaveCount(0, { timeout: TURN_TIMEOUT });
  await expect(dom.turnFooters).toHaveCount(turn, { timeout: TURN_TIMEOUT });
  await expect(dom.turnFooters.nth(turn - 1)).toHaveAttribute('data-stop-reason', 'end_turn');
  await expectReachable(dom.composer);
  await expectNothingAroundScrolled(window);
  // The fixture pins every answer and the allow: complete means the app sent exactly those.
  await s.expectScriptComplete();
}

test.describe('claude: questions, then an approval, in one session', () => {
  test.describe.configure({ mode: 'serial' });
  let session: RichChat;
  test.beforeAll(async () => {
    session = await openRichChat({
      cli: 'claude',
      script: {
        description: 'eight long questions, then a long Bash approval',
        turns: [
          { prompt: 'Plan the helpers.', steps: [...FILLER, { type: 'questions', questions: QUESTIONS, answers: ANSWERS }, { type: 'text', text: 'Thanks, the helpers have their answers.' }] },
          { prompt: 'Run the steps.', steps: [{ type: 'text', text: 'Running every step.' }, { type: 'approval', approval: APPROVAL }, { type: 'text', text: 'All steps ran.' }] },
        ],
      },
    });
    await shrinkWindow(session);
  });
  test.afterAll(async () => {
    await session?.close();
  });

  test('many long questions step one at a time in a short window, and submit stays reachable', async () => {
    const { window, chat } = session;
    const dom = chatDom(window);
    await session.send('Plan the helpers.');
    await expect(dom.question).toBeVisible({ timeout: TURN_TIMEOUT });
    // The card took focus as it opened, without moving anything around the pane.
    await expect(dom.question).toBeFocused();
    await expect(chat).toHaveAttribute('data-state', 'waiting_input');
    await expectDockBounded(window, QUESTION_PARTS);
    await expectScrollsInside(window.locator('[data-testid="chat-question-body"]'));

    // One question open, the rest collapsed to a line each.
    await expect(dom.questionStep).toHaveText('1 of 8');
    await expect(dom.questionCurrent).toHaveCount(1);
    await expect(dom.questionCurrent).toContainText(QUESTIONS[0].question);
    await expect(dom.question.locator('[data-testid="chat-question-collapsed"]')).toHaveCount(7);
    const send = dom.question.getByRole('button', { name: 'Send answer', exact: true });
    await expect(send).toBeDisabled();

    // Long descriptions start clamped, and open on request.
    const more = dom.questionCurrent.getByRole('button', { name: 'Show more' }).first();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(dom.questionCurrent.getByRole('button', { name: 'Show less' }).first()).toHaveAttribute('aria-expanded', 'true');
    await expectNothingAroundScrolled(window);

    for (let i = 0; i < QUESTIONS.length; i++) {
      await expect(dom.questionStep).toHaveText(`${i + 1} of 8`);
      await expect(dom.questionCurrent).toContainText(QUESTIONS[i].question);
      const options = dom.questionCurrent.locator('button[aria-pressed]');
      if (QUESTIONS[i].multiSelect) {
        for (const k of PICKS[i]) {
          await options.nth(k).click();
          await expect(options.nth(k)).toHaveAttribute('aria-pressed', 'true');
        }
        if (i < QUESTIONS.length - 1) await dom.question.getByRole('button', { name: 'Next', exact: true }).click();
      } else if (i % 2 === 1) {
        // Number keys pick an option of the open question. After a click the picked option unmounted and the
        // card took focus back; after Next, focus is on Next, inside the card. Either way the key reaches it.
        if (!QUESTIONS[i - 1].multiSelect) await expect(dom.question).toBeFocused();
        await window.keyboard.press(String(PICKS[i][0] + 1));
      } else {
        await options.nth(PICKS[i][0]).click();
      }
      // Picking moved on to the next question; the last one stays open.
      if (i < QUESTIONS.length - 1) await expect(dom.questionStep).toHaveText(`${i + 2} of 8`);
      else await expect(options.nth(PICKS[i][0])).toHaveAttribute('aria-pressed', 'true');
      await expectNothingAroundScrolled(window);
    }

    // Back to the first question from its collapsed row: its answer is kept.
    await dom.question.locator('[data-testid="chat-question-collapsed"]').first().click();
    await expect(dom.questionStep).toHaveText('1 of 8');
    await expect(dom.questionCurrent.locator('button[aria-pressed]').nth(PICKS[0][0])).toHaveAttribute('aria-pressed', 'true');
    await expectNothingAroundScrolled(window);
    await expectDockBounded(window, QUESTION_PARTS);

    // Every question answered: send is enabled and on screen without scrolling anything.
    await expect(send).toBeEnabled();
    await expectReachable(send);
    await send.click();
    await expectNoMismatch(session, 'claude');

    await expect(dom.question).toHaveCount(0, { timeout: TURN_TIMEOUT });
    await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: TURN_TIMEOUT });
    await expectReachable(dom.composer);
    await expectNothingAroundScrolled(window);
  });

  test('a long approval keeps the dock bounded and its options reachable', async () => {
    await approveLongRequest(session, 'claude', 'Run the steps.', 2);
  });
});

for (const cli of ['codex', 'copilot'] as const) {
  test(`${cli}: a long approval keeps the dock bounded and its options reachable`, async () => {
    const s = await openRichChat({
      cli,
      script: {
        description: 'a long command approval after a long reply',
        turns: [{ prompt: 'Run the steps.', steps: [...FILLER, { type: 'approval', approval: APPROVAL }, { type: 'text', text: 'All steps ran.' }] }],
      },
    });
    try {
      await shrinkWindow(s);
      await approveLongRequest(s, cli, 'Run the steps.', 1);
    } finally {
      await s.close();
    }
  });
}
