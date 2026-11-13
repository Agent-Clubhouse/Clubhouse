import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import { captureAuditEvents, type AuditCapture } from '../../telemetry/__test-utils__/audit-capture';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { restartWithReceipt, type ManagedRestartReceipt } from './activation-receipts';
import { managedActivationFor, skillDeclaredName } from './activation';
import type { ProviderSessionReport } from '../../../shared/chat/provider-inventory';
import { resolveManagedSetup, setupFingerprint } from './delivery';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';

let root: string, service: ManagedAgentsService, agent: DurableAgentConfig, capture: AuditCapture;
const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-activation-receipt-'));
  capture = captureAuditEvents();
  _resetSettingsAuditForTesting(true);
  agent = { id: 'target', name: 'Target', color: 'indigo', createdAt: '', orchestrator: 'copilot-cli',
    managed: { version: 1, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } };
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(path.join(root, 'managed')),
    listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
    setManagedSetup: async (_p, _id, setup) => { if (setup) agent.managed = setup; }, isRunning: () => true,
  });
  await service.ensureBuiltins();
});
afterEach(() => {
  capture.stop();
  _resetSettingsAuditForTesting(false);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('passive managed activation evidence (#2855)', () => {
  it('keeps configured, desired, materialized, running and provider confirmation separate', async () => {
    const before = await managedActivationFor({ service, agent, running: true, deliveryFailed: false });
    expect(before).toMatchObject({
      status: 'pending', configured: { managed: true }, desired: { parts: [{ id: CLUBHOUSE_MCP_PART_ID }] },
      materialized: { status: 'not_confirmed', matchesDesired: null }, running: { status: 'running', launchSetup: 'not_confirmed', matchesDesired: null },
      providerConfirmedLoaded: { skills: 'none_assigned', mcpTools: 'not_confirmed', instructions: 'not_confirmed', syntheticCheck: 'not_run' },
      verification: { status: 'blocked', reason: 'launch_not_recorded', attempts: 0 },
    });
    const materialized = { ...setupFingerprint(agent, await resolveManagedSetup(service, agent.managed!)), provider: 'copilot-cli' };
    const after = await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false });
    expect(after).toMatchObject({ status: 'partial', materialized: { status: 'recorded', matchesDesired: true }, running: { launchSetup: 'recorded_at_start' } });
    expect(after.providerConfirmedLoaded).toEqual(before.providerConfirmedLoaded);
    const part = await user(() => service.createPart({ name: 'New server', content: { kind: 'mcp', serverKey: 'new-server', transport: 'stdio', command: 'never-run' } }));
    agent.managed!.mcps.push(part.id);
    const changed = await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false });
    expect(changed).toMatchObject({ status: 'pending', materialized: { matchesDesired: false }, running: { matchesDesired: false } });
    expect(changed.desired?.parts.map((p) => p.id)).toContain(part.id);
    expect('parts' in changed.materialized && changed.materialized.parts?.map((p) => p.id)).not.toContain(part.id);
  });

  it('does not call an old materialization current when the effective project provider changed', async () => {
    delete agent.orchestrator;
    const materialized = { ...setupFingerprint(agent, await resolveManagedSetup(service, agent.managed!)), provider: 'copilot-cli' };
    const result = await managedActivationFor({ service, agent, effectiveProvider: 'codex-cli', running: true, materialized, deliveryFailed: false });
    expect(result).toMatchObject({ provider: 'codex-cli', status: 'pending', materialized: { provider: 'copilot-cli', matchesDesired: false }, running: { matchesDesired: false } });
  });

  it('reports plain agents, failed/missing deliveries and missing environment as blocked without secret-bearing diagnostics', async () => {
    const materialized = setupFingerprint(agent, await resolveManagedSetup(service, agent.managed!));
    expect(await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: true }))
      .toMatchObject({ status: 'blocked', materialized: { status: 'failed' }, running: { launchSetup: 'not_confirmed' }, diagnostics: ['delivery_failed'] });
    expect(await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false, mcpProblems: [{ server: 'safe', missingEnv: ['SERVICE_TOKEN'] }] }))
      .toMatchObject({ status: 'blocked', diagnostics: ['missing_mcp_environment'] });
    agent.managed!.skills.push('missing-skill');
    expect(await managedActivationFor({ service, agent, running: false, materialized, deliveryFailed: false }))
      .toMatchObject({ status: 'blocked', desired: { missing: ['missing-skill'] }, running: { status: 'stopped' } });
    delete agent.managed;
    expect(await managedActivationFor({ service, agent, running: true, deliveryFailed: false }))
      .toMatchObject({ status: 'blocked', configured: { managed: false }, desired: null, diagnostics: ['not_managed'] });
  });

  it('refuses duplicate MCP server keys rather than silently selecting a part by precedence', async () => {
    const parts = await user(async () => Promise.all(['One', 'Two'].map((name) => service.createPart({ name,
      content: { kind: 'mcp', serverKey: 'duplicate', transport: 'stdio', command: name.toLowerCase() } }))));
    await expect(service.checkSetup({ blocks: [], skills: [], mcps: parts.map((p) => p.id) })).rejects.toThrow('same server key');
    agent.managed!.mcps.push(...parts.map((p) => p.id));
    expect(await managedActivationFor({ service, agent, running: true, deliveryFailed: false }))
      .toMatchObject({ status: 'blocked', diagnostics: ['duplicate_mcp_keys'] });
  });
});

