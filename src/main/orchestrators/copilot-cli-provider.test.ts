import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('./shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared')>();
  return {
    ...actual,
    findBinaryInPath: vi.fn(() => '/usr/local/bin/copilot'),
    homePath: vi.fn((...segments: string[]) => `/home/user/${segments.join('/')}`),
    humanizeModelId: vi.fn((id: string) => id),
    validateHookUrl: vi.fn((url: string) => url),
    parseModelChoicesFromHelp: vi.fn(() => null),
    resolveEncodedPathDir: vi.fn(() => null),
    // buildHookCurlCommand, mergeHookEntries, and parseJsonlFile use real implementations
  };
});

vi.mock('../services/config-pipeline', () => ({
  isClubhouseHookEntry: vi.fn(() => false),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./copilot-session-store', () => ({
  listCopilotSessions: vi.fn(async () => []),
  findCopilotRunSession: vi.fn(async () => null),
  hasCopilotSession: vi.fn(async () => undefined),
  copilotSessionInCwd: vi.fn(async () => undefined),
  findCopilotTranscript: vi.fn(async () => null),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import type { TranscriptReadStats } from './types';
import * as childProcess from 'child_process';
import { getShellEnvironment } from '../util/shell';
import { CopilotCliProvider } from './copilot-cli-provider';
import { copilotSessionInCwd, findCopilotRunSession, findCopilotTranscript, hasCopilotSession, listCopilotSessions } from './copilot-session-store';
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

    it('adds --allow-all-tools when permissionMode is skip-all', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        permissionMode: 'skip-all',
      });
      expect(result.args).toContain('--allow-all-tools');
    });

    it('does not add --allow-all-tools when permissionMode is undefined', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(result.args).not.toContain('--allow-all-tools');
    });

    it('does not add --allow-all-tools for other permissionMode values', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        permissionMode: 'prompt' as any,
      });
      expect(result.args).not.toContain('--allow-all-tools');
    });

    it('combines freeAgentMode and permissionMode skip-all', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        freeAgentMode: true,
        permissionMode: 'skip-all',
      });
      expect(result.args).toContain('--yolo');
      expect(result.args).toContain('--autopilot');
      expect(result.args).toContain('--allow-all-tools');
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

    // Session resume. Copilot CLI cannot resume in prompt mode (-p), so the
    // provider only appends resume flags for interactive (no mission/systemPrompt)
    // spawns. This guard (copilot-cli-provider.ts:157) was previously untested and
    // is the highest-risk silent-failure path in the provider.
    it('adds --continue when resume is set without a sessionId', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', resume: true });
      expect(result.args).toContain('--continue');
      expect(result.args).not.toContain('--resume');
    });

    it('adds --resume <sessionId> when resume is set with a sessionId', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        resume: true,
        sessionId: 'sess-123',
      });
      expect(result.args).toContain('--resume');
      expect(result.args[result.args.indexOf('--resume') + 1]).toBe('sess-123');
      expect(result.args).not.toContain('--continue');
    });

    it('does not add resume flags when resume is false', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        resume: false,
        sessionId: 'sess-123',
      });
      expect(result.args).not.toContain('--resume');
      expect(result.args).not.toContain('--continue');
    });

    it('suppresses resume flags when a mission is set (prompt mode cannot resume)', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        resume: true,
        sessionId: 'sess-123',
        mission: 'Fix the bug',
      });
      expect(result.args).not.toContain('--resume');
      expect(result.args).not.toContain('--continue');
      // Mission is still passed through prompt mode.
      expect(result.args).toContain('-p');
    });

    // #2074: the resume queue sends no mission, so a resumed session gets no new prompt
    it('a resumed interactive spawn without a mission has no -i or -p', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', resume: true, sessionId: 'sess-123', interactive: true });
      expect(result.args[result.args.indexOf('--resume') + 1]).toBe('sess-123');
      expect(result.args).not.toContain('-i');
      expect(result.args).not.toContain('-p');
    });

    // A durable agent woken with a first message (#2019): -i runs the prompt and
    // stays interactive, so the resumed session survives the task.
    it('keeps --resume and uses -i when an interactive (durable) spawn has a mission', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        resume: true,
        sessionId: 'sess-123',
        mission: 'Fix the bug',
        interactive: true,
      });
      expect(result.args[result.args.indexOf('--resume') + 1]).toBe('sess-123');
      expect(result.args[result.args.indexOf('-i') + 1]).toBe('Fix the bug');
      expect(result.args).not.toContain('-p');
    });

    it('uses --continue with -i when an interactive spawn resumes the latest session', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', resume: true, mission: 'Go', interactive: true });
      expect(result.args).toContain('--continue');
      expect(result.args).toContain('-i');
    });

    it('a fresh interactive spawn with a mission uses -i and no resume flags', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', mission: 'Go', interactive: true });
      expect(result.args).toEqual(expect.arrayContaining(['-i', 'Go']));
      expect(result.args).not.toContain('--resume');
      expect(result.args).not.toContain('--continue');
    });

    describe('--session-id for a fresh durable session (#2156)', () => {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const helpWith = (text: string) => vi.mocked(childProcess.execFile).mockReturnValue({ stdout: text } as never);
      afterEach(() => { vi.mocked(childProcess.execFile).mockReset(); });

      it('names a fresh interactive session and returns its id when the CLI supports the flag', async () => {
        helpWith('  --session-id <id>   Resume an existing session or task by ID, or set the UUID for a new session');
        const result = await provider.buildSpawnCommand({ cwd: '/project', mission: 'Go', interactive: true });
        expect(result.sessionId).toMatch(UUID_RE);
        const i = result.args.indexOf('--session-id');
        expect(result.args[i + 1]).toBe(result.sessionId);
      });

      it('gives each fresh spawn its own id and reads --help only once', async () => {
        helpWith('--session-id <id>');
        const a = await provider.buildSpawnCommand({ cwd: '/project', interactive: true });
        const b = await provider.buildSpawnCommand({ cwd: '/project', interactive: true });
        expect(a.sessionId).not.toBe(b.sessionId);
        expect(vi.mocked(childProcess.execFile).mock.calls.filter((c) => (c[1] as string[])?.[0] === '--help')).toHaveLength(1);
      });

      it('leaves the flag off for an older CLI without it', async () => {
        helpWith('  --resume [<value>]  Resume from a previous session');
        const result = await provider.buildSpawnCommand({ cwd: '/project', interactive: true });
        expect(result.args).not.toContain('--session-id');
        expect(result.sessionId).toBeUndefined();
      });

      it('leaves the flag off when --help can\'t be run', async () => {
        vi.mocked(childProcess.execFile).mockImplementation(() => { throw new Error('ENOENT'); });
        const result = await provider.buildSpawnCommand({ cwd: '/project', interactive: true });
        expect(result.args).not.toContain('--session-id');
      });

      it('never names a resumed or non-interactive session', async () => {
        helpWith('--session-id <id>');
        const resumed = await provider.buildSpawnCommand({ cwd: '/project', resume: true, sessionId: 'abc', interactive: true });
        expect(resumed.args).not.toContain('--session-id');
        expect(resumed.sessionId).toBeUndefined();
        const latest = await provider.buildSpawnCommand({ cwd: '/project', resume: true, interactive: true });
        expect(latest.args).not.toContain('--session-id');
        const quick = await provider.buildSpawnCommand({ cwd: '/project', mission: 'Go' });
        expect(quick.args).not.toContain('--session-id');
        expect(quick.sessionId).toBeUndefined();
      });
    });

    it('suppresses resume flags when a systemPrompt is set (prompt mode cannot resume)', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        resume: true,
        systemPrompt: 'You are helpful',
      });
      expect(result.args).not.toContain('--resume');
      expect(result.args).not.toContain('--continue');
      expect(result.args).toContain('-p');
    });
  });

  describe('buildAgentFileArgs (AgentFileCapable)', () => {
    it('returns empty array when neither field is set', () => {
      expect(provider.buildAgentFileArgs({})).toEqual([]);
    });

    it('returns only --agent pair when only agentFile is set', () => {
      expect(provider.buildAgentFileArgs({ agentFile: 'k8s-assistant' }))
        .toEqual(['--agent', 'k8s-assistant']);
    });

    it('returns only --source pair when only agentSource is set', () => {
      expect(provider.buildAgentFileArgs({ agentSource: '/abs/agents' }))
        .toEqual(['--source', '/abs/agents']);
    });

    it('returns --agent before --source when both are set', () => {
      expect(provider.buildAgentFileArgs({
        agentFile: 'k8s-assistant',
        agentSource: '/abs/agents',
      })).toEqual(['--agent', 'k8s-assistant', '--source', '/abs/agents']);
    });

    it('does not perform tilde expansion (caller is responsible for path normalization)', () => {
      // Tilde expansion lives in agent-system.ts; the provider must pass through
      // its input verbatim so the test layer can detect missing expansion upstream.
      expect(provider.buildAgentFileArgs({ agentSource: '~/.copilot/agents' }))
        .toEqual(['--source', '~/.copilot/agents']);
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

    // NF-001 regression: sessionEnd must be registered so GHCP agents signal "stopped"
    it('NF-001: includes sessionEnd hook with 5s timeout', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.hooks.sessionEnd).toBeDefined();
      expect(written.hooks.sessionEnd[0].type).toBe('command');
      expect(written.hooks.sessionEnd[0].timeoutSec).toBe(5);
    });

    it('writes all 7 hook events', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      const hookKeys = Object.keys(written.hooks);
      expect(hookKeys).toContain('preToolUse');
      expect(hookKeys).toContain('postToolUse');
      expect(hookKeys).toContain('errorOccurred');
      expect(hookKeys).toContain('permissionRequest');
      expect(hookKeys).toContain('sessionStart');
      expect(hookKeys).toContain('sessionEnd');
      expect(hookKeys).toContain('userPromptSubmitted');
      expect(hookKeys).toHaveLength(7);
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

  describe('buildHeadlessCommand — session resume', () => {
    it('continues the most recent session when resume is requested', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'carry on', resume: true,
      }))!;
      expect(args).toContain('--continue');
    });

    it('adds no resume flag for a fresh run', async () => {
      const { args } = (await provider.buildHeadlessCommand({ cwd: '/p', mission: 'start' }))!;
      expect(args).not.toContain('--continue');
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

    // Parity gap (Mission 2c): unlike the Claude Code provider, GHCP's headless
    // path hard-codes blanket --allow-all and ignores fine-grained permission /
    // tool-filtering options. These tests lock in the current behavior so any
    // future change to close the gap is a deliberate, reviewed decision rather
    // than a silent regression.
    it('ignores permissionMode and always uses blanket --allow-all in headless', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        permissionMode: 'skip-all',
      });
      expect(result!.args).toContain('--allow-all');
      // permissionMode does not change the headless flag set.
      expect(result!.args).not.toContain('--allow-all-tools');
    });

    it('does not emit --allow-tool for allowedTools in headless (blanket allow-all)', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        allowedTools: ['read', 'edit'],
      });
      expect(result!.args).not.toContain('--allow-tool');
      expect(result!.args).toContain('--allow-all');
    });

    it('does not emit --disallowedTools for disallowedTools in headless (parity gap vs Claude Code)', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        disallowedTools: ['shell'],
      } as Parameters<typeof provider.buildHeadlessCommand>[0]);
      expect(result!.args).not.toContain('--disallowedTools');
      expect(result!.args).not.toContain('--disallow-tool');
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
      env: { CLUBHOUSE_MCP_PORT: '12345', CLUBHOUSE_AGENT_ID: 'agent-1' },
      env_vars: ['CLUBHOUSE_HOOK_NONCE'],
    };

    it('returns --additional-mcp-config with JSON containing clubhouse server def', () => {
      const args = provider.buildMcpArgs({ clubhouse: mockServerDef });
      expect(args).toHaveLength(2);
      expect(args[0]).toBe('--additional-mcp-config');

      const config = JSON.parse(args[1]);
      expect(config.mcpServers.clubhouse).toBeDefined();
      expect(config.mcpServers.clubhouse.type).toBe('stdio');
      expect(config.mcpServers.clubhouse.command).toBe('node');
      expect(config.mcpServers.clubhouse.env.CLUBHOUSE_MCP_PORT).toBe('12345');
      expect(config.mcpServers.clubhouse.env.CLUBHOUSE_AGENT_ID).toBe('agent-1');
      // Copilot passes its whole env to stdio servers: the bridge inherits the
      // nonce, so none appears in argv (#2222).
      expect(config.mcpServers.clubhouse.env).not.toHaveProperty('CLUBHOUSE_HOOK_NONCE');
      expect(args[1]).not.toMatch(/CLUBHOUSE_HOOK_NONCE"\s*:/);
    });

    it('produces valid JSON that can be parsed', () => {
      const args = provider.buildMcpArgs({ clubhouse: mockServerDef });
      expect(() => JSON.parse(args[1])).not.toThrow();
    });
    it('includes every configured server, not just clubhouse', () => {
      const args = provider.buildMcpArgs({
        clubhouse: { command: 'node', args: ['/bridge.js'] },
        linear: { command: 'npx', args: ['-y', 'linear-mcp'] },
      });
      const config = JSON.parse(args[args.indexOf('--additional-mcp-config') + 1]);
      expect(Object.keys(config.mcpServers).sort()).toEqual(['clubhouse', 'linear']);
    });

    it('emits no flag at all for an empty server set', () => {
      expect(provider.buildMcpArgs({})).toEqual([]);
    });
  });

  describe('SessionCapable', () => {
    // The store itself is tested against real fixture directories in copilot-session-store.test.ts.
    describe('session store (listSessions, findRunSession, hasSession)', () => {
      const store = path.join('/home/user/.copilot', 'session-state');
      const custom = path.join('/custom-copilot', 'session-state');

      it('lists sessions for the cwd from ~/.copilot/session-state', async () => {
        vi.mocked(listCopilotSessions).mockResolvedValue([{ sessionId: 'x', startedAt: 'a', lastActiveAt: 'b' }]);
        expect(await provider.listSessions('/project')).toEqual([{ sessionId: 'x', startedAt: 'a', lastActiveAt: 'b' }]);
        expect(listCopilotSessions).toHaveBeenCalledWith(store, '/project');
      });

      it('returns [] when the store read throws', async () => {
        vi.mocked(listCopilotSessions).mockRejectedValue(new Error('EACCES'));
        expect(await provider.listSessions('/project')).toEqual([]);
      });

      it('finds a terminal run\'s session in the store, honoring the profile\'s COPILOT_HOME', async () => {
        vi.mocked(findCopilotRunSession).mockResolvedValue('real-id');
        const run = { cwd: '/wt', startedAt: 1, endedAt: 2, resumedId: 'r', profileEnv: { COPILOT_HOME: '/custom-copilot' } };
        expect(await provider.findRunSession(run)).toBe('real-id');
        expect(findCopilotRunSession).toHaveBeenCalledWith(custom, run);
      });

      describe('COPILOT_HOME', () => {
        const saved = process.env.COPILOT_HOME;
        beforeEach(() => { delete process.env.COPILOT_HOME; });
        afterEach(() => {
          if (saved === undefined) delete process.env.COPILOT_HOME;
          else process.env.COPILOT_HOME = saved;
          vi.mocked(getShellEnvironment).mockReturnValue({ PATH: '/usr/bin' });
        });

        it('comes from the login shell when the profile has none', async () => {
          vi.mocked(getShellEnvironment).mockReturnValue({ PATH: '/usr/bin', COPILOT_HOME: '/shell-copilot' });
          await provider.hasSession('id');
          expect(hasCopilotSession).toHaveBeenCalledWith(path.join('/shell-copilot', 'session-state'), 'id');
        });

        it('comes from Clubhouse\'s own environment last', async () => {
          process.env.COPILOT_HOME = '/proc-copilot';
          await provider.hasSession('id');
          expect(hasCopilotSession).toHaveBeenCalledWith(path.join('/proc-copilot', 'session-state'), 'id');
        });

        it('prefers the profile over the shell and process env', async () => {
          process.env.COPILOT_HOME = '/proc-copilot';
          vi.mocked(getShellEnvironment).mockReturnValue({ COPILOT_HOME: '/shell-copilot' });
          await provider.listSessions('/wt', { COPILOT_HOME: '/custom-copilot' });
          expect(listCopilotSessions).toHaveBeenCalledWith(custom, '/wt');
        });

        it('expands a leading ~', async () => {
          await provider.hasSession('id', { COPILOT_HOME: '~/alt' });
          expect(hasCopilotSession).toHaveBeenCalledWith(path.join('/home/user/alt', 'session-state'), 'id');
        });

        it('ignores the undocumented GH_COPILOT_CONFIG_DIR', async () => {
          await provider.hasSession('id', { GH_COPILOT_CONFIG_DIR: '/custom-copilot' });
          expect(hasCopilotSession).toHaveBeenCalledWith(store, 'id');
        });
      });

      it('checks a scraped id against the agent\'s cwd', async () => {
        vi.mocked(copilotSessionInCwd).mockResolvedValue(false);
        expect(await provider.hasSessionForCwd('id', '/wt', { COPILOT_HOME: '/custom-copilot' })).toBe(false);
        expect(copilotSessionInCwd).toHaveBeenCalledWith(custom, 'id', '/wt');
      });

      it('checks a saved id against the store', async () => {
        vi.mocked(hasCopilotSession).mockResolvedValue(false);
        expect(await provider.hasSession('a27ef93a-2030-45fd-943e-6e07ac0a811c')).toBe(false);
        expect(hasCopilotSession).toHaveBeenCalledWith(store, 'a27ef93a-2030-45fd-943e-6e07ac0a811c');
      });
    });

    describe('readSessionTranscript', () => {
      const store = path.join('/home/user/.copilot', 'session-state');
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const file = path.join(store, sessionId, 'events.jsonl');
      const readsAs = (text: string) => vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
        if (String(p) === file) return text;
        throw new Error('ENOENT');
      });

      it('looks the session up by id in <COPILOT_HOME>/session-state (#2277)', async () => {
        vi.mocked(findCopilotTranscript).mockResolvedValue(null);
        expect(await provider.readSessionTranscript(sessionId, '/project')).toBeNull();
        expect(findCopilotTranscript).toHaveBeenCalledWith(store, sessionId, '/project', expect.anything());
        expect(fsp.readdir).not.toHaveBeenCalled();
        expect(fs.existsSync).not.toHaveBeenCalled();
      });

      it('reads and parses the JSONL transcript', async () => {
        vi.mocked(findCopilotTranscript).mockResolvedValue(file);
        readsAs('{"type":"assistant","content_block":{"type":"text","text":"Hello"}}\n{"type":"result","result":"done"}\n');
        const events = await provider.readSessionTranscript(sessionId, '/project');
        expect(events).toHaveLength(2);
        expect(events![0].type).toBe('assistant');
        expect(events![1].type).toBe('result');
      });

      it('skips malformed JSONL lines gracefully', async () => {
        vi.mocked(findCopilotTranscript).mockResolvedValue(file);
        readsAs('{"type":"assistant"}\nINVALID JSON LINE\n{"type":"result"}\n');
        expect(await provider.readSessionTranscript(sessionId, '/project')).toHaveLength(2);
      });

      it('returns null for an empty session file', async () => {
        vi.mocked(findCopilotTranscript).mockResolvedValue(file);
        readsAs('\n\n');
        expect(await provider.readSessionTranscript(sessionId, '/project')).toBeNull();
      });

      it('fills in lookup stats: probes and timings, no paths', async () => {
        vi.mocked(findCopilotTranscript).mockImplementation(async (_d, _id, _cwd, counter) => {
          counter!.probes += 3;
          return file;
        });
        readsAs('{"type":"result"}\n');
        const stats: TranscriptReadStats = {};
        await provider.readSessionTranscript(sessionId, '/project', undefined, { stats });
        expect(stats).toMatchObject({ probes: 3, found: true, bytesRead: 18 });
        expect(typeof stats.lookupMs).toBe('number');
        expect(typeof stats.readMs).toBe('number');
        expect(JSON.stringify(stats)).not.toContain(sessionId);
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
