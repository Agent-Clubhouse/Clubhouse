import { expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, ORCHESTRATOR_FOR_CLI, type FakeClis } from '../chat-fake-cli';
import { launchApp, type ElectronApp } from '../launch';
import { addProject } from '../smoke-helpers';
import type { ChatFixtureCli } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { buildChatScript, writeChatScript, type ChatScript } from '../../src/main/orchestrators/adapters/testing/chat-script';

/**
 * Harness for the rich content and chat UX specs (#2480, plan in
 * docs/testing/chat-e2e-plan.md). These specs run in their own Validate job
 * on Linux and Windows only (`e2e-chat`); the sharded E2E run and macOS skip
 * this folder.
 *
 * `openRichChat` builds a scripted fixture (chat-script.ts) for one provider,
 * installs it as the fake CLI, launches the app, turns on the experimental
 * flags through the settings IPC, then adds a project and opens a durable
 * agent's chat. Every wait is on the DOM or the fake's report: no sleeps.
 */

export const RICH_FLAGS = { richChatContent: true } as const;

/** Every provider enabled and in chat mode; Claude on stream-json, which the fixtures speak. */
const USER_DATA_FILES = {
  'orchestrator-settings.json': { enabled: Object.values(ORCHESTRATOR_FOR_CLI), autoDetected: true },
  'chat-runtime-settings.json': {
    'claude-code': { mode: 'chat', driver: 'claude_stream_json' },
    'codex-cli': { mode: 'chat' },
    'copilot-cli': { mode: 'chat' },
  },
};

export const TURN_TIMEOUT = 20_000;

/** Where main puts the helper delivery seam (helper-delivery-seam.ts; importing it here would load Electron). */
const HELPER_SEAM_GLOBAL = '__clubhouseTestDeliverHelperUpdate';

// The GitHub lookup seam's variable and files (src/main/services/github-ref-test-seam.ts).
const GITHUB_REFS_ENV = 'CLUBHOUSE_TEST_GITHUB_REFS';
const GITHUB_REFS_STUBS_FILE = 'refs.json';
const GITHUB_REFS_REQUESTS_FILE = 'requests.jsonl';

export interface RichChatOptions {
  cli: ChatFixtureCli;
  /**
   * A script for this test (or a function of the test's folders, for scripts
   * that name files in them), or the name of a committed fixture.
   */
  script: ChatScript | string | ((dirs: { projectDir: string; outsideDir: string }) => ChatScript);
  /** Experimental flags set through the settings IPC before the chat opens. Default: rich content on. */
  flags?: Record<string, boolean>;
  /** Files to create in the project before it is added, keyed by relative path. */
  projectFiles?: Record<string, SeedFile>;
  /** Files to create in a folder outside the project, keyed by relative path. */
  outsideFiles?: Record<string, SeedFile>;
  /**
   * Answers for GitHub reference lookups, keyed `owner/repo#123` or
   * `owner/repo@sha` (lowercase), each what `gh api graphql` would print.
   * Every launch answers from these (none by default), so no spec reaches gh
   * or the network: see github-ref-test-seam.ts.
   */
  githubRefs?: Record<string, unknown>;
  /**
   * Make the project a git repo with this `origin` (say, a github.com URL,
   * which turns on bare `#123`). Nothing is fetched, and the repo is left
   * with no commits, so nothing that needs a branch (the review's pull
   * request lookup) gets as far as gh.
   */
  gitRemote?: string;
}

/** One GitHub reference lookup the app made, as the seam recorded it. */
export interface GithubRefRequest {
  /** The stub key it asked for. */
  ref: string;
  /** What would have gone to gh. */
  args: string[];
}

/** File content, or `{ copy }` to copy a file (say, one from test/chat-media). */
export type SeedFile = string | Buffer | { copy: string };

