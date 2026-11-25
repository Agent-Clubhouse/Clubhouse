/**
 * Chat across desktops (#2390): a controller reads and drives a chat agent that
 * runs on another desktop, through that desktop's pinned phone routes.
 *
 * The satellite runs a durable agent in chat over the fake Claude CLI (a
 * recorded fixture: no model is called). A second desktop pairs with it, reads
 * the agent's chat page, and sends both of the fixture's turns; the satellite
 * shows them finish, and the fake replays its whole fixture.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { buildChatScript, writeChatScript, CHAT_MEDIA } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { untrackOpenApp } from '../e2e-cleanup';
import { addProject, assertRunLayout, createDurableAgent } from '../smoke-helpers';
import { isNewLayout } from '../layout';
import { enableAnnexViaPreload } from './helpers';

let fakes: FakeClis | undefined;
let projectDir: string | undefined;
let satellite: LaunchedApp | undefined;
let controller: LaunchedApp | undefined;

test.setTimeout(300_000);

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  try { await app.electronApp.close(); } catch { /* already gone */ }
  untrackOpenApp(app.electronApp);
}

test.afterAll(async () => {
  await close(controller);
  await close(satellite);
  await fakes?.cleanup();
  if (projectDir) await fs.promises.rm(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a controller reads and drives a chat agent on another desktop', async () => {
  projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-across-'));
  const note = path.join(projectDir, 'satellite-note.md');
  await fs.promises.writeFile(note, 'This is a fixture file, never a controller-local preview.');
  const fixture = await writeChatScript(projectDir, 'remote-images', buildChatScript('claude', {
    description: 'two chat turns followed by a remote image upload and stored tool image',
    turns: [
      { prompt: 'Reply with the word one.', steps: [{ type: 'text', text: 'one' }] },
      { prompt: 'Reply with the word two.', steps: [{ type: 'text', text: 'two' }] },
      { prompt: 'Inspect this image.', steps: [
        { type: 'image-tool', image: { path: CHAT_MEDIA.png, mimeType: 'image/png' } },
        { type: 'text', text: `[remote fixture file](${pathToFileURL(note).href})` },
      ] },
    ],
  }));
  fakes = await installFakeClis({ claude: fixture.fixture });
  satellite = await launchApp({
    label: 'satellite',
    args: ['--disable-gpu'],
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
    },
    env: fakes.env,
  });
  controller = await launchApp({ label: 'controller', args: ['--disable-gpu'] });
  const sat = satellite.window;
  await assertRunLayout(sat);

  // A durable chat agent on the satellite.
  await addProject(satellite.electronApp, sat, projectDir);
  const name = `remote-chat-${Date.now()}`;
  const agentId = await createDurableAgent(sat, { projectName: path.basename(projectDir), name, orchestrator: 'claude-code' });
  // Classic opens the agent from its row; the new layout opens a created agent itself.
  if (!(await isNewLayout(sat))) await sat.locator(`[data-testid="agent-item-${agentId}"]`).click();
  const chat = sat.locator(`[data-testid="chat-view"][data-agent-pane="${agentId}"][data-view-context="main"]`);
  await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });

  // The controller pairs with the satellite.
  await enableAnnexViaPreload(sat);
  await enableAnnexViaPreload(controller.window);
  let link: string | undefined;
  await expect.poll(async () => { link = (await sat.evaluate(() => (window as any).clubhouse.annex.getStatus())).pairingUrl; return !!link; }, { timeout: 15_000 }).toBe(true);
  const url = new URL(link!);
  url.searchParams.delete('host');
  url.searchParams.append('host', '127.0.0.1');
  expect(await controller.window.evaluate((l) => (window as any).clubhouse.annexClient.pairWithLink(l), url.toString())).toMatchObject({ success: true });
  const satFp = ((await sat.evaluate(() => (window as any).clubhouse.annex.getStatus())).fingerprint as string).toLowerCase();
  await expect.poll(async () => {
    const sats: Array<{ fingerprint: string; state: string }> = await controller!.window.evaluate(() => (window as any).clubhouse.annexClient.getSatellites());
    return sats.find((s) => s.fingerprint.toLowerCase() === satFp)?.state;
  }, { timeout: 30_000 }).toBe('connected');

  // The controller reads the agent's chat from the satellite.
  const page = await controller.window.evaluate(([fp, id]) => (window as any).clubhouse.annexClient.chatPage(fp, id, { limit: 100 }), [satFp, agentId] as const);
  expect(page).toMatchObject({ agentId, state: 'idle' });
  const sessionId = page.sessionId as string;
  expect(sessionId).toBeTruthy();

  // ...and sends both turns; the satellite shows each finish.
  const footers = sat.locator('[data-testid="chat-turn-footer"]');
  for (const [i, text] of ['Reply with the word one.', 'Reply with the word two.'].entries()) {
    const receipt = await controller.window.evaluate(([fp, id, sid, t]) => (window as any).clubhouse.annexClient.chatCommand(fp, { type: 'chat.send', agentId: id, sessionId: sid, text: t }), [satFp, agentId, sessionId, text] as const);
    expect(receipt).toMatchObject({ status: 'completed' });
    await expect(footers).toHaveCount(i + 1, { timeout: 20_000 });
  }
  await expect(chat).toHaveAttribute('data-state', 'idle');

  // The controller sees the finished conversation in its page too.
  const after = await controller.window.evaluate(([fp, id]) => (window as any).clubhouse.annexClient.chatPage(fp, id, { limit: 200 }), [satFp, agentId] as const);
  expect((after.events as Array<{ type: string }>).filter((e) => e.type === 'turn_ended').length).toBeGreaterThanOrEqual(2);

  // #2398: one hosted-only desktop UI image round trip, using the same fake runtime.
  // This uses fixture instances only; never a real model, file outside the fixture, or local E2E run.
  const target = await controller.window.evaluate(async (fp) => {
    const satellites: Array<{ id: string; fingerprint: string }> = await window.clubhouse.annexClient.getSatellites();
    const matches = satellites.filter((entry) => entry.fingerprint.toLowerCase() === fp);
    if (matches.length !== 1) throw new Error('Expected one exact paired satellite');
    return { id: matches[0].id };
  }, satFp);
  const project = await sat.evaluate(async (directory) => {
    const projects: Array<{ id: string; path: string }> = await window.clubhouse.project.list();
    const matches = projects.filter((entry) => entry.path === directory);
    if (matches.length !== 1) throw new Error('Expected one exact fixture project');
    return { id: matches[0].id };
  }, projectDir);
  const remoteAgentId = `remote||${target.id}||${agentId}`;
  const remoteProjectId = `remote||${target.id}||${project.id}`;
  if (!(await isNewLayout(controller.window))) {
    await controller.window.getByTestId(`host-satellite-${target.id}`).click();
    await controller.window.getByTestId(`project-${remoteProjectId}`).click();
  } else {
    const group = controller.window.getByTestId(`project-group-${remoteProjectId}`);
    const toggle = group.locator('[data-tree-toggle]');
    if ((await toggle.getAttribute('aria-label'))?.startsWith('Expand ')) await toggle.click();
  }
  await controller.window.getByTestId(`agent-item-${remoteAgentId}`).click();
  const remoteView = controller.window.locator(`[data-testid="chat-view"][data-agent-pane="${remoteAgentId}"][data-view-context="main"]`);
  await expect(remoteView).toHaveAttribute('data-state', 'idle');
  const pathCalls = () => controller!.electronApp.evaluate(() => {
    const calls = (globalThis as unknown as { __clubhouseRichChatCalls: Record<string, number> }).__clubhouseRichChatCalls;
    return Object.fromEntries(['chat:stat-paths', 'chat:read-file-preview', 'chat:import-local-image', 'chat:file-action'].map((key) => [key, calls[key] ?? 0]));
  });
  const beforePaths = await pathCalls();
  const bytes = await fs.promises.readFile(CHAT_MEDIA.png);
  await remoteView.getByTestId('chat-attach-input').setInputFiles({ name: 'remote-image.png', mimeType: 'image/png', buffer: bytes });
  await expect(remoteView.getByTestId('chat-attachment')).toHaveCount(1);
  await remoteView.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect this image.');
  await remoteView.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await expect(footers).toHaveCount(3, { timeout: 20_000 });
  await expect(remoteView).toHaveAttribute('data-state', 'idle');
  const attachment = remoteView.getByTestId('chat-attachment-thumb');
  await expect(attachment).toHaveCount(1);
  await expect(attachment).toHaveAttribute('aria-busy', 'false');
  await attachment.click();
  await expect(controller.window.getByTestId('chat-image-full')).toHaveAttribute('src', `data:image/png;base64,${bytes.toString('base64')}`);
  await expect(controller.window.getByTestId('chat-image-viewer').getByRole('button', { name: /Show in Finder|Show in Explorer|Show in folder/ })).toHaveCount(0);
  await controller.window.getByTestId('chat-image-viewer').getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(controller.window.getByTestId('chat-image-viewer')).toContainText('Copied');
  await controller.window.getByTestId('chat-image-viewer').getByRole('button', { name: 'Close', exact: true }).click();
  // The returned tool image is a satellite mediaRef too, independent of the uploaded echo.
  await expect(remoteView.getByTestId('chat-tool-images').getByTestId('chat-image-thumb')).toBeVisible();
  await remoteView.getByRole('link', { name: 'remote fixture file' }).click();
  await expect(controller.window.getByTestId('local-file-preview')).toHaveCount(0);
  expect(await pathCalls()).toEqual(beforePaths);
  const uploaded = await controller.window.evaluate(async ([fp, id]) => {
    const result = await window.clubhouse.annexClient.chatPage(fp, id, { limit: 200 }) as { events: Array<{ type: string; data: { content?: Array<{ type: string; mediaRef?: string; path?: string; data?: unknown }> } }> };
    return result.events.filter((event) => event.type === 'user_message').flatMap((event) => event.data.content ?? []).filter((block) => block.type === 'image');
  }, [satFp, agentId] as const);
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0].mediaRef).toMatch(/^[0-9a-f]{64}\.png$/);
  expect(uploaded[0].path).not.toMatch(/[\\/]/);
  expect(uploaded[0].data).toBeUndefined();

  await expect.poll(async () => {
    const report = await fakes!.report('claude').catch((): undefined => undefined);
    return report && { mismatch: report.mismatch, complete: report.complete };
  }, { timeout: 20_000 }).toEqual({ mismatch: null, complete: true });
});
