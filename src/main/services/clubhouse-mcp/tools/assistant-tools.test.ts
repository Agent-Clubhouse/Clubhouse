import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { registerAssistantTools } from './assistant-tools';
import { _resetForTesting, callTool } from '../tool-registry';
import { bindingManager } from '..';
import type { McpBinding } from '../types';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../project-store', () => ({
  list: vi.fn().mockResolvedValue([
    { id: 'proj-1', name: 'my-app', displayName: 'My App', path: '/home/user/my-app' },
    { id: 'proj-2', name: 'api-server', displayName: null, path: '/home/user/api-server' },
  ]),
}));

vi.mock('../../agent-config', () => ({
  listDurable: vi.fn().mockResolvedValue([
    { id: 'agent-1', name: 'coder', color: '#ff0000', model: 'opus', useWorktree: true, orchestrator: 'claude-code' },
    { id: 'agent-2', name: 'reviewer', color: '#00ff00', model: 'sonnet', useWorktree: false, orchestrator: 'claude-code' },
  ]),
}));

vi.mock('../../agent-system', () => ({
  getAvailableOrchestrators: vi.fn().mockReturnValue([
    { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC' },
    { id: 'copilot-cli', displayName: 'GitHub Copilot CLI', shortName: 'GH' },
  ]),
  checkAvailability: vi.fn().mockResolvedValue({ available: true }),
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

// ── Setup ─────────────────────────────────────────────────────────────────

const TEST_AGENT_ID = 'assistant-test-agent';
const ASSISTANT_TARGET_ID = 'clubhouse-assistant';

function createAssistantBinding(): void {
  bindingManager.bind(TEST_AGENT_ID, {
    targetId: ASSISTANT_TARGET_ID,
    targetKind: 'assistant',
    label: 'Clubhouse Assistant',
  });
}

async function callAssistantTool(suffix: string, args: Record<string, unknown> = {}): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  const toolName = `assistant__${ASSISTANT_TARGET_ID}__${suffix}`;
  return callTool(TEST_AGENT_ID, toolName, args);
}

describe('assistant-tools', () => {
  beforeEach(() => {
    _resetForTesting();
    registerAssistantTools();
    createAssistantBinding();
  });

  afterEach(() => {
    bindingManager.unbind(TEST_AGENT_ID, ASSISTANT_TARGET_ID);
  });

  // ── list_projects ────────────────────────────────────────────────────

  it('list_projects returns project data', async () => {
    const result = await callAssistantTool('list_projects');
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('proj-1');
    expect(data[0].name).toBe('My App');
    expect(data[1].name).toBe('api-server');
  });

  // ── list_agents ──────────────────────────────────────────────────────

  it('list_agents returns agent data for a project', async () => {
    const result = await callAssistantTool('list_agents', { project_path: '/home/user/my-app' });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data).toHaveLength(2);
    expect(data[0].name).toBe('coder');
    expect(data[1].name).toBe('reviewer');
  });

  it('list_agents requires project_path', async () => {
    const result = await callAssistantTool('list_agents', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required argument');
  });

  // ── get_app_state ────────────────────────────────────────────────────

  it('get_app_state returns app summary', async () => {
    const result = await callAssistantTool('get_app_state');
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.projectCount).toBe(2);
    expect(data.orchestrators).toHaveLength(2);
  });

  // ── get_orchestrators ────────────────────────────────────────────────

  it('get_orchestrators returns orchestrator availability', async () => {
    const result = await callAssistantTool('get_orchestrators');
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('claude-code');
    expect(data[0].available).toBe(true);
  });

  // ── check_path ───────────────────────────────────────────────────────

  it('check_path returns exists:true for real path', async () => {
    const result = await callAssistantTool('check_path', { path: os.tmpdir() });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.exists).toBe(true);
    expect(data.type).toBe('directory');
  });

  it('check_path returns exists:false for missing path', async () => {
    const result = await callAssistantTool('check_path', { path: '/nonexistent/path/xyz' });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.exists).toBe(false);
  });

  // ── list_directory ───────────────────────────────────────────────────

  it('list_directory returns entries for real directory', async () => {
    const result = await callAssistantTool('list_directory', { path: os.tmpdir() });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(Array.isArray(data)).toBe(true);
  });

  it('list_directory returns error for missing directory', async () => {
    const result = await callAssistantTool('list_directory', { path: '/nonexistent/dir' });
    expect(result.isError).toBe(true);
  });

  // ── find_git_repos ───────────────────────────────────────────────────

  it('find_git_repos scans directory', async () => {
    // Create a temp dir with a .git subdirectory
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'assistant-test-'));
    const repoDir = path.join(tmpDir, 'my-repo');
    await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true });

    try {
      const result = await callAssistantTool('find_git_repos', { directory: tmpDir });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('my-repo');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── search_help ──────────────────────────────────────────────────────

  it('search_help returns hint about system prompt', async () => {
    const result = await callAssistantTool('search_help', { query: 'canvas' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('system prompt');
  });

  // ── get_settings ─────────────────────────────────────────────────────

  it('get_settings returns JSON', async () => {
    const result = await callAssistantTool('get_settings');
    expect(result.isError).toBeFalsy();
    // Should return valid JSON (even if empty)
    expect(() => JSON.parse(result.content[0].text!)).not.toThrow();
  });

  // ── Tool scoping ─────────────────────────────────────────────────────

  it('tools are only available via assistant binding', async () => {
    // Try calling with a non-existent binding
    const result = await callTool('other-agent', `assistant__${ASSISTANT_TARGET_ID}__list_projects`, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No binding');
  });
});