export interface RichChat {
  electronApp: ElectronApp;
  window: Page;
  chat: Locator;
  /** The durable agent's id, for main-side APIs such as Annex. */
  agentId: string;
  projectDir: string;
  /** A temp folder outside the project, removed with it. */
  outsideDir: string;
  /** Copilot only: the COPILOT_HOME the app was launched with (the script's session journal lives here). */
  copilotHome?: string;
  fakes: FakeClis;
  /** Every GitHub reference lookup so far, in order. */
  githubRefRequests(): Promise<GithubRefRequest[]>;
  send(text: string): Promise<void>;
  /** Send with the composer's secondary action: Queue while a turn runs. */
  queue(text: string): Promise<void>;
  /**
   * Hand `texts` to this agent as helper updates, through the same delivery
   * message_parent uses (batching window, queue merging, the driver's send).
   * Returns once they're handed over, not delivered: a busy parent's batch
   * goes when its window closes.
   */
  sendHelperUpdates(texts: string[]): Promise<void>;
  /** The fake replayed the whole script with no unexpected message. */
  expectScriptComplete(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Set experimental flags the way the Settings toggle does (save through
 * IPC), and read them back. The renderer reads `richChatContent` once, when
 * the first chat pane mounts, so call this before opening a chat; to flip it
 * mid-session, call it and then `window.reload()`.
 */
export async function setExperimentalFlags(window: Page, flags: Record<string, boolean>): Promise<void> {
  const saved = await window.evaluate(async (next) => {
    const app = (window as unknown as { clubhouse: { app: {
      getExperimentalSettings(): Promise<Record<string, boolean>>;
      saveExperimentalSettings(s: Record<string, boolean>): Promise<void>;
    } } }).clubhouse.app;
    await app.saveExperimentalSettings({ ...await app.getExperimentalSettings(), ...next });
    return app.getExperimentalSettings();
  }, flags);
  expect(saved).toMatchObject(flags);
}

/** Make the temp dirs a test owns. `mkdtemp`, then the real path, so Windows short names and macOS /private don't differ from what main reports. */
async function tempDir(prefix: string): Promise<string> {
  return fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function openRichChat(opts: RichChatOptions): Promise<RichChat> {
  const root = await tempDir(`chat-rich-${opts.cli}-`);
  const projectDir = path.join(root, 'project');
  const outsideDir = path.join(root, 'outside');
  const scriptDir = path.join(root, 'script');
  const githubRefsDir = path.join(root, 'github-refs');
  await Promise.all([projectDir, outsideDir, scriptDir, githubRefsDir].map((d) => fs.promises.mkdir(d, { recursive: true })));
  const seed = async (dir: string, files: Record<string, SeedFile> = {}) => {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, rel);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      if (typeof content === 'object' && !Buffer.isBuffer(content)) await fs.promises.copyFile(content.copy, file);
      else await fs.promises.writeFile(file, content);
    }
  };
  await seed(projectDir, opts.projectFiles);
  await seed(outsideDir, opts.outsideFiles);
  await fs.promises.writeFile(path.join(githubRefsDir, GITHUB_REFS_STUBS_FILE), JSON.stringify(opts.githubRefs ?? {}));
  if (opts.gitRemote) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      execFileSync('git', ['remote', 'add', 'origin', opts.gitRemote], { cwd: projectDir });
    } catch (err) {
      await fs.promises.rm(root, { recursive: true, force: true });
      throw err;
    }
  }

  let fixture: string;
  let copilotHome: string | undefined;
  if (typeof opts.script === 'string') {
    fixture = opts.script;
  } else {
    const script = typeof opts.script === 'function' ? opts.script({ projectDir, outsideDir }) : opts.script;
    ({ fixture, copilotHome } = await writeChatScript(scriptDir, 'script', buildChatScript(opts.cli, script)));
  }
  // Copilot always gets a home of its own, so the app never reads the
  // runner's real ~/.copilot (session journals, resume checks).
  if (opts.cli === 'copilot' && !copilotHome) {
    copilotHome = path.join(root, 'copilot-home');
    await fs.promises.mkdir(path.join(copilotHome, 'session-state'), { recursive: true });
  }
  const fakes = await installFakeClis({ [opts.cli]: fixture });
  const removeAll = async () => {
    await fakes.cleanup();
    // Windows: a fake that was just killed can hold its files for a moment.
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };

  let electronApp: ElectronApp | undefined;
  try {
    const app = await launchApp({
      experimental: { chat: true },
      userDataFiles: USER_DATA_FILES,
      env: { ...fakes.env, CLUBHOUSE_TEST_HELPER_SEAM: '1', [GITHUB_REFS_ENV]: githubRefsDir, ...(copilotHome && { COPILOT_HOME: copilotHome }) },
    });
    electronApp = app.electronApp;
    const { window } = app;
    await setExperimentalFlags(window, opts.flags ?? RICH_FLAGS);

    await addProject(electronApp, window, projectDir);
    const name = `rich-${opts.cli}-${Date.now()}`;
    await window.locator('button:has-text("+ Agent")').first().click();
    await expect(window.locator('h2:has-text("New Agent")')).toBeVisible({ timeout: 5_000 });
    await window.locator('input[type="text"]').first().fill(name);
    await window.locator('label:has-text("Runs on") select').selectOption(ORCHESTRATOR_FOR_CLI[opts.cli]);
    await window.locator('button:has-text("Create Agent")').click();
    const item = window.locator(`[data-agent-name="${name}"][data-testid^="agent-item-durable_"]`);
    await expect(item).toBeVisible({ timeout: 20_000 });
    const agentId = (await item.getAttribute('data-testid'))!.slice('agent-item-'.length);
    await item.click();

    const chat = window.locator('[data-testid="chat-view"]');
    await expect(chat).toBeVisible({ timeout: 20_000 });
    await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
    // The app spawned the fake, not a real CLI: its report exists and the handshake replayed.
    const report = await fakes.report(opts.cli).catch((): undefined => undefined);
    expect(report, `the app did not spawn the fake ${opts.cli}`).toBeDefined();
    expect(report!.mismatch).toBeNull();
    expect(report!.consumed).toBeGreaterThan(0);

    const launched = electronApp;
    return {
      electronApp, window, chat, agentId, projectDir, outsideDir, copilotHome, fakes,
      async githubRefRequests() {
        const raw = await fs.promises.readFile(path.join(githubRefsDir, GITHUB_REFS_REQUESTS_FILE), 'utf8').catch(() => '');
        // A line still being written has no newline yet: leave it for the next read.
        return raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => JSON.parse(l) as GithubRefRequest);
      },
      async send(text) {
        const box = window.getByRole('textbox', { name: 'Message' });
        await box.fill(text);
        await box.press('Enter');
      },
      async queue(text) {
        await window.getByRole('textbox', { name: 'Message' }).fill(text);
        await window.locator('[data-testid="chat-send-secondary"]').click();
      },
      async sendHelperUpdates(texts) {
        await launched.evaluate((_electron, { name, agentId, texts }) => {
          const deliver = (globalThis as Record<string, unknown>)[name] as ((id: string, text: string) => Promise<unknown>) | undefined;
          if (!deliver) throw new Error('the helper delivery seam is not installed');
          // Not awaited: a busy parent's batch resolves when its window closes.
          for (const text of texts) void deliver(agentId, text).catch((err: unknown) => console.error('helper update failed', err));
        }, { name: HELPER_SEAM_GLOBAL, agentId, texts });
      },
      async expectScriptComplete() {
        await expect.poll(async () => {
          const r = await fakes.report(opts.cli).catch((): undefined => undefined);
          return r && { mismatch: r.mismatch, complete: r.complete, unexpected: r.unexpected };
        }, { timeout: TURN_TIMEOUT }).toEqual({ mismatch: null, complete: true, unexpected: [] });
      },
      async close() {
        await launched.close();
        await removeAll();
      },
    };
  } catch (err) {
    await electronApp?.close().catch(() => {});
    await removeAll();
    throw err;
  }
}

