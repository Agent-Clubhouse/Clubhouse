/**
 * #1544: canvas wires are bound at startup, before any canvas is opened.
 *
 * Seeds the app-wide canvas store in a disposable profile (two agents wired
 * both ways, plus a wire to an agent whose card was removed), launches
 * without opening the canvas, and checks the bindings and the canvas
 * membership index from the main process. The seeded files must come out
 * byte-for-byte unchanged.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchApp, type ElectronApp } from './launch';
import { createDisposableProfile, type DisposableProfile } from './app-profile';

let electronApp: ElectronApp | undefined;
let window: Page;
let profile: DisposableProfile;
let kvDir: string;

const card = (id: string, agentId: string) => ({
  id, type: 'agent', agentId, position: { x: 0, y: 0 }, size: { width: 300, height: 200 },
  title: agentId, displayName: agentId, zIndex: 0, metadata: { agentId },
});
const instances = [{
  id: 'canvas_e2e_1544', name: 'startup-board',
  views: [card('cv_a', 'durable_e2e_a'), card('cv_b', 'durable_e2e_b')],
  viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 2,
}];
const wires = [
  { agentId: 'durable_e2e_a', targetId: 'durable_e2e_b', targetKind: 'agent', label: 'B', agentName: 'A', targetName: 'B' },
  { agentId: 'durable_e2e_b', targetId: 'durable_e2e_a', targetKind: 'agent', label: 'A', agentName: 'B', targetName: 'A' },
  { agentId: 'durable_e2e_a', targetId: 'durable_e2e_gone', targetKind: 'agent', label: 'gone' },
];

function writeKv(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  fs.writeFileSync(path.join(kvDir, `${key}.json`), json);
  fs.writeFileSync(path.join(kvDir, `${key}.json.bak`), json);
}

/** The store files the app left on disk (its output, not source). */
async function readStoreFiles(): Promise<Record<string, string>> {
  const names = fs.readdirSync(kvDir).sort();
  const contents = await Promise.all(names.map((f) => fs.promises.readFile(path.join(kvDir, f), 'utf-8')));
  return Object.fromEntries(names.map((f, i) => [f, contents[i]]));
}

test.beforeAll(async () => {
  profile = createDisposableProfile({ label: 'canvas-startup' });
  // The profile is also the app's home, so this is ~/.clubhouse/plugin-data/canvas/kv.
  kvDir = path.join(profile.userDataDir, '.clubhouse', 'plugin-data', 'canvas', 'kv');
  fs.mkdirSync(kvDir, { recursive: true });
  writeKv('canvas-instances', instances);
  writeKv('canvas-instances-backup', instances);
  writeKv('canvas-active-id', 'canvas_e2e_1544');
  writeKv('canvas-wires', wires);
  ({ electronApp, window } = await launchApp({ profile }));
});

test.afterAll(async () => {
  await electronApp?.close();
  profile?.dispose();
});

test('wires from the app-wide canvas are bound without opening the canvas', async () => {
  const before = await readStoreFiles();

  await expect.poll(async () => {
    const bindings = await window.evaluate(() => window.clubhouse.mcpBinding.getBindings()) as Array<{ agentId: string; targetId: string }>;
    return bindings.map((b) => `${b.agentId}->${b.targetId}`).sort();
  }, { timeout: 15_000 }).toEqual([
    'durable_e2e_a->durable_e2e_b',
    'durable_e2e_b->durable_e2e_a',
  ]);

  const memberships = await window.evaluate(() => window.clubhouse.canvas.getAgentCanvases('durable_e2e_a', null));
  expect(memberships).toEqual([
    { scope: 'app', canvasId: 'canvas_e2e_1544', name: 'startup-board', viewId: 'cv_a' },
  ]);

  expect(await readStoreFiles()).toEqual(before);
});
