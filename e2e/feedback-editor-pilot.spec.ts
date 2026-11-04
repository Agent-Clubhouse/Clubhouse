import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './launch';
// @ts-expect-error plain JavaScript, shared with scripts/pilot/run-chromium.mjs
import { runScenario } from './feedback-editor-pilot-scenario.mjs';

/**
 * PILOT, DO NOT MERGE. The Framebriar screenshot editor pinned to ac13f32, in the real Electron renderer:
 * file://, the production CSP header, the forge webpack build. Prints what it found as one PILOT_RESULT line.
 * No enrollment, no server and no report: the IPC call to main is replaced in pilot-hooks.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fixture = require('../src/renderer/features/feedback/pilot-vendor/test-support/screenshot-flatten-v1.json');

let app: LaunchedApp | undefined;

test.afterAll(async () => { await app?.electronApp.close(); });

test('feedback editor pilot in the real renderer', async () => {
  test.setTimeout(240_000);
  app = await launchApp({ label: 'feedback-pilot' });
  await app.window.waitForFunction(() => Boolean((window as unknown as { __feedbackEditorPilot?: unknown }).__feedbackEditorPilot));
  const size = app.window.viewportSize() ?? await app.window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const report = await runScenario(app.window, fixture, { perf: true });
  console.log(`PILOT_RESULT ${JSON.stringify({ platform: process.platform, size, ...report })}`);
  expect(report.problems).toEqual([]);
});