/** A CSS attribute value, quoted: Windows paths carry backslashes. */
function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Locators for the rich content and chat UX surfaces, by their test ids and data attributes. */
export function chatDom(window: Page) {
  const byId = (id: string) => window.locator(`[data-testid="${id}"]`);
  return {
    turnFooters: byId('chat-turn-footer'),
    agentMessages: byId('chat-agent-message'),
    /** User bubbles; `data-source` (`user`, `mcp`, …) and `data-delivery` (`prompt`, `steer`, `queued`) say how each came. */
    userMessages: byId('chat-user-message'),
    toolRows: byId('chat-tool-row'),

    /** A confirmed file chip for `writtenPath` (as the message wrote it, without `:line`). */
    fileChip: (writtenPath: string) => window.locator(`[data-chat-file][data-chat-path=${cssString(writtenPath)}]`),
    /** A path main couldn't show, muted with its reason in `data-chat-file-unavailable`. */
    mutedChip: (writtenPath: string) => window.locator(`[data-chat-file-unavailable][data-chat-path=${cssString(writtenPath)}]`),
    filePreview: byId('chat-file-preview'),
    pdfPreview: byId('chat-file-preview-pdf'),
    pdfPageLabel: byId('chat-file-preview-pdf-page'),
    pdfCanvas: (page: number, of: number) => byId('chat-file-preview-pdf').getByLabel(`Page ${page} of ${of}`),

    toolImages: byId('chat-tool-images'),
    imageThumbs: byId('chat-image-thumb'),
    imageUnavailable: byId('chat-image-unavailable'),
    lightbox: byId('chat-image-viewer'),
    lightboxImage: byId('chat-image-full'),
    /** A Markdown image main stored, as its thumbnail button (named by its alt text). */
    markdownImage: (alt: string) => window.getByRole('button', { name: `Open image: ${alt}`, exact: true }),
    /** A Markdown image that isn't shown: its caption and the reason. */
    markdownImageNotShown: window.locator('.chat-image-not-shown'),

    /** A GitHub token (pull request, issue or commit) by the page it links to. */
    githubToken: (href: string) => window.locator(`a[data-gh-token][href=${cssString(href)}]`),
    /** A link that isn't a GitHub token, by its href. */
    plainLink: (href: string) => window.locator(`a[href=${cssString(href)}]:not([data-gh-token])`),
    githubCard: byId('gh-ref-card'),
    githubCardTitle: byId('gh-card-title'),
    githubCardState: byId('gh-card-state'),

    /** Inline audio and video cards; `data-state` says whether one is playing. */
    mediaCards: window.locator('[data-chat-media]'),

    permission: byId('chat-permission'),
    question: byId('chat-question'),
    questionStep: byId('chat-question-step'),
    questionCurrent: byId('chat-question-current'),

    queue: byId('chat-queue'),
    queueToggle: byId('chat-queue-toggle'),
    queueItems: byId('chat-queue-item'),
    queueClear: byId('chat-queue-clear'),
    queueList: byId('chat-queue-list'),
    /** Per-row remove buttons (client-side queues only). */
    queueRemove: window.getByRole('button', { name: /^Remove from queue: / }),
    stop: byId('chat-stop'),
    composer: byId('chat-composer'),
  };
}