describe('provider-confirmed activation (#2855)', () => {
  const skillPart = (name: string, front?: string) => user(() => service.createPart({ name, content: { kind: 'skill', skillName: name,
    files: [{ path: 'SKILL.md', content: front ? `---\nname: "${front}"\ndescription: x\n---\nBody` : 'Body' }] } }));
  const mcpPart = (serverKey: string) => user(() => service.createPart({ name: `${serverKey} server`, content: { kind: 'mcp', serverKey, transport: 'stdio', command: 'never-run' } }));
  const claude = (inventory: { skills?: string[] | null; mcpTools?: string[] | null } | null, extra: Partial<ProviderSessionReport> = {}): ProviderSessionReport => ({
    driver: 'claude_agent_sdk', nativeSessionId: 'native-1',
    ...(inventory && { inventory: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'native-1', ...inventory } }),
    ...extra,
  });
  const current = async () => ({ ...setupFingerprint(agent, await resolveManagedSetup(service, agent.managed!)), provider: 'copilot-cli' });

  beforeEach(async () => {
    const [folder, declared, server] = await Promise.all([skillPart('review'), skillPart('deploy-folder', 'deploy'), mcpPart('tickets.api')]);
    agent.managed!.skills.push(folder.id, declared.id);
    agent.managed!.mcps.push(server.id);
  });

  it('verifies only parts the provider names for the current session, by folder or SKILL.md name', async () => {
    const result = await managedActivationFor({ service, agent, running: true, materialized: await current(), deliveryFailed: false,
      report: claude({ skills: ['review', 'deploy', 'other'], mcpTools: ['mcp__clubhouse__send_message', 'mcp__tickets_api__search'] }) });
    expect(result).toMatchObject({ status: 'verified', providerConfirmedLoaded: { skills: 'confirmed', mcpTools: 'confirmed', instructions: 'not_confirmed', source: 'claude-code system/init', nativeSessionId: 'native-1' },
      verification: { status: 'verified', attempts: 1 }, diagnostics: [] });
    expect(result.providerConfirmedLoaded.parts.every((p) => p.state === 'confirmed')).toBe(true);
  });

  it('waits for a report that has not arrived, or a server still connecting, without calling it loaded', async () => {
    const materialized = await current();
    const none = await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false, report: claude(null) });
    expect(none).toMatchObject({ status: 'partial', verification: { status: 'not_confirmed', reason: 'awaiting_provider_report' } });
    const connecting = await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false,
      report: claude({ skills: ['review', 'deploy'], mcpTools: ['mcp__clubhouse__send_message'] }, { mcpHandshakes: [{ name: 'tickets.api', status: 'pending' }] }) });
    expect(connecting.verification).toMatchObject({ status: 'not_confirmed', reason: 'awaiting_provider_report' });
    expect(connecting.providerConfirmedLoaded.parts.find((p) => p.name === 'tickets.api server')).toMatchObject({ state: 'awaiting_report', handshake: 'pending' });
  });

  it('blocks with the missing parts when the report leaves them out, and a connected handshake is not proof', async () => {
    const result = await managedActivationFor({ service, agent, running: true, materialized: await current(), deliveryFailed: false,
      report: claude({ skills: ['review'], mcpTools: ['mcp__clubhouse__send_message'] }, { mcpHandshakes: [{ name: 'tickets.api', status: 'connected', error: 'token=secret' }] }) });
    expect(result).toMatchObject({ status: 'blocked', diagnostics: ['not_in_provider_report'],
      providerConfirmedLoaded: { skills: 'not_in_report', mcpTools: 'not_in_report' },
      verification: { status: 'blocked', reason: 'not_in_provider_report', notInReport: ['deploy-folder', 'tickets.api server'] } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps a kind the provider never reports not confirmed: Copilot skills only, a terminal session nothing', async () => {
    const materialized = await current();
    const copilot = await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false, report: {
      driver: 'copilot_sdk', nativeSessionId: 'c-1',
      inventory: { provider: 'copilot', driver: 'copilot_sdk', source: 'session.skills_loaded', nativeSessionId: 'c-1', skills: ['review', 'deploy'] },
      mcpHandshakes: [{ name: 'tickets.api', status: 'connected' }, { name: 'clubhouse', status: 'connected' }] } });
    expect(copilot).toMatchObject({ status: 'partial', providerConfirmedLoaded: { skills: 'confirmed', mcpTools: 'not_confirmed' },
      verification: { status: 'partial', reason: 'provider_does_not_report' } });
    const terminal = await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false });
    expect(terminal).toMatchObject({ status: 'partial', providerConfirmedLoaded: { skills: 'not_confirmed', mcpTools: 'not_confirmed', source: 'none' },
      verification: { status: 'not_confirmed', reason: 'provider_evidence_unavailable', attempts: 0 } });
  });

  it('ignores a report from a session that started with another setup', async () => {
    const materialized = await current();
    agent.managed!.skills.push((await skillPart('later')).id);
    const result = await managedActivationFor({ service, agent, running: true, materialized, deliveryFailed: false,
      report: claude({ skills: ['review', 'deploy', 'later'], mcpTools: ['mcp__clubhouse__x', 'mcp__tickets_api__y'] }) });
    expect(result).toMatchObject({ status: 'pending', running: { matchesDesired: false },
      providerConfirmedLoaded: { skills: 'not_confirmed', mcpTools: 'not_confirmed', source: 'none' }, verification: { status: 'blocked', reason: 'session_not_current' } });
  });

  it('confirms nothing a report can\'t tie to one part: colliding or overlapping MCP keys, shared skill names', async () => {
    const materialized = async () => ({ ...setupFingerprint(agent, await resolveManagedSetup(service, agent.managed!)), provider: 'copilot-cli' });
    // tickets.api (in the setup) and tickets_api (outside it, seen in the handshake) are both mcp__tickets_api__.
    const collision = await managedActivationFor({ service, agent, running: true, materialized: await materialized(), deliveryFailed: false,
      report: claude({ skills: ['review', 'deploy'], mcpTools: ['mcp__clubhouse__x', 'mcp__tickets_api__search'] }, { mcpHandshakes: [{ name: 'tickets_api', status: 'connected' }] }) });
    expect(collision).toMatchObject({ status: 'partial', verification: { status: 'not_confirmed', reason: 'ambiguous_identity', ambiguous: ['tickets.api server'] } });
    expect(collision.providerConfirmedLoaded.parts.find((p) => p.name === 'tickets.api server')).toMatchObject({ state: 'not_confirmed', ambiguous: true });
    // a and a__b: mcp__a__b__search could be either server's tool.
    const [a, ab] = await Promise.all([mcpPart('a'), mcpPart('a__b')]);
    agent.managed!.mcps.push(a.id, ab.id);
    const overlap = await managedActivationFor({ service, agent, running: true, materialized: await materialized(), deliveryFailed: false,
      report: claude({ skills: ['review', 'deploy'], mcpTools: ['mcp__clubhouse__x', 'mcp__tickets_api__s', 'mcp__a__b__search'] }) });
    expect(overlap.providerConfirmedLoaded.parts.filter((p) => 'ambiguous' in p).map((p) => p.name).sort()).toEqual(['a server', 'a__b server']);
    expect(overlap.verification).toMatchObject({ status: 'not_confirmed', reason: 'ambiguous_identity' });
    agent.managed!.mcps = agent.managed!.mcps.filter((id) => id !== a.id && id !== ab.id);
    // A second skill whose folder is the first one's SKILL.md name.
    agent.managed!.skills.push((await skillPart('deploy')).id);
    const shared = await managedActivationFor({ service, agent, running: true, materialized: await materialized(), deliveryFailed: false,
      report: claude({ skills: ['review', 'deploy'], mcpTools: ['mcp__clubhouse__x', 'mcp__tickets_api__s'] }) });
    expect(shared.providerConfirmedLoaded.parts.filter((p) => p.kind === 'skill').map((p) => [p.name, p.state, 'ambiguous' in p])).toEqual([
      ['review', 'confirmed', false], ['deploy-folder', 'not_confirmed', true], ['deploy', 'not_confirmed', true],
    ]);
    expect(shared.verification).toMatchObject({ status: 'not_confirmed', reason: 'ambiguous_identity', ambiguous: ['deploy-folder', 'deploy'] });
  });

  it('reads a SKILL.md name only from front matter', () => {
    expect(skillDeclaredName({ kind: 'skill', skillName: 'f', files: [{ path: 'SKILL.md', content: "---\nname: 'quoted'\n---\n" }] })).toBe('quoted');
    expect(skillDeclaredName({ kind: 'skill', skillName: 'f', files: [{ path: 'SKILL.md', content: 'name: body-only' }] })).toBeUndefined();
    expect(skillDeclaredName({ kind: 'skill', skillName: 'f', files: [{ path: 'nested/SKILL.md', content: '---\nname: x\n---' }] })).toBeUndefined();
  });
});

