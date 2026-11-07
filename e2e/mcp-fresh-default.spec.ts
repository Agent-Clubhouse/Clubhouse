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
  const result = await window.evaluate(async () => {
    const groupProject = await window.clubhouse.groupProject.create('Fresh MCP Project') as {
      id: string;
      name: string;
    };
    await window.clubhouse.mcpBinding.bind('copilot-fresh-agent', {
      targetId: groupProject.id,
      targetKind: 'group-project',
      label: groupProject.name,
      agentName: 'Copilot Fresh Agent',
      targetName: groupProject.name,
    });
    const bindings = await window.clubhouse.mcpBinding.getBindings();
    return { groupProject, bindings };
  });

  expect(result.bindings).toContainEqual(expect.objectContaining({
    agentId: 'copilot-fresh-agent',
    targetId: result.groupProject.id,
    targetKind: 'group-project',
    agentName: 'Copilot Fresh Agent',
  }));
});
