import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  COPILOT_ACP_ARGS,
  COPILOT_PERMISSION_LEVELS,
  copilotNativeSessionExists,
  copilotSessionStateDir,
  COPILOT_ACP_PROFILE,
  copilotAcpCapabilities,
  copilotModeKind,
  copilotVersionStatus,
  dedupeCopilotConfigOptions,
  dedupeCopilotLegacyModels,
  filterCopilotUpdate,
  resolveCopilotAcpSpawn,
  selectAcpProfile,
} from './copilot-acp';
import { GENERIC_ACP_PROFILE } from './acp-session';
import { terminalLoginCommand } from './acp-capabilities';
import { loadAcpFixture } from './__fixtures__/acp/acp-replay';
import type { InitializeResponse, NewSessionResponse, SessionConfigSelect, SessionUpdate } from './acp-schema';

const recording = loadAcpFixture('copilot-cli', 'handshake-list-close.jsonl');
const init = recording.find((r) => r.dir === 'in' && r.msg.id === 1)!.msg.result as InitializeResponse;
const newSession = recording.find((r) => r.dir === 'in' && r.msg.id === 2)!.msg.result as NewSessionResponse;

describe('Copilot ACP launch', () => {
  it('launches ACP over stdio, running the same Copilot as Terminal (no --no-auto-update, #2154)', () => {
    expect(COPILOT_ACP_ARGS).toEqual(['--acp', '--stdio']);
  });

  it('appends launch-only flags after the ACP flags', () => {
    const cmd = resolveCopilotAcpSpawn({ binary: 'copilot', extraArgs: ['--deny-tool=shell(rm)'] });
    expect(cmd.binary).toBe('copilot');
    expect(cmd.args).toEqual(['--acp', '--stdio', '--deny-tool=shell(rm)']);
  });
});

describe('Copilot model-list dedupe', () => {
  it('collapses the recorded duplicate models, keeping the entry with cost metadata', () => {
    const model = newSession.configOptions!.find((o) => o.id === 'model') as SessionConfigSelect;
    const before = model.options as Array<{ value: string; _meta?: Record<string, unknown> | null }>;
    const uniqueValues = new Set(before.map((o) => o.value));
    expect(before.length).toBeGreaterThan(uniqueValues.size);

    const after = (dedupeCopilotConfigOptions([model])[0] as SessionConfigSelect).options as typeof before;
    expect(after.map((o) => o.value)).toEqual([...uniqueValues]);
    expect(after.find((o) => o.value === 'auto')?._meta).toMatchObject({ copilotUsage: '1x' });
  });

  it('dedupes the legacy models list the same way', () => {
    const models = newSession.models!;
    const deduped = dedupeCopilotLegacyModels(models);
    expect(deduped.availableModels.length).toBe(new Set(models.availableModels.map((m) => m.modelId)).size);
    expect(deduped.currentModelId).toBe(models.currentModelId);
  });

  it('dedupes inside option groups and leaves booleans alone', () => {
    const out = dedupeCopilotConfigOptions([
      {
        type: 'select', id: 'model', name: 'Model', currentValue: 'a',
        options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'a', name: 'A', _meta: { x: 1 } }] }],
      },
      { type: 'boolean', id: 'flag', name: 'Flag', currentValue: true },
    ]);
    const groups = (out[0] as SessionConfigSelect).options as Array<{ options: Array<{ _meta?: unknown }> }>;
    expect(groups[0].options).toEqual([{ value: 'a', name: 'A', _meta: { x: 1 } }]);
    expect(out[1]).toEqual({ type: 'boolean', id: 'flag', name: 'Flag', currentValue: true });
  });
});