/** An `<img>` (or the first one inside `locator`) has decoded real pixels. */
export async function expectImageLoaded(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((el) => {
    const img = el instanceof HTMLImageElement ? el : el.querySelector('img');
    return !!img && img.complete && img.naturalWidth > 0;
  }), { timeout: TURN_TIMEOUT }).toBe(true);
}

/** A canvas has something drawn on it: not every pixel the same. */
export async function expectCanvasPainted(canvas: Locator): Promise<void> {
  await expect.poll(() => canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    if (!c.width || !c.height) return false;
    const data = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
    if (!data) return false;
    for (let i = 4; i < data.length; i += 4) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return true;
    }
    return false;
  }), { timeout: TURN_TIMEOUT }).toBe(true);
}

/** Neither the page nor the app shell scrolled: focus moves must not shift the window (#2412). */
export async function expectNoPageScroll(window: Page): Promise<void> {
  expect(await window.evaluate(() => [document.scrollingElement?.scrollTop ?? 0, document.body.scrollTop])).toEqual([0, 0]);
}

/**
 * Calls main's rich `chat:*` handlers have received, by channel, from the
 * unpackaged-only seam in chat-handlers.ts. Throws if the seam isn't there,
 * so a zero count can't come from a missing counter.
 */
export async function richChatCalls(electronApp: ElectronApp): Promise<Record<string, number>> {
  const calls = await electronApp.evaluate(() => {
    const counts = (globalThis as Record<string, unknown>).__clubhouseRichChatCalls as Record<string, number> | undefined;
    return counts && { ...counts };
  });
  if (!calls) throw new Error('No rich chat call counts in main: is this an unpackaged build?');
  return calls;
}
