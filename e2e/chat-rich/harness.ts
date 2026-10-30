import { expect, type Locator, type Page } from '@playwright/test';
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
}

/** File content, or `{ copy }` to copy a file (say, one from test/chat-media). */
export type SeedFile = string | Buffer | { copy: string };

export interface RichChat {
  electronApp: ElectronApp;
  window: Page;
  chat: Locator;
  projectDir: string;
  /** A temp folder outside the project, removed with it. */
  outsideDir: string;
  fakes: FakeClis;
  send(text: string): Promise<void>;
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
  await Promise.all([projectDir, outsideDir, scriptDir].map((d) => fs.promises.mkdir(d, { recursive: true })));
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

  let fixture: string;
  let copilotHome: string | undefined;
  if (typeof opts.script === 'string') {
    fixture = opts.script;
  } else {
    const script = typeof opts.script === 'function' ? opts.script({ projectDir, outsideDir }) : opts.script;
    ({ fixture, copilotHome } = await writeChatScript(scriptDir, 'script', buildChatScript(opts.cli, script)));
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
      env: { ...fakes.env, ...(copilotHome && { COPILOT_HOME: copilotHome }) },
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
      electronApp, window, chat, projectDir, outsideDir, fakes,
      async send(text) {
        const box = window.getByRole('textbox', { name: 'Message' });
        await box.fill(text);
        await box.press('Enter');
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
