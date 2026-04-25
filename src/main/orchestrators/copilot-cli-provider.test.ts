import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '# Instructions'),
  writeFileSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({
    birthtime: new Date('2026-04-01T10:00:00Z'),
    mtime: new Date('2026-04-01T12:00:00Z'),
  })),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

vi.mock('util', () => ({
  promisify: vi.fn((fn: any) => vi.fn(async (...args: any[]) => fn(...args))),
}));

vi.mock('./shared', () => ({
  findBinaryInPath: vi.fn(() => '/usr/local/bin/copilot'),
  homePath: vi.fn((...segments: string[]) => `/home/user/${segments.join('/')}`),
  humanizeModelId: vi.fn((id: string) => id),
}));

vi.mock('../services/config-pipeline', () => ({
  isClubhouseHookEntry: vi.fn(() => false),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

vi.mock('./adapters', () => ({
  AcpAdapter: class MockAcpAdapter {
    public ctorOpts: any;
    constructor(opts: any) {
      this.ctorOpts = opts;
    }
    start = vi.fn();
    sendMessage = vi.fn();
    respondToPermission = vi.fn();
    cancel = vi.fn();
    dispose = vi.fn();
  },
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as childProcess from 'child_process';
import { getShellEnvironment } from '../util/shell';
import { CopilotCliProvider } from './copilot-cli-provider';
import { findBinaryInPath } from './shared';
import { isClubhouseHookEntry } from '../services/config-pipeline';

describe('CopilotCliProvider', () => {
  let provider: CopilotCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CopilotCliProvider();
  });

  describe('identity', () => {
    it('has correct id and displayName', () => {
      expect(provider.id).toBe('copilot-cli');
      expect(provider.displayName).toBe('GitHub Copilot CLI');
      expect(provider.shortName).toBe('GHCP');
    });

    it('has Beta badge', () => {
      expect(provider.badge).toBe('Beta');
    });
  });

  describe('getPasteSubmitTiming', () => {
    it('returns GHCP-specific timing with extended delays and quiescence wait', () => {
      const timing = provider.getPasteSubmitTiming();
      expect(timing.initialDelayMs).toBe(2500);
      expect(timing.retryDelayMs).toBe(800);
      expect(timing.finalCheckDelayMs).toBe(400);
      expect(timing.chunkSize).toBe(256);
      expect(timing.chunkDelayMs).toBe(120);
      expect(timing.postEndMarkerDelayMs).toBe(300);
      expect(timing.quiescenceMs).toBe(200);
      expect(timing.quiescencePollMs).toBe(50);
    });

    it('uses longer delays than the base provider defaults', () => {
      const timing = provider.getPasteSubmitTiming();
      // Base provider uses 200/200/200 — GHCP needs more headroom
      expect(timing.initialDelayMs).toBeGreaterThan(200);
      expect(timing.retryDelayMs).toBeGreaterThan(200);
      expect(timing.finalCheckDelayMs).toBeGreaterThan(200);
    });
  });

  describe('getCapabilities', () => {
    it('reports headless and hooks support', () => {
      const caps = provider.getCapabilities();
      expect(caps.headless).toBe(true);
      expect(caps.hooks).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.permissions).toBe(true);
      expect(caps.structuredOutput).toBe(true);
    });

    it('reports structuredMode enabled with acp protocol', () => {
      const caps = provider.getCapabilities();
      expect(caps.structuredMode).toBe(true);
      expect(caps.structuredProtocol).toBe('acp');
    });
  });

  describe('createStructuredAdapter', () => {
    it('returns an AcpAdapter instance', () => {
      const adapter = provider.createStructuredAdapter!();
      expect(adapter).toBeDefined();
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.sendMessage).toBe('function');
      expect(typeof adapter.respondToPermission).toBe('function');
      expect(typeof adapter.cancel).toBe('function');
      expect(typeof adapter.dispose).toBe('function');
    });

    it('passes --acp and --stdio in spawn args', () => {
      const adapter = provider.createStructuredAdapter!() as any;
      expect(adapter.ctorOpts.args).toContain('--acp');
      expect(adapter.ctorOpts.args).toContain('--stdio');
    });

    it('passes --autopilot in spawn args (Mission 72: structured mode is autonomous)', () => {
      const adapter = provider.createStructuredAdapter!() as any;
      expect(adapter.ctorOpts.args).toContain('--autopilot');
    });

    it('uses the resolved binary path', () => {
      const adapter = provider.createStructuredAdapter!() as any;
      expect(adapter.ctorOpts.binary).toBe('/usr/local/bin/copilot');
    });
  });

  describe('conventions', () => {
    it('uses .github directory for config', () => {
      expect(provider.conventions.configDir).toBe('.github');
      expect(provider.conventions.localInstructionsFile).toBe('copilot-instructions.md');
      expect(provider.conventions.mcpConfigFile).toBe('.github/mcp.json');
    });

    it('uses hooks/hooks.json for local settings', () => {
      expect(provider.conventions.localSettingsFile).toBe('hooks/hooks.json');
    });

    it('has skills and agent templates dirs', () => {
      expect(provider.conventions.skillsDir).toBe('skills');
      expect(provider.conventions.agentTemplatesDir).toBe('agents');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when binary found', async () => {
      const result = await provider.checkAvailability();
      expect(result).toEqual({ available: true });
    });

    it('returns unavailable when binary not found', async () => {
      vi.mocked(findBinaryInPath).mockImplementationOnce(() => {
        throw new Error('not found');
      });
      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toBe('not found');
    });

    it('returns generic error for non-Error throws', async () => {
      vi.mocked(findBinaryInPath).mockImplementationOnce(() => {
        throw 'string error';
      });
      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toBe('Could not find GitHub Copilot CLI');
    });
  });

  describe('buildSpawnCommand', () => {
    it('returns binary and empty args for basic spawn', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(result.binary).toBe('/usr/local/bin/copilot');
      expect(result.args).toEqual([]);
    });

    it('adds --yolo and --autopilot flags for freeAgentMode', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', freeAgentMode: true });
      expect(result.args).toContain('--yolo');
      expect(result.args).toContain('--autopilot');
    });

    it('does not add --yolo or --autopilot when freeAgentMode is false', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', freeAgentMode: false });
      expect(result.args).not.toContain('--yolo');
      expect(result.args).not.toContain('--autopilot');
    });

    it('does not add --yolo or --autopilot when freeAgentMode is undefined', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(result.args).not.toContain('--yolo');
      expect(result.args).not.toContain('--autopilot');
    });

    it('adds --model flag for non-default model', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', model: 'gpt-5' });
      expect(result.args).toContain('--model');
      expect(result.args).toContain('gpt-5');
    });

    it('skips --model flag for default model', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', model: 'default' });
      expect(result.args).not.toContain('--model');
    });

    it('adds -p flag with mission content', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        mission: 'Fix the bug',
      });
      expect(result.args).toContain('-p');
      expect(result.args).toContain('Fix the bug');
    });

    it('combines systemPrompt and mission', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        systemPrompt: 'You are helpful',
        mission: 'Fix the bug',
      });
      const promptIdx = result.args.indexOf('-p');
      expect(result.args[promptIdx + 1]).toContain('You are helpful');
      expect(result.args[promptIdx + 1]).toContain('Fix the bug');
    });

    it('adds --allow-tool flags for allowed tools', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        allowedTools: ['read', 'edit'],
      });
      expect(result.args).toContain('--allow-tool');
      expect(result.args.filter(a => a === '--allow-tool')).toHaveLength(2);
    });

    it('adds --agent flag when agentFile is set', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        agentFile: 'k8s-assistant',
      });
      expect(result.args).toContain('--agent');
      expect(result.args[result.args.indexOf('--agent') + 1]).toBe('k8s-assistant');
    });

    it('adds --source flag when agentSource is set', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        agentSource: '/home/user/.copilot/agents',
      });
      expect(result.args).toContain('--source');
      expect(result.args[result.args.indexOf('--source') + 1]).toBe('/home/user/.copilot/agents');
    });

    it('adds both --agent and --source when both are set', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        agentFile: 'k8s-assistant',
        agentSource: '/home/user/.copilot/agents',
      });
      expect(result.args).toContain('--agent');
      expect(result.args).toContain('--source');
      expect(result.args[result.args.indexOf('--agent') + 1]).toBe('k8s-assistant');
      expect(result.args[result.args.indexOf('--source') + 1]).toBe('/home/user/.copilot/agents');
    });

    it('does not add --agent or --source when not set', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(result.args).not.toContain('--agent');
      expect(result.args).not.toContain('--source');
    });
  });

  describe('getExitCommand', () => {
    it('returns /exit with carriage return', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('writeHooksConfig', () => {
    it('creates hooks directory and writes hooks.json', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project', '.github', 'hooks'),
        { recursive: true },
      );
      expect(fsp.writeFile).toHaveBeenCalled();

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.hooks).toBeDefined();
      expect(written.hooks.preToolUse).toBeDefined();
      expect(written.hooks.postToolUse).toBeDefined();
      expect(written.hooks.errorOccurred).toBeDefined();
    });

    it('curl command uses env var references for agent ID and nonce', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      const hookEntry = written.hooks.preToolUse[0];
      if (process.platform === 'win32') {
        expect(hookEntry.bash).toContain('%CLUBHOUSE_AGENT_ID%');
        expect(hookEntry.bash).toContain('%CLUBHOUSE_HOOK_NONCE%');
      } else {
        expect(hookEntry.bash).toContain('${CLUBHOUSE_AGENT_ID}');
        expect(hookEntry.bash).toContain('${CLUBHOUSE_HOOK_NONCE}');
      }
    });

    it('merges with existing settings preserving user hooks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: 'echo user-hook', timeoutSec: 3 }],
        },
      }));
      vi.mocked(isClubhouseHookEntry).mockReturnValue(false);

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      // User hook should be preserved (first), Clubhouse hook appended
      expect(written.hooks.preToolUse.length).toBeGreaterThan(1);
      expect(written.hooks.preToolUse[0].bash).toBe('echo user-hook');
    });

    it('replaces stale Clubhouse entries', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: 'old-clubhouse-hook' }],
        },
      }));
      vi.mocked(isClubhouseHookEntry).mockReturnValue(true);

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      // Stale hook should be removed, only new Clubhouse hook present
      expect(written.hooks.preToolUse).toHaveLength(1);
      expect(written.hooks.preToolUse[0].bash).not.toBe('old-clubhouse-hook');
    });

    it('each hook entry has type command and timeoutSec', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      for (const eventKey of ['preToolUse', 'postToolUse', 'errorOccurred', 'sessionStart', 'userPromptSubmitted']) {
        const entry = written.hooks[eventKey][0];
        expect(entry.type).toBe('command');
        expect(entry.timeoutSec).toBe(5);
      }
    });

    it('includes permissionRequest hook with 120s timeout', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.hooks.permissionRequest).toBeDefined();
      expect(written.hooks.permissionRequest[0].type).toBe('command');
      expect(written.hooks.permissionRequest[0].timeoutSec).toBe(120);
    });

    it('includes sessionStart and userPromptSubmitted hooks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.hooks.sessionStart).toBeDefined();
      expect(written.hooks.userPromptSubmitted).toBeDefined();
    });

    it('writes all 6 hook events', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      const hookKeys = Object.keys(written.hooks);
      expect(hookKeys).toContain('preToolUse');
      expect(hookKeys).toContain('postToolUse');
      expect(hookKeys).toContain('errorOccurred');
      expect(hookKeys).toContain('permissionRequest');
      expect(hookKeys).toContain('sessionStart');
      expect(hookKeys).toContain('userPromptSubmitted');
      expect(hookKeys).toHaveLength(6);
    });
  });

  describe('parseHookEvent', () => {
    it('parses preToolUse event', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'shell',
        tool_input: { command: 'ls' },
      });
      expect(result).toEqual({
        kind: 'pre_tool',
        toolName: 'shell',
        toolInput: { command: 'ls' },
        message: undefined,
      });
    });

    it('parses postToolUse event', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'postToolUse',
        toolName: 'edit',
      });
      expect(result).toEqual({
        kind: 'post_tool',
        toolName: 'edit',
        toolInput: undefined,
        message: undefined,
      });
    });

    it('parses errorOccurred event as tool_error', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'errorOccurred',
        message: 'Something went wrong',
      });
      expect(result).toEqual({
        kind: 'tool_error',
        toolName: undefined,
        toolInput: undefined,
        message: 'Something went wrong',
      });
    });

    it('parses sessionEnd event as stop', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'sessionEnd' });
      expect(result?.kind).toBe('stop');
    });

    it('accepts camelCase toolName field', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        toolName: 'read',
      });
      expect(result?.toolName).toBe('read');
    });

    it('prefers tool_name over toolName when both present', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'shell',
        toolName: 'read',
      });
      expect(result?.toolName).toBe('shell');
    });

    it('parses toolArgs as string (JSON)', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'shell',
        toolArgs: '{"command":"git status"}',
      });
      expect(result?.toolInput).toEqual({ command: 'git status' });
    });

    it('parses toolArgs as object', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'edit',
        toolArgs: { path: '/file.ts', content: 'code' },
      });
      expect(result?.toolInput).toEqual({ path: '/file.ts', content: 'code' });
    });

    it('returns null for unknown event', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'unknown' });
      expect(result).toBeNull();
    });

    it('parses permissionRequest event as permission_request', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'permissionRequest',
        tool_name: 'shell',
        tool_input: { command: 'rm -rf /' },
      });
      expect(result).toEqual({
        kind: 'permission_request',
        toolName: 'shell',
        toolInput: { command: 'rm -rf /' },
        message: undefined,
      });
    });

    it('parses sessionStart event as notification', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'sessionStart' });
      expect(result?.kind).toBe('notification');
    });

    it('parses userPromptSubmitted event as notification', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'userPromptSubmitted',
        message: 'User submitted prompt',
      });
      expect(result?.kind).toBe('notification');
      expect(result?.message).toBe('User submitted prompt');
    });

    it('returns null for non-object input', () => {
      expect(provider.parseHookEvent(null)).toBeNull();
      expect(provider.parseHookEvent('string')).toBeNull();
      expect(provider.parseHookEvent(42)).toBeNull();
      expect(provider.parseHookEvent(undefined)).toBeNull();
    });
  });

  describe('readInstructions', () => {
    it('reads from .github/copilot-instructions.md', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# Instructions');
      const result = await provider.readInstructions('/project');
      expect(fsp.readFile).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'utf-8',
      );
      expect(result).toBe('# Instructions');
    });

    it('returns empty string when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      const result = await provider.readInstructions('/project');
      expect(result).toBe('');
    });
  });

  describe('writeInstructions', () => {
    it('creates .github directory and writes copilot-instructions.md', async () => {
      await provider.writeInstructions('/project', 'New instructions');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project', '.github'),
        { recursive: true }
      );
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'New instructions',
        'utf-8',
      );
    });
  });

  describe('buildHeadlessCommand', () => {
    it('returns null when no mission provided', async () => {
      const result = await provider.buildHeadlessCommand({ cwd: '/project' });
      expect(result).toBeNull();
    });

    it('builds command with mission', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
      });
      expect(result).not.toBeNull();
      expect(result!.binary).toBe('/usr/local/bin/copilot');
      expect(result!.args).toContain('-p');
      expect(result!.args).toContain('--allow-all');
      expect(result!.args).toContain('--output-format');
      expect(result!.args).toContain('json');
    });

    it('passes --autopilot in args (Mission 72: headless mode is autonomous)', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
      });
      expect(result!.args).toContain('--autopilot');
    });

    it('passes --autopilot regardless of model selection', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        model: 'gpt-5',
      });
      expect(result!.args).toContain('--autopilot');
    });

    it('adds model flag for non-default model', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        model: 'gpt-5',
      });
      expect(result!.args).toContain('--model');
      expect(result!.args).toContain('gpt-5');
    });

    it('skips model flag for default model', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        model: 'default',
      });
      expect(result!.args).not.toContain('--model');
    });

    it('returns stream-json outputKind', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
      });
      expect(result!.outputKind).toBe('stream-json');
    });

    it('combines systemPrompt and mission', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        systemPrompt: 'Be thorough',
      });
      const pIdx = result!.args.indexOf('-p');
      expect(result!.args[pIdx + 1]).toContain('Be thorough');
      expect(result!.args[pIdx + 1]).toContain('Fix bug');
    });
  });

  describe('getModelOptions', () => {
    it('returns fallback model list when binary help fails', async () => {
      // execFile mock already throws by default
      const options = await provider.getModelOptions();
      expect(options.length).toBeGreaterThanOrEqual(4);
      expect(options[0]).toEqual({ id: 'default', label: 'Default' });
      const ids = options.map(o => o.id);
      expect(ids).toContain('claude-sonnet-4.5');
      expect(ids).toContain('claude-opus-4.6');
      expect(ids).toContain('gpt-5');
    });

    it('includes 1M context variants in fallback list', async () => {
      const options = await provider.getModelOptions();
      const ids = options.map(o => o.id);
      expect(ids).toContain('claude-opus-4-6[1m]');
      expect(ids).toContain('claude-sonnet-4-6[1m]');
    });

    it('first option is always default', async () => {
      const options = await provider.getModelOptions();
      expect(options[0].id).toBe('default');
      expect(options[0].label).toBe('Default');
    });

    it('every option has id and label strings', async () => {
      const options = await provider.getModelOptions();
      for (const opt of options) {
        expect(typeof opt.id).toBe('string');
        expect(typeof opt.label).toBe('string');
        expect(opt.id.length).toBeGreaterThan(0);
        expect(opt.label.length).toBeGreaterThan(0);
      }
    });

    it('passes shell environment to execFile for --help call', async () => {
      const mockEnv = { PATH: '/custom/path:/usr/bin', HOME: '/home/user' };
      vi.mocked(getShellEnvironment).mockReturnValue(mockEnv);

      await provider.getModelOptions();

      const calls = vi.mocked(childProcess.execFile).mock.calls;
      const helpCall = calls.find((c) => (c[1] as string[])?.[0] === '--help');
      expect(helpCall).toBeDefined();
      const opts = helpCall![2] as Record<string, unknown>;
      expect(opts.env).toEqual(mockEnv);
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns durable permissions using Copilot tool names', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toEqual(['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)']);
    });

    it('durable permissions use "shell" not "Bash" or "bash"', () => {
      const perms = provider.getDefaultPermissions('durable');
      for (const p of perms) {
        expect(p).not.toMatch(/^Bash/);
        expect(p).not.toMatch(/^bash/);
        expect(p).toMatch(/^shell/);
      }
    });

    it('returns quick permissions with file tool names', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('shell(git:*)');
      expect(perms).toContain('shell(npm:*)');
      expect(perms).toContain('shell(npx:*)');
      expect(perms).toContain('read');
      expect(perms).toContain('edit');
      expect(perms).toContain('search');
    });

    it('quick permissions use lowercase tool names (not PascalCase)', () => {
      const perms = provider.getDefaultPermissions('quick');
      for (const p of perms) {
        expect(p).not.toMatch(/^[A-Z]/);
      }
    });

    it('quick permissions do NOT use Claude Code tool names', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).not.toContain('Read');
      expect(perms).not.toContain('Write');
      expect(perms).not.toContain('Edit');
      expect(perms).not.toContain('Glob');
      expect(perms).not.toContain('Grep');
      expect(perms).not.toContain('Bash(git:*)');
    });

    it('returns a new array each call (no shared reference)', () => {
      const a = provider.getDefaultPermissions('durable');
      const b = provider.getDefaultPermissions('durable');
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('quick returns a new array each call', () => {
      const a = provider.getDefaultPermissions('quick');
      const b = provider.getDefaultPermissions('quick');
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('toolVerb', () => {
    it('maps all Copilot tool names to verbs', () => {
      expect(provider.toolVerb('shell')).toBe('Running command');
      expect(provider.toolVerb('edit')).toBe('Editing file');
      expect(provider.toolVerb('read')).toBe('Reading file');
      expect(provider.toolVerb('search')).toBe('Searching code');
      expect(provider.toolVerb('agent')).toBe('Running agent');
    });

    it('does NOT map Claude Code tool names', () => {
      expect(provider.toolVerb('Bash')).toBeUndefined();
      expect(provider.toolVerb('Read')).toBeUndefined();
      expect(provider.toolVerb('Write')).toBeUndefined();
      expect(provider.toolVerb('Edit')).toBeUndefined();
      expect(provider.toolVerb('Glob')).toBeUndefined();
      expect(provider.toolVerb('Grep')).toBeUndefined();
    });

    it('does NOT map other orchestrator tool names', () => {
      expect(provider.toolVerb('bash')).toBeUndefined();
      expect(provider.toolVerb('write')).toBeUndefined();
      expect(provider.toolVerb('glob')).toBeUndefined();
      expect(provider.toolVerb('grep')).toBeUndefined();
    });

    it('returns undefined for unknown tool', () => {
      expect(provider.toolVerb('unknown')).toBeUndefined();
    });
  });

  describe('buildMcpArgs', () => {
    const mockServerDef = {
      type: 'stdio',
      command: 'node',
      args: ['/mock/bridge.js'],
      env: { CLUBHOUSE_MCP_PORT: '12345', CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_HOOK_NONCE: 'nonce-1' },
    };

    it('returns --additional-mcp-config with JSON containing clubhouse server def', () => {
      const args = provider.buildMcpArgs(mockServerDef);
      expect(args).toHaveLength(2);
      expect(args[0]).toBe('--additional-mcp-config');

      const config = JSON.parse(args[1]);
      expect(config.mcpServers.clubhouse).toBeDefined();
      expect(config.mcpServers.clubhouse.type).toBe('stdio');
      expect(config.mcpServers.clubhouse.command).toBe('node');
      expect(config.mcpServers.clubhouse.env.CLUBHOUSE_MCP_PORT).toBe('12345');
      expect(config.mcpServers.clubhouse.env.CLUBHOUSE_AGENT_ID).toBe('agent-1');
      expect(config.mcpServers.clubhouse.env.CLUBHOUSE_HOOK_NONCE).toBe('nonce-1');
    });

    it('produces valid JSON that can be parsed', () => {
      const args = provider.buildMcpArgs(mockServerDef);
      expect(() => JSON.parse(args[1])).not.toThrow();
    });
  });

  describe('SessionCapable', () => {
    /** Normalize path separators for cross-platform test matching */
    const norm = (p: string | fs.PathLike) => String(p).replace(/\\/g, '/');

    describe('listSessions', () => {
      it('returns empty array when session directory does not exist', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        const sessions = await provider.listSessions('/project');
        expect(sessions).toEqual([]);
      });

      it('discovers JSONL session files in session-state directory', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          return norm(p).endsWith('/session-state');
        });
        vi.mocked(fsp.readdir).mockImplementation(async (dir: any) => {
          const d = String(dir);
          if (norm(d).endsWith('/session-state')) {
            return [
              { name: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl', isFile: () => true, isDirectory: () => false },
              { name: 'f9e8d7c6-b5a4-3210-fedc-ba9876543210.json', isFile: () => true, isDirectory: () => false },
            ] as any;
          }
          return [];
        });
        vi.mocked(fsp.stat).mockResolvedValue({
          birthtime: new Date('2026-04-01T10:00:00Z'),
          mtime: new Date('2026-04-01T12:00:00Z'),
        } as any);

        const sessions = await provider.listSessions('/project');
        expect(sessions).toHaveLength(2);
        expect(sessions[0].sessionId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        expect(sessions[1].sessionId).toBe('f9e8d7c6-b5a4-3210-fedc-ba9876543210');
      });

      it('skips non-UUID filenames like config files', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          return norm(p).endsWith('/session-state');
        });
        vi.mocked(fsp.readdir).mockImplementation(async (dir: any) => {
          if (String(dir).endsWith('session-state')) {
            return [
              { name: 'config.json', isFile: () => true, isDirectory: () => false },
              { name: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl', isFile: () => true, isDirectory: () => false },
            ] as any;
          }
          return [];
        });
        vi.mocked(fsp.stat).mockResolvedValue({
          birthtime: new Date('2026-04-01T10:00:00Z'),
          mtime: new Date('2026-04-01T12:00:00Z'),
        } as any);

        const sessions = await provider.listSessions('/project');
        expect(sessions).toHaveLength(1);
        expect(sessions[0].sessionId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      });

      it('sorts sessions by most recently active first', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          return norm(p).endsWith('/session-state');
        });
        vi.mocked(fsp.readdir).mockImplementation(async (dir: any) => {
          if (String(dir).endsWith('session-state')) {
            return [
              { name: 'aaaa1111-0000-0000-0000-000000000001.jsonl', isFile: () => true, isDirectory: () => false },
              { name: 'bbbb2222-0000-0000-0000-000000000002.jsonl', isFile: () => true, isDirectory: () => false },
            ] as any;
          }
          return [];
        });
        let callCount = 0;
        vi.mocked(fsp.stat).mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { birthtime: new Date('2026-04-01T08:00:00Z'), mtime: new Date('2026-04-01T09:00:00Z') } as any;
          }
          return { birthtime: new Date('2026-04-02T08:00:00Z'), mtime: new Date('2026-04-02T15:00:00Z') } as any;
        });

        const sessions = await provider.listSessions('/project');
        expect(sessions).toHaveLength(2);
        // Most recently active first
        expect(sessions[0].sessionId).toBe('bbbb2222-0000-0000-0000-000000000002');
        expect(sessions[1].sessionId).toBe('aaaa1111-0000-0000-0000-000000000001');
      });

      it('deduplicates sessions found in multiple directories', async () => {
        const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          return norm(p).endsWith('/session-state');
        });
        vi.mocked(fsp.readdir).mockImplementation(async (dir: any) => {
          const d = String(dir);
          if (norm(d).endsWith('/session-state')) {
            return [
              { name: `${sessionId}.jsonl`, isFile: () => true, isDirectory: () => false },
              { name: 'project-subdir', isFile: () => false, isDirectory: () => true },
            ] as any;
          }
          if (norm(d).endsWith('/project-subdir')) {
            return [
              { name: `${sessionId}.jsonl`, isFile: () => true, isDirectory: () => false },
            ] as any;
          }
          return [];
        });
        vi.mocked(fsp.stat).mockResolvedValue({
          birthtime: new Date('2026-04-01T10:00:00Z'),
          mtime: new Date('2026-04-01T12:00:00Z'),
        } as any);

        const sessions = await provider.listSessions('/project');
        expect(sessions).toHaveLength(1);
      });

      it('uses custom config dir from profileEnv', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          return norm(p) === '/custom-copilot/session-state';
        });
        vi.mocked(fsp.readdir).mockResolvedValue([]);

        await provider.listSessions('/project', { GH_COPILOT_CONFIG_DIR: '/custom-copilot' });
        // Should have checked the custom path, not ~/.copilot
        // Use path.join for cross-platform: Windows produces backslash paths
        expect(fs.existsSync).toHaveBeenCalledWith(path.join('/custom-copilot', 'session-state'));
      });
    });

    describe('readSessionTranscript', () => {
      it('returns null when session directory does not exist', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        const result = await provider.readSessionTranscript('some-id', '/project');
        expect(result).toBeNull();
      });

      it('reads and parses JSONL session file', async () => {
        const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          const s = norm(p);
          return s.endsWith('/session-state') || s.endsWith(`${sessionId}.jsonl`);
        });
        vi.mocked(fsp.readdir).mockResolvedValue([]);
        vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
          if (String(p).endsWith('.jsonl')) {
            return '{"type":"assistant","content_block":{"type":"text","text":"Hello"}}\n{"type":"result","result":"done"}\n';
          }
          throw new Error('ENOENT');
        });

        const events = await provider.readSessionTranscript(sessionId, '/project');
        expect(events).not.toBeNull();
        expect(events).toHaveLength(2);
        expect(events![0].type).toBe('assistant');
        expect(events![1].type).toBe('result');
      });

      it('skips malformed JSONL lines gracefully', async () => {
        const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          const s = norm(p);
          return s.endsWith('/session-state') || s.endsWith(`${sessionId}.jsonl`);
        });
        vi.mocked(fsp.readdir).mockResolvedValue([]);
        vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
          if (String(p).endsWith('.jsonl')) {
            return '{"type":"assistant"}\nINVALID JSON LINE\n{"type":"result"}\n';
          }
          throw new Error('ENOENT');
        });

        const events = await provider.readSessionTranscript(sessionId, '/project');
        expect(events).not.toBeNull();
        expect(events).toHaveLength(2);
      });

      it('returns null when no session file found', async () => {
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          return norm(p).endsWith('/session-state');
        });
        vi.mocked(fsp.readdir).mockResolvedValue([]);

        const result = await provider.readSessionTranscript('nonexistent-id', '/project');
        expect(result).toBeNull();
      });

      it('returns null for empty session file', async () => {
        const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          const s = norm(p);
          return s.endsWith('/session-state') || s.endsWith(`${sessionId}.jsonl`);
        });
        vi.mocked(fsp.readdir).mockResolvedValue([]);
        vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
          if (String(p).endsWith('.jsonl')) return '\n\n';
          throw new Error('ENOENT');
        });

        const events = await provider.readSessionTranscript(sessionId, '/project');
        expect(events).toBeNull();
      });

      it('checks directory-style sessions when no file match', async () => {
        const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
          const s = norm(p);
          return s.endsWith('/session-state') || s.endsWith(sessionId);
        });
        vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
        vi.mocked(fsp.readdir).mockImplementation(async (dir: any) => {
          const d = String(dir);
          if (norm(d).endsWith(sessionId)) {
            return ['transcript.jsonl'] as any;
          }
          return [];
        });
        vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
          if (String(p).endsWith('transcript.jsonl')) {
            return '{"type":"assistant","content_block":{"type":"text","text":"Hi"}}\n';
          }
          throw new Error('ENOENT');
        });

        const events = await provider.readSessionTranscript(sessionId, '/project');
        expect(events).not.toBeNull();
        expect(events).toHaveLength(1);
      });
    });

    describe('extractSessionId', () => {
      it('extracts UUID from "session: <uuid>" pattern', () => {
        const id = provider.extractSessionId('Starting session: a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        expect(id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      });

      it('extracts UUID from "conversation: <uuid>" pattern', () => {
        const id = provider.extractSessionId('conversation: f9e8d7c6-b5a4-3210-fedc-ba9876543210');
        expect(id).toBe('f9e8d7c6-b5a4-3210-fedc-ba9876543210');
      });

      it('extracts UUID from "thread: <uuid>" pattern', () => {
        const id = provider.extractSessionId('Active thread: 12345678-1234-1234-1234-123456789abc');
        expect(id).toBe('12345678-1234-1234-1234-123456789abc');
      });

      it('extracts UUID from "resume: <uuid>" pattern', () => {
        const id = provider.extractSessionId('Resuming resume: a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        expect(id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      });

      it('extracts UUID from "continuing: <uuid>" pattern', () => {
        const id = provider.extractSessionId('continuing: a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        expect(id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      });

      it('returns null when no session ID found', () => {
        expect(provider.extractSessionId('Welcome to Copilot CLI')).toBeNull();
      });

      it('returns null for empty string', () => {
        expect(provider.extractSessionId('')).toBeNull();
      });

      it('is case-insensitive', () => {
        const id = provider.extractSessionId('SESSION: A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
        expect(id).toBe('A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
      });
    });
  });

});
