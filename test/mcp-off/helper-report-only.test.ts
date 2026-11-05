/**
 * A helper with Clubhouse MCP off has a bridge, so it can start and report, and
 * nothing else. Older phones may offer it switches, so this proves the writes have
 * no authority, now or when MCP comes back: through the real agent.update and the
 * desktop's policy service, with the real gates, tools and a persona on disk.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const A = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs'); const nodeOs = require('os') as typeof import('os'); const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'helper-report-only-')));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return { dir };
});

vi.mock('electron', () => ({
  app: { getPath: () => A.dir, isPackaged: false, getVersion: () => '0.0.0-harness', getName: () => 'helper-report-only', on: () => {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => ({}) },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: {},
  dialog: {},
  Notification: class {},
}));
vi.mock('../../src/main/services/log-service', () => ({ appLog: () => {} }));

import { MCP_OFF_HELPER_TOOL_MESSAGE, MCP_REQUIRED_MESSAGE, ORCHESTRATION_OFF_MESSAGE } from '../../src/shared/orchestration-policy';
import { NEW_CHROME_FLAG } from '../../src/shared/chrome-flag';
import * as experimentalSettings from '../../src/main/services/experimental-settings';
import { resetNewChromeCacheForTests } from '../../src/main/window-chrome';
import * as projectStore from '../../src/main/services/project-store';
import * as agentConfig from '../../src/main/services/agent-config';
import { agentRegistry } from '../../src/main/services/agent-registry';
import { notifyMcpEnablementChanged, saveSettings as saveMcp } from '../../src/main/services/mcp-settings';
import { getOrchestrationPolicy, setOrchestrationPolicy, syncOrchestrationGate, watchMcpForOrchestration } from '../../src/main/services/orchestration-policy';
import { updateMobileAgent } from '../../src/main/services/mobile-agents';
import { callTool, getScopedToolList } from '../../src/main/services/clubhouse-mcp/tool-registry';
import { isCrossProjectEnabled, isOrchestrationEnabled, setOrchestrationEnabled } from '../../src/main/services/clubhouse-mcp/orchestration-gate';
import { setMcpCaller } from '../../src/main/services/clubhouse-mcp/mcp-call-gate';
import { registerMcpBindingHandlers } from '../../src/main/ipc/mcp-binding-handlers';

const SWITCHES = ['orchestrate', 'crossProjectHelpers', 'connectToDispatcher', 'autoHelpers'] as const;
const LEAD = 'durable_lead';
const HELPER = 'durable_worker';
const PERSONA_HELPER = 'durable_persona';

describe('a helper with Clubhouse MCP off', () => {
  let projectPath = '';
  let stopWatching: () => void;
  const project = () => ({ id: 'p1', name: 'project', path: projectPath });

  const config = async (id = HELPER) => (await agentConfig.getDurableConfig(projectPath, id))!;
  const saved = async (id = HELPER) => (await config(id)).orchestration;
  const toolNames = (id = HELPER) => getScopedToolList(id).map((t) => t.name);

  const appOff = async () => { await saveMcp({ enabled: false, projectDefault: true }); notifyMcpEnablementChanged(); };
  const projectOff = async () => { await saveMcp({ enabled: true, projectDefault: true, projectOverrides: { [projectPath]: false } }); notifyMcpEnablementChanged(); };
  const mcpBack = async () => { await saveMcp({ enabled: true, projectDefault: true }); notifyMcpEnablementChanged(); await new Promise((r) => setTimeout(r, 30)); };

  /** What spawnAgent does for the gates. */
  async function start(id = HELPER): Promise<void> {
    agentRegistry.register(id, { projectPath, orchestrator: 'claude-code', runtime: 'chat' } as never);
    await syncOrchestrationGate(projectPath, id);
    setMcpCaller(id, projectPath, await config(id));
  }

  const update = async (orchestration: Record<string, unknown> | null) =>
    updateMobileAgent(project() as never, await config(), { agentId: HELPER, orchestration } as never, { live: 'running', assertAuthorized: () => {} } as never);

  async function refusal(promise: Promise<unknown>): Promise<{ code: string; statusCode: number; detail?: string }> {
    try {
      await promise;
    } catch (err) {
      return err as { code: string; statusCode: number; detail?: string };
    }
    throw new Error('expected a refusal');
  }

  beforeAll(async () => {
    experimentalSettings.saveSettings({ [NEW_CHROME_FLAG]: true });
    resetNewChromeCacheForTests();
    projectPath = path.join(A.dir, 'project');
    fs.mkdirSync(path.join(projectPath, '.clubhouse', 'personas'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.clubhouse', 'personas', 'lead-like.md'), '---\norchestration: {"orchestrate": true}\n---\nLead the work.\n');
    const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, color: 'indigo', createdAt: '2026-01-01', orchestrator: 'claude-code', ...extra });
    fs.writeFileSync(path.join(projectPath, '.clubhouse', 'agents.json'), JSON.stringify([
      agent(LEAD, 'lead', { orchestration: { orchestrate: true } }),
      agent(HELPER, 'worker', { parentAgentId: LEAD }),
      agent(PERSONA_HELPER, 'persona-worker', { parentAgentId: LEAD, persona: 'lead-like' }),
    ]));
    await projectStore.add(projectPath);
    registerMcpBindingHandlers();
    stopWatching = watchMcpForOrchestration();
  }, 60_000);

  afterAll(() => {
    stopWatching();
    try { fs.rmSync(A.dir, { recursive: true, force: true }); } catch { /* the OS clears its temp folder */ }
  });

  beforeEach(async () => {
    for (const id of agentRegistry.getAllRegistrations().keys()) agentRegistry.untrack(id);
    for (const id of [HELPER, PERSONA_HELPER]) setOrchestrationEnabled(id, false);
    await agentConfig.setOrchestrationConfig(projectPath, HELPER, undefined);
    await mcpBack();
  });

  describe('turning a switch on', () => {
    it.each(SWITCHES)('%s through agent.update, app level off: 409 mcp_off, nothing saved, no gate', async (field) => {
      await start();
      await appOff();
      expect(await refusal(update({ [field]: true }))).toMatchObject({ code: 'mcp_off', statusCode: 409, detail: MCP_REQUIRED_MESSAGE });
      expect(await saved()).toBeUndefined();
      expect(isOrchestrationEnabled(HELPER)).toBe(false);
      expect(isCrossProjectEnabled(HELPER)).toBe(false);
    });

    it.each(SWITCHES)('%s through agent.update, project level off with the Dispatcher on: the same', async (field) => {
      await start();
      await projectOff();
      expect(await refusal(update({ [field]: true }))).toMatchObject({ code: 'mcp_off', statusCode: 409, detail: MCP_REQUIRED_MESSAGE });
      expect(await saved()).toBeUndefined();
      expect(isOrchestrationEnabled(HELPER)).toBe(false);
    });

    it.each(SWITCHES)('%s through the desktop service: refused, nothing saved, no gate', async (field) => {
      await start();
      await appOff();
      const result = await setOrchestrationPolicy(projectPath, HELPER, { [field]: true });
      expect(result).toMatchObject({ ok: false, message: MCP_REQUIRED_MESSAGE, mcpRequired: true });
      expect(await saved()).toBeUndefined();
      expect(isOrchestrationEnabled(HELPER)).toBe(false);
    });

    it.each(SWITCHES)('%s refused, then MCP back in the same session: no extra tools, no gate, nothing saved', async (field) => {
      await start();
      const before = toolNames();
      await appOff();
      await refusal(update({ [field]: true }));
      await setOrchestrationPolicy(projectPath, HELPER, { [field]: true });
      expect(toolNames()).toEqual(['message_parent']);

      await mcpBack();
      expect(toolNames()).toEqual(before);
      expect(toolNames()).not.toContain('start_helper');
      expect(isOrchestrationEnabled(HELPER)).toBe(false);
      expect(isCrossProjectEnabled(HELPER)).toBe(false);
      expect(await saved()).toBeUndefined();
      expect((await callTool(HELPER, 'list_helpers', {})).content[0]).toMatchObject({ text: ORCHESTRATION_OFF_MESSAGE });
    });

    it('still works with MCP on, or with its own setting on', async () => {
      await start();
      expect(await setOrchestrationPolicy(projectPath, HELPER, { orchestrate: true })).toMatchObject({ ok: true });
      expect(isOrchestrationEnabled(HELPER)).toBe(true);
      await agentConfig.setOrchestrationConfig(projectPath, HELPER, undefined);
      setOrchestrationEnabled(HELPER, false);

      await agentConfig.updateDurableConfig(projectPath, HELPER, { mcpOverride: true });
      await appOff();
      expect(await setOrchestrationPolicy(projectPath, HELPER, { orchestrate: true })).toMatchObject({ ok: true });
      expect(isOrchestrationEnabled(HELPER)).toBe(true);
      await agentConfig.updateDurableConfig(projectPath, HELPER, { mcpOverride: null } as never);
    });
  });

  describe('turning off and clearing', () => {
    it.each(SWITCHES)('%s can be turned off and cleared, through both paths', async (field) => {
      await agentConfig.setOrchestrationConfig(projectPath, HELPER, { [field]: true });
      await start();
      await appOff();
      await update({ [field]: false });
      expect((await saved())?.[field]).toBe(false);
      await update({ [field]: null });
      expect((await saved())?.[field]).toBeUndefined();

      await agentConfig.setOrchestrationConfig(projectPath, HELPER, { [field]: true });
      expect(await setOrchestrationPolicy(projectPath, HELPER, { [field]: null })).toMatchObject({ ok: true });
      expect((await saved())?.[field]).toBeUndefined();
    });

    it('clearing everything works', async () => {
      await agentConfig.setOrchestrationConfig(projectPath, HELPER, { orchestrate: true, autoHelpers: true });
      await start();
      await appOff();
      await update(null);
      expect(await saved()).toBeUndefined();
    });
  });

  describe('a value saved before MCP went off', () => {
    it('stays untouched, and the session it was open for gets it back: no more than it had', async () => {
      await agentConfig.setOrchestrationConfig(projectPath, HELPER, { orchestrate: true, crossProjectHelpers: true });
      await start();
      expect(isOrchestrationEnabled(HELPER)).toBe(true);
      expect(toolNames()).toContain('start_helper');

      await appOff();
      await vi.waitFor(() => expect(isOrchestrationEnabled(HELPER)).toBe(false));
      expect(toolNames()).toEqual(['message_parent']);
      expect(await saved()).toEqual({ orchestrate: true, crossProjectHelpers: true });
      // Reads it as off, with what is saved kept, and a read doesn't reopen anything.
      expect(await getOrchestrationPolicy(projectPath, HELPER)).toMatchObject({ orchestrate: true, mcpReportOnly: true });
      expect(isOrchestrationEnabled(HELPER)).toBe(false);

      await mcpBack();
      await vi.waitFor(() => expect(isOrchestrationEnabled(HELPER)).toBe(true));
      expect(isCrossProjectEnabled(HELPER)).toBe(true);
      expect(toolNames()).toContain('start_helper');
      expect(await saved()).toEqual({ orchestrate: true, crossProjectHelpers: true });
    });

    it('a session started while MCP was off has no gate to get back: orchestration waits for its next start', async () => {
      await agentConfig.setOrchestrationConfig(projectPath, HELPER, { orchestrate: true });
      await appOff();
      await start();
      expect(isOrchestrationEnabled(HELPER)).toBe(false);

      await mcpBack();
      expect(isOrchestrationEnabled(HELPER)).toBe(false);
      expect(toolNames()).not.toContain('start_helper');
      expect(toolNames()).toContain('message_parent');
      expect(await saved()).toEqual({ orchestrate: true });

      agentRegistry.untrack(HELPER);
      await start();
      expect(isOrchestrationEnabled(HELPER)).toBe(true);
    });
  });

  describe('a persona with orchestrate: true', () => {
    it('opens no gate at start with MCP off, and follows the same rule when MCP returns', async () => {
      await appOff();
      await start(PERSONA_HELPER);
      expect(isOrchestrationEnabled(PERSONA_HELPER)).toBe(false);
      expect(toolNames(PERSONA_HELPER)).toEqual(['message_parent']);
      expect((await callTool(PERSONA_HELPER, 'start_helper', {})).content[0]).toMatchObject({ text: MCP_OFF_HELPER_TOOL_MESSAGE });

      await mcpBack();
      expect(isOrchestrationEnabled(PERSONA_HELPER)).toBe(false);
      expect(toolNames(PERSONA_HELPER)).not.toContain('start_helper');
      expect((await config(PERSONA_HELPER)).orchestration).toBeUndefined();

      agentRegistry.untrack(PERSONA_HELPER);
      await start(PERSONA_HELPER);
      expect(isOrchestrationEnabled(PERSONA_HELPER)).toBe(true);
      expect(toolNames(PERSONA_HELPER)).toContain('start_helper');
    });
  });

  it('message_parent is the one tool left, and it wakes nothing', async () => {
    await start();
    await appOff();
    expect(toolNames()).toEqual(['message_parent']);
    expect((await callTool(HELPER, 'message_parent', { text: 'done' })).content[0]).toMatchObject({ text: expect.stringContaining('asleep') });
    expect(agentRegistry.get(LEAD)).toBeUndefined();
  });
});
