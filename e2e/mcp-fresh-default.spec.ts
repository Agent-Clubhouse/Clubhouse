import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;
let userDataDir: string | undefined;

test.beforeAll(async () => {
  // An old saved "off" is ignored: the Clubhouse MCP always runs.
  ({ electronApp, window, userDataDir } = await launchApp({ experimental: {}, userDataFiles: { 'mcp-settings.json': { enabled: false } } }));
});

test.afterAll(async () => {
  await electronApp?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('registers MCP bindings at startup, whatever an old MCP setting says', async () => {
  // An agent-to-agent wire, which binds for agents that haven't started yet. (A group
  // project's members come from its membership record since #3357, not from wires.)
  const bindings = await window.evaluate(async () => {
    await window.clubhouse.mcpBinding.bind('copilot-fresh-agent', {
      targetId: 'copilot-fresh-peer',
      targetKind: 'agent',
      label: 'Copilot Fresh Peer',
      agentName: 'Copilot Fresh Agent',
      targetName: 'Copilot Fresh Peer',
    });
    return window.clubhouse.mcpBinding.getBindings();
  });

  expect(bindings).toContainEqual(expect.objectContaining({
    agentId: 'copilot-fresh-agent',
    targetId: 'copilot-fresh-peer',
    targetKind: 'agent',
    agentName: 'Copilot Fresh Agent',
  }));
});
