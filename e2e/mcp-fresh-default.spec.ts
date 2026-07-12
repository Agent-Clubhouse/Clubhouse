import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import { launchApp } from './launch';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;
let userDataDir: string | undefined;

test.beforeAll(async () => {
  ({ electronApp, window, userDataDir } = await launchApp({ experimental: {} }));
});

test.afterAll(async () => {
  await electronApp?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('fresh install registers MCP bindings using the shared enabled default', async () => {
  const result = await window.evaluate(async () => {
    const settings = await window.clubhouse.settings.get('mcp') as {
      enabled?: boolean;
      projectDefault?: boolean;
    };
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
    return { settings, groupProject, bindings };
  });

  expect(result.settings).toMatchObject({ enabled: true, projectDefault: true });
  expect(result.bindings).toContainEqual(expect.objectContaining({
    agentId: 'copilot-fresh-agent',
    targetId: result.groupProject.id,
    targetKind: 'group-project',
    agentName: 'Copilot Fresh Agent',
  }));
});