describe('Copilot stray Info line', () => {
  const chunk = (text: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const open = { openToolCallIds: new Set(['call_1']) };
  const none = { openToolCallIds: new Set<string>() };

  it('drops an Info path chunk while a tool call is open', () => {
    expect(filterCopilotUpdate(chunk('Info: /workspace/project/hello.txt'), open)).toBeNull();
    expect(filterCopilotUpdate(chunk('Info: C:\\work\\hello.txt'), open)).toBeNull();
  });

  it('keeps it when no tool call is open, and keeps ordinary prose', () => {
    expect(filterCopilotUpdate(chunk('Info: /workspace/project/hello.txt'), none)).not.toBeNull();
    expect(filterCopilotUpdate(chunk('Info: the file was created'), open)).not.toBeNull();
  });
});

describe('Copilot capability record', () => {
  it('records what Copilot 1.0.92 does and does not support', () => {
    const caps = copilotAcpCapabilities(init);
    expect(caps).toMatchObject({
      profile: 'copilot',
      agent: { name: 'Copilot', version: '1.0.92' },
      resume: 'load',
      listSessions: true,
      listIsMachineWide: true,
      closeSession: true,
      deleteSession: false,
      steer: false,
      queue: 'client',
      rewind: false,
      planApproval: false,
      subagents: 'unverified',
      permissionOptionKinds: ['allow_once', 'allow_always', 'reject_once'],
      permissionRules: 'launch_only',
      usage: { context: true, turnTokens: true, cost: false },
      prompt: { image: true, audio: false, embeddedContext: true },
      mcp: { stdio: true, http: true, sse: true },
      login: 'terminal',
      clientFs: false,
    });
    expect(caps.quirks).toContain('model-list-duplicates');
    expect(caps.quirks).not.toContain('untested-version');
  });

  it('flags versions outside the tested range', () => {
    expect(copilotVersionStatus('1.0.92')).toBe('tested');
    expect(copilotVersionStatus('1.0.98')).toBe('tested');
    expect(copilotVersionStatus('1.0.100-0')).toBe('newer');
    expect(copilotVersionStatus('1.0.82')).toBe('tested');
    expect(copilotVersionStatus('1.0.40')).toBe('older');
    expect(copilotVersionStatus(undefined)).toBe('unknown');
    const caps = copilotAcpCapabilities({ ...init, agentInfo: { name: 'Copilot', version: '1.1.0' } });
    expect(caps.quirks).toContain('untested-version');
  });

  it('reads the terminal login command from the legacy _meta convention', () => {
    expect(terminalLoginCommand(init, 'copilot')).toEqual({
      command: '/usr/local/bin/copilot',
      args: ['login'],
      label: 'Copilot Login',
    });
  });
});

describe('Copilot helpers', () => {
  it('maps URI mode ids to mode kinds', () => {
    expect(copilotModeKind('https://agentclientprotocol.com/protocol/session-modes#plan')).toBe('plan');
    expect(copilotModeKind('https://agentclientprotocol.com/protocol/session-modes#autopilot')).toBe('autopilot');
    expect(copilotModeKind('custom')).toBeUndefined();
  });

  it('selects the Copilot profile only for Copilot', () => {
    expect(selectAcpProfile(init)).toBe(COPILOT_ACP_PROFILE);
    expect(selectAcpProfile({ protocolVersion: 1, agentInfo: { name: 'gemini-cli', version: '1.0.0' } })).toBe(GENERIC_ACP_PROFILE);
  });
});

describe('Copilot native session lookup (#2155)', () => {
  it('finds sessions under $COPILOT_HOME/session-state, defaulting to ~/.copilot', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    fs.mkdirSync(path.join(home, 'session-state', 'bc755b6e-1'), { recursive: true });
    expect(copilotSessionStateDir({ COPILOT_HOME: home })).toBe(path.join(home, 'session-state'));
    expect(copilotSessionStateDir({})).toBe(path.join(os.homedir(), '.copilot', 'session-state'));
    await expect(copilotNativeSessionExists('bc755b6e-1', { COPILOT_HOME: home })).resolves.toBe(true);
    await expect(copilotNativeSessionExists('a27ef93a-missing', { COPILOT_HOME: home })).resolves.toBe(false);
  });

  it('never uses an id that is not a plain token as a path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    fs.mkdirSync(path.join(home, 'outside'), { recursive: true });
    await expect(copilotNativeSessionExists(path.join('..', 'outside'), { COPILOT_HOME: path.join(home, 'x') })).resolves.toBe(false);
    await expect(copilotNativeSessionExists('', { COPILOT_HOME: home })).resolves.toBe(false);
  });
});

describe('Copilot level re-send', () => {
  function fakeSession(allowAll: string, mode: string) {
    const calls: string[] = [];
    const state = {
      modes: { currentModeId: `https://agentclientprotocol.com/protocol/session-modes#${mode}`, availableModes: [] as unknown[] },
      configOptions: [{ type: 'select', id: 'allow_all', name: 'Allow All', currentValue: allowAll, options: [] as unknown[] }],
    };
    const session = {
      getState: () => state,
      setConfigOption: vi.fn(async (id: string, value: string) => { calls.push(`${id}=${value}`); }),
      setMode: vi.fn(async (id: string) => { calls.push(`mode=${id.split('#')[1]}`); }),
    };
    return { session: session as unknown as Parameters<typeof COPILOT_PERMISSION_LEVELS.apply>[0], calls };
  }

  it('skips settings that already match on a fresh session', async () => {
    const { session, calls } = fakeSession('on', 'agent');
    await COPILOT_PERMISSION_LEVELS.apply(session, 'full_access');
    expect(calls).toEqual([]);
  });

  it('re-sends allow_all and mode after a resume, even when they report as set (#2155)', async () => {
    const { session, calls } = fakeSession('on', 'agent');
    await COPILOT_PERMISSION_LEVELS.apply(session, 'full_access', { force: true });
    expect(calls).toEqual(['allow_all=on', 'mode=agent']);
  });
});
