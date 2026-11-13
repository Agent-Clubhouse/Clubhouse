/**
 * The prepare-handoff skill (#3344), followed step by step by a scripted agent
 * through the real handoff tools on a fixture repository: the live host,
 * preflight and preparation, with fake peers and no model. It proves the
 * skill's instructions produce a valid offer, and that every tool it names exists.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolResult } from './clubhouse-mcp/types';

const state = vi.hoisted(() => ({
  dir: '', sender: '', receiver: '', machine: Array(16).fill('ab').join(':'), peer: Array(16).fill('cd').join(':'),
  handlers: new Map<string, (agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>>(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: state.machine }), getOrCreateIdentity: () => ({ fingerprint: state.machine }) }));
vi.mock('./annex-settings', () => ({ getSettings: () => ({ alias: 'this-computer', enableServer: true, networkEnabled: true, acceptHandoffs: true }), networkEnabled: () => true }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: state.peer, alias: 'machine-b', role: 'member', kind: 'desktop' }] }));
vi.mock('./annex-client', () => ({ getSatellite: () => undefined, isMachineConnected: () => true, postToMachine: vi.fn(), onSatelliteConnected: () => () => {} }));
vi.mock('./annex-agent-calls', () => ({ isNetworkComputer: () => true }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => ({ isRunning: () => false, sendMessage: vi.fn(async () => ({})) }) }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async (project: string) => project === state.sender ? [{ id: 'sender', name: 'Sender' }] : [{ id: 'receiver', name: 'Receiver' }] }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'source-project', name: 'example-project', path: state.sender }, { id: 'destination-project', name: 'Destination', path: state.receiver }] }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({ enabled: true, agentId: 'dispatcher', path: state.dir, config: { name: 'Dispatcher' } }), isDispatcherAgentId: (id: string) => id === 'dispatcher' }));
vi.mock('./agent-grants-service', () => ({ effectiveAgentGrants: async () => [{ action: 'handoff.offer', target: { kind: 'any' }, mode: 'allow' }, { action: 'handoff.accept', target: { kind: 'any' }, mode: 'allow' }] }));
vi.mock('./connection-grants-store', () => ({ getConnectionDirection: () => ({ link: true }) }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [], getBindingsForAgent: () => [] } }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ callerGrants: () => [] }));
vi.mock('./clubhouse-mcp/tool-registry', () => ({
  callTool: vi.fn(), setHandoffParticipantCheck: vi.fn(),
  registerGlobalTool: (name: string, _definition: unknown, handler: (agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>) => { state.handlers.set(name, handler); },
}));
vi.mock('./clubhouse-mcp/arg-targets', () => ({ setHandoffGrantTargetResolver: vi.fn() }));
vi.mock('./clubhouse-mcp/ask-first', () => ({ describeCallsForAsk: vi.fn() }));
vi.mock('./clubhouse-mcp/handoff-permissions', async (original) => ({
  ...await original<typeof import('./clubhouse-mcp/handoff-permissions')>(),
  // The person allowed this agent to offer: the call runs, as it would after Allow.
  withHandoffAgreementCall: (_call: unknown, work: () => Promise<unknown>) => work(),
  handoffAgreementCallApproved: async () => true,
}));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ defaultHelperTemplateId: async () => 'person-helper-template' }) }));
vi.mock('./clubhouse-mcp/tools/agent-lifecycle', () => ({ wakeWiredAgent: vi.fn() }));

import { registerHandoffTools } from './clubhouse-mcp/tools/handoff-tools';
import { registerHandoffCapacityTools } from './clubhouse-mcp/tools/handoff-capacity-tools';
import { handoffHost, stopHandoffs } from './handoff-host';
import { _resetHandoffPreparationsForTesting } from './handoff-preparations';
import { PREPARE_HANDOFF_SKILL_MD } from './managed-agents/app-skills/prepare-handoff';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
const call = async (name: string, args: Record<string, unknown>) => {
  const handler = state.handlers.get(name);
  if (!handler) throw new Error(`The skill names ${name}, which is not a registered tool`);
  const result = await handler('sender', args);
  const raw = result.content[0]?.text ?? '';
  return { result, body: raw.startsWith('{') ? JSON.parse(raw) : raw };
};

beforeEach(async () => {
  state.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-handoff-skill-')));
  state.sender = path.join(state.dir, 'example-project'); state.receiver = path.join(state.dir, 'destination');
  const config = path.join(state.dir, 'empty-config'); fs.writeFileSync(config, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  _resetHandoffPreparationsForTesting();
  state.handlers.clear();
  registerHandoffTools(); registerHandoffCapacityTools();
  fs.mkdirSync(state.sender); await git(state.sender, 'init', '-b', 'main');
  await git(state.sender, 'config', 'user.name', 'Fixture'); await git(state.sender, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(state.sender, 'cart.test.ts'), 'base'); fs.writeFileSync(path.join(state.sender, '.gitignore'), '.clubhouse/\nfixtures/\n');
  await git(state.sender, 'add', '.'); await git(state.sender, '-c', `core.hooksPath=${path.join(state.dir, 'no-hooks')}`, 'commit', '-qm', 'Base');
  await git(state.dir, 'clone', state.sender, state.receiver);
  await git(state.receiver, 'remote', 'remove', 'origin');
  // Work in progress: an uncommitted change, an ignored fixture the receiver needs, and a key file it must not get.
  fs.writeFileSync(path.join(state.sender, 'cart.test.ts'), 'discount cases');
  fs.mkdirSync(path.join(state.sender, 'fixtures')); fs.writeFileSync(path.join(state.sender, 'fixtures', 'orders.json'), '[]');
  fs.writeFileSync(path.join(state.sender, 'deploy.key'), 'not for the receiver');
});
afterEach(async () => { await stopHandoffs(); vi.unstubAllEnvs(); fs.rmSync(state.dir, { recursive: true, force: true }); });

describe('the prepare-handoff skill (#3344)', () => {
  it('names only registered tools, in the order a scripted agent follows', () => {
    const named = [...PREPARE_HANDOFF_SKILL_MD.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1])
      .filter((name) => /_handoff$|^probe_capacity$|^get_handoff$/.test(name));
    for (const name of new Set(named)) expect(state.handlers.has(name), name).toBe(true);
    const at = (name: string) => PREPARE_HANDOFF_SKILL_MD.indexOf(`\`${name}\``);
    expect(at('check_handoff')).toBeLessThan(at('prepare_handoff'));
    expect(at('prepare_handoff')).toBeLessThan(at('offer_handoff'));
    expect(at('offer_handoff')).toBeLessThan(at('get_handoff'));
  });

  it('followed step by step on a fixture repository, produces a valid offer bound to its preparation', async () => {
    // 1. The brief, with the skill's five parts and no secret value.
    const brief = ['Goal: checkout tests cover the discount rules.', 'Done: cart unit tests.', 'Remaining: the two discount cases.',
      'How to verify: npm test in example-project.', 'Open questions: none.'].join('\n');
    // 2. Uncommitted work, so worktree mode.
    const mode = 'worktree';
    // 3. Check, adding only the ignored fixture the receiver needs.
    const include = { ignored: ['fixtures/orders.json'] };
    const first = await call('check_handoff', { include });
    // 4. A secret-looking file blocks it: exclude it and check again, never copying its value.
    expect(first.body).toMatchObject({ ready: false, findings: [expect.objectContaining({ path: 'deploy.key' })] });
    expect(JSON.stringify(first.body)).not.toContain('not for the receiver');
    const exclude = ['deploy.key'];
    const second = await call('check_handoff', { include, exclude });
    expect(second.body).toMatchObject({ ready: true });
    expect(second.body.files.map((f: { path: string }) => f.path).sort()).toEqual(['cart.test.ts', 'fixtures/orders.json']);
    // 5. Prepare with the same choices, and keep the summary.
    const prepared = await call('prepare_handoff', { mode, include, exclude });
    expect(prepared.body).toMatchObject({ ready: true, summary: { fileCount: expect.any(Number), totalBytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    // 6. Optional capacity check is available.
    expect(state.handlers.has('probe_capacity')).toBe(true);
    // 7. Offer with the summary (never the full manifest), then follow up.
    const offered = await call('offer_handoff', { to: 'Receiver', task: 'Finish the checkout tests in example-project', brief, mode, manifest: prepared.body.summary });
    expect(offered.result.isError).not.toBe(true);
    expect(offered.body).toMatchObject({ id: expect.any(String), state: 'offered', mode, manifest: prepared.body.summary });
    const followed = await call('get_handoff', { id: offered.body.id });
    expect(followed.body).toMatchObject({ id: offered.body.id, state: 'offered' });
    expect(handoffHost().store.get(offered.body.id)?.task.brief).toBe(brief);
  }, 30_000);

  it('tells a too-big refusal apart from a secret finding, and a dirty branch from both', () => {
    const step4 = PREPARE_HANDOFF_SKILL_MD.slice(PREPARE_HANDOFF_SKILL_MD.indexOf('## 4.'), PREPARE_HANDOFF_SKILL_MD.indexOf('## 5.'));
    expect(step4).toMatch(/\*\*Too big\*\* \(`reason: bounds_exceeded`\): `largestFiles` and `bounds`/);
    expect(step4).toMatch(/\*\*Looks like a secret\*\* \(`findings`/);
    expect(PREPARE_HANDOFF_SKILL_MD).toContain('`uncommitted_branch`');
  });

  it('refuses the full manifest in place of the summary, as the skill warns', async () => {
    const prepared = await call('prepare_handoff', { mode: 'worktree', exclude: ['deploy.key'] });
    const offered = await call('offer_handoff', { to: 'Receiver', task: 'Continue', brief: 'Goal: continue.', mode: 'worktree', manifest: prepared.body.manifest });
    expect(offered.result.isError === true || offered.body?.ready === false).toBe(true);
  }, 30_000);
});