describe('persistent lifecycle receipts (#2855)', () => {
  const input = { agentId: 'target', whenTurnEnds: true, fresh: false, requestedParts: [{ id: CLUBHOUSE_MCP_PART_ID, revision: 1 }] };
  const save = (r: ManagedRestartReceipt) => service.recordRestartReceipt(r);

  it('persists intent before restart, then its actor, revisions and outcome without content', async () => {
    const restart = vi.fn(async () => {
      expect(await service.latestRestartReceipt('target')).toMatchObject({ outcome: 'requested', actorId: 'dispatcher', requestedParts: input.requestedParts });
      return { resumed: true };
    });
    expect(await withSettingsSurface('mcp', 'dispatcher', () => restartWithReceipt(input, save, restart))).toEqual({ resumed: true });
    expect(restart).toHaveBeenCalledOnce();
    const reloaded = await createManagedStateStore(path.join(root, 'managed')).read();
    expect(reloaded.restarts).toMatchObject([{ outcome: 'completed', actorId: 'dispatcher', resumed: true, fresh: false, whenTurnEnds: true }]);
    expect(capture.settings().filter((r) => r.key.startsWith('managed.restart.'))).toEqual([
      { surface: 'mcp', actorId: 'dispatcher', scope: 'agent', targetId: 'target', key: 'managed.restart.requested', changed: true, outcome: 'ok' },
      { surface: 'mcp', actorId: 'dispatcher', scope: 'agent', targetId: 'target', key: 'managed.restart.completed', changed: true, outcome: 'ok' },
    ]);
  });

  it('persists a failed restart and never exposes the raw failure or promotes it to activation success', async () => {
    const restart = async () => { throw new Error('password=private-value at /private/source'); };
    const error = await restartWithReceipt(input, save, restart).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const result = await managedActivationFor({ service, agent, running: false, deliveryFailed: false });
    expect(result).toMatchObject({ status: 'blocked', lastRestart: { outcome: 'failed', failure: 'restart_failed' }, diagnostics: ['restart_failed'] });
    const raw = JSON.stringify({ result, error: String(error), audit: capture.settings(), persisted: fs.readFileSync(path.join(root, 'managed/state.json'), 'utf8') });
    expect(raw).not.toContain('private-value');
    expect(raw).not.toContain('/private/source');
    expect(result.providerConfirmedLoaded.mcpTools).toBe('not_confirmed');
  });

  it('does not perform lifecycle work when intent persistence fails, and does not report success when the completion receipt fails', async () => {
    const restart = vi.fn(async () => ({ resumed: true }));
    await expect(restartWithReceipt(input, async () => { throw new Error('disk full'); }, restart)).rejects.toThrow('Restart was not attempted');
    expect(restart).not.toHaveBeenCalled();
    await expect(restartWithReceipt(input, async (r) => {
      if (r.outcome === 'completed') throw new Error('secret outcome storage error');
      await save(r);
    }, restart)).rejects.toThrow('outcome receipt could not be saved');
    expect(restart).toHaveBeenCalledOnce();
    const result = await managedActivationFor({ service, agent, running: true, deliveryFailed: false });
    expect(result).toMatchObject({ lastRestart: { outcome: 'requested' }, restartNote: expect.stringContaining('do not assume completion') });
  });

  it('strips non-receipt stored fields and refuses malformed state without exposing its content', async () => {
    await restartWithReceipt(input, save, async () => ({ resumed: true }));
    const file = path.join(root, 'managed/state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.restarts[0].providerError = 'password=private-value at /private/source';
    state.restarts[0].requestedParts[0].content = 'private instruction';
    fs.writeFileSync(file, JSON.stringify(state));
    const receipt = await service.latestRestartReceipt('target');
    expect(receipt).toMatchObject({ outcome: 'completed', requestedParts: input.requestedParts });
    expect(JSON.stringify(receipt)).not.toMatch(/private|providerError|content/);
    fs.writeFileSync(file, '{"password":"private-value at /private/source",broken');
    await expect(service.latestRestartReceipt('target')).rejects.toMatchObject({
      message: 'Managed state is unreadable. Check local storage before retrying; no stored content was returned.',
    });
  });
});
