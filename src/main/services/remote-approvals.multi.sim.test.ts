/**
 * Three desktops, isolated module instances and identities, following the
 * multi-desktop membership/remote-create simulations. The transport round-trips
 * JSON; host authorization, parsing, receipts, pending store and answers are real.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnexPeer } from '../../shared/types';
import type { MobileCommand, MobileGrantRequest } from '../../shared/mobile-control';
import { GRANT_REQUEST_TTL_MS, type DesktopPendingGrantRequest } from '../../shared/grant-requests';

interface Machine {
  name: string;
  fingerprint: string;
  pin: string;
  peers: Map<string, AnnexPeer>;
  snapshots: Array<{ fingerprint: string; snapshot: { grantRequests: MobileGrantRequest[]; pendingGrantRequests?: DesktopPendingGrantRequest[] } }>;
  grants: typeof import('./grant-requests');
  mobile: typeof import('./mobile-grant-requests');
  commands: InstanceType<typeof import('./mobile-control').MobileCommandService>;
  control: typeof import('./mobile-control');
  authorizer: typeof import('./annex-authorizer');
  origin: typeof import('./settings-audit');
  sender: typeof import('./dispatcher-lead-approvals');
  beforeAnswer?: () => void;
}

const world = vi.hoisted(() => ({
  als: undefined as AsyncLocalStorage<Machine> | undefined,
  machines: [] as Machine[],
  deliveries: [] as Array<{ machine: string; agentId: string }>,
  lead: null as string | null,
}));
function here(): Machine {
  const machine = world.als?.getStore();
  if (!machine) throw new Error('No simulated desktop identity');
  return machine;
}
function as<T>(machine: Machine, fn: () => T): T {
  if (!world.als) throw new Error('Simulation not initialized');
  return world.als.run(machine, fn);
}
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const places = { projects: [{ id: 'app', path: '/app' }], dispatcher: null };

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./grant-telemetry', () => ({ recordGrantRequest: vi.fn() }));
vi.mock('./agent-grants-service', () => ({ setAgentGrant: vi.fn(async () => ({ rows: [] })) }));
vi.mock('./clubhouse-mcp/tools/helper-delivery', () => ({
  deliverHelperUpdate: async (agentId: string) => {
    world.deliveries.push({ machine: here().name, agentId });
    return 'delivered';
  },
}));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: here().fingerprint }) }));
vi.mock('./dispatcher-federation-lead', () => ({
  leadRole: () => world.lead === null ? 'peer' : world.lead === here().fingerprint ? 'lead' : 'follower',
}));
vi.mock('./annex-peers', async (original) => {
  const actual = await original<typeof import('./annex-peers')>();
  return { ...actual, listPeers: () => [...here().peers.values()], getPeer: (fp: string) => here().peers.get(fp) };
});
vi.mock('./annex-client', () => ({
  satelliteKeyFor: (fp: string) => here().peers.has(fp) ? fp : undefined,
  isMachineConnected: (fp: string) => here().peers.has(fp),
  getSatellites: () => here().snapshots,
  answerRemoteGrantRequest: async (fp: string, requestId: string, answer: string, reviewedDigest?: string) => {
    const caller = here();
    const host = world.machines.find((m) => m.fingerprint === fp)!;
    return (await send(host, caller, { type: 'grant.answer', requestId, answer, ...(reviewedDigest && { reviewedDigest }) })).body;
  },
}));

function authDeps(host: Machine) {
  return { findPeer: (fp: string) => host.peers.get(fp), isSessionOnly: () => false, networkEnabled: () => true };
}

async function send(host: Machine, caller: Machine, fields: Record<string, unknown>, identity = caller.fingerprint, pin = caller.pin) {
  return as(host, async () => {
    const auth = host.authorizer.authorize({ fingerprint: identity, pin, via: 'direct' }, authDeps(host));
    if (!auth.ok) return host.commands.reject(auth.error, auth.status);
    const input = wire({ version: 1, epoch: host.commands.epoch, commandId: `answer-${++sequence}`, ...fields });
    return host.commands.execute(auth.principal.fingerprint, input, (command: MobileCommand) => {
      if (command.type !== 'grant.answer') throw new Error('unexpected command');
      host.beforeAnswer?.();
      return host.mobile.runGrantCommand(command, places, {
        viewer: auth.principal.fingerprint,
        assertAuthorized: () => {
          if (!host.authorizer.stillAuthorized(auth.principal, authDeps(host))) {
            throw new host.control.MobileControlError('authorization_revoked', 403);
          }
        },
      });
    }, auth.peer.kind === 'phone' ? 'mobile' : 'annex_desktop');
  });
}

function refresh() {
  for (const viewer of world.machines) viewer.snapshots = world.machines.filter((m) => m !== viewer).map((host) => ({
    fingerprint: host.fingerprint,
    snapshot: wire(as(host, () => host.mobile.grantSnapshotForPeer(host.mobile.buildMobileGrantRequests(places), {
      fingerprint: viewer.fingerprint, peer: host.peers.get(viewer.fingerprint), networkEnabled: true, sessionOnly: false, hostLabel: host.name,
    }))),
  }));
}

function request(host: Machine, agentId = 'requester') {
  return as(host, () => {
    const key = host.grants.callKey(agentId, 'get_group_project_management', { group_project: 'gp_1' });
    const recorded = host.grants.recordGrantRequest(key, {
      kind: 'call', agentId, agentName: 'Dispatcher', projectPath: '/app', actions: ['group_project.admin'],
      where: 'group project', toolName: 'get_group_project_management', argumentsText: '{"group_project":"gp_1"}',
    });
    if (!recorded.ok) throw new Error('not recorded');
    return { id: recorded.request.requestId, key };
  });
}

let sequence = 0;
let host: Machine;
let desk: Machine;
let studio: Machine;
beforeEach(async () => {
  world.als = new AsyncLocalStorage();
  world.machines = [];
  world.deliveries = [];
  world.lead = null;
  sequence = 0;
  for (const [name, octet] of [['Mac Mini', 'aa'], ['Desk', 'bb'], ['Studio', 'cc']] as const) {
    vi.resetModules();
    const control = await import('./mobile-control');
    world.machines.push({
      name, fingerprint: Array(16).fill(octet).join(':'), pin: `pin-${name}`, peers: new Map(), snapshots: [],
      grants: await import('./grant-requests'), mobile: await import('./mobile-grant-requests'),
      control, commands: new control.MobileCommandService(), authorizer: await import('./annex-authorizer'),
      origin: await import('./settings-audit'), sender: await import('./dispatcher-lead-approvals'),
    });
  }
  [host, desk, studio] = world.machines;
  for (const machine of world.machines) for (const other of world.machines) if (other !== machine) machine.peers.set(other.fingerprint, {
    fingerprint: other.fingerprint, publicKey: 'key', alias: other.name, icon: 'computer', color: 'indigo',
    pairedAt: '', lastSeen: '', role: 'member', kind: 'desktop', tlsCertificateFingerprint: other.pin, tlsCertificatePem: 'pem',
  });
});
afterEach(() => {
  for (const machine of world.machines) machine.grants._resetGrantRequestsForTesting();
  vi.useRealTimers();
});

describe('remote human approvals without an elected lead (#3696)', () => {
  it('routes a no-lead peer answer to the host and clears all desktop snapshots', async () => {
    const { id, key } = request(host);
    refresh();
    expect(desk.snapshots.find((s) => s.fingerprint === host.fingerprint)?.snapshot.grantRequests).toHaveLength(1);
    expect(studio.snapshots.find((s) => s.fingerprint === host.fingerprint)?.snapshot.grantRequests).toHaveLength(1);
    await as(desk, () => desk.sender.answerFollowerApproval(host.fingerprint, id, 'allow_once'));
    expect(as(host, () => host.grants.consumeCallApproval(key))).toBe(true);
    expect(as(host, () => host.grants.consumeCallApproval(key))).toBe(false);
    expect(world.deliveries).toEqual([{ machine: 'Mac Mini', agentId: 'requester' }]);
    refresh();
    expect(desk.snapshots.find((s) => s.fingerprint === host.fingerprint)?.snapshot.grantRequests).toEqual([]);
    expect(studio.snapshots.find((s) => s.fingerprint === host.fingerprint)?.snapshot.grantRequests).toEqual([]);
  });

  it.each([false, true])('uses the first of two authorized peer answers (reverse=%s)', async (reverse) => {
    const { id, key } = request(host);
    refresh();
    const [first, second] = reverse ? [studio, desk] : [desk, studio];
    const results = await Promise.allSettled([
      as(first, () => first.sender.answerFollowerApproval(host.fingerprint, id, 'allow_once')),
      as(second, () => second.sender.answerFollowerApproval(host.fingerprint, id, 'decline')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(world.deliveries).toHaveLength(1);
    expect(as(host, () => host.grants.consumeCallApproval(key))).toBe(true);
  });

  it('keeps exact retries idempotent and rejects a new command replaying the answer', async () => {
    const { id } = request(host);
    const answer = { type: 'grant.answer', requestId: id, answer: 'allow_once', commandId: 'stable-retry' };
    const first = await send(host, desk, answer);
    expect(first.body.status).toBe('completed');
    expect(await send(host, desk, answer)).toEqual(first);
    expect((await send(host, desk, { ...answer, commandId: 'new-replay' })).body)
      .toMatchObject({ status: 'rejected', error: { code: 'grant_request_not_found' } });
    expect(world.deliveries).toHaveLength(1);
  });

  it.each(['expired', 'withdrawn', 'revoked'] as const)('refuses a stale snapshot after the request is %s', async (reason) => {
    const { id, key } = request(host);
    refresh();
    if (reason === 'expired') {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + GRANT_REQUEST_TTL_MS + 1);
    } else if (reason === 'withdrawn') as(host, () => host.grants.dropGrantRequestsFor('requester'));
    else host.peers.delete(desk.fingerprint);
    await expect(as(desk, () => desk.sender.answerFollowerApproval(host.fingerprint, id, 'allow_once'))).rejects.toThrow();
    expect(as(host, () => host.grants.consumeCallApproval(key))).toBe(false);
    expect(world.deliveries).toHaveLength(0);
  });

  it('refuses forged machines, pins, requesters and unauthorized peers at the host', async () => {
    const { id, key } = request(host);
    const answer = { type: 'grant.answer', requestId: id, answer: 'allow_once' };
    expect((await send(host, desk, answer, studio.fingerprint)).body.status).toBe('rejected');
    expect((await send(host, desk, answer, desk.fingerprint, 'forged-pin')).body.status).toBe('rejected');
    expect((await send(host, desk, { ...answer, agentId: 'forged-requester' })).body.error?.code).toBe('invalid_command');
    host.peers.get(desk.fingerprint)!.role = 'satellite';
    expect((await send(host, desk, answer)).body.error?.code).toBe('peer_role_not_allowed');
    expect(as(host, () => host.grants.consumeCallApproval(key))).toBe(false);
    expect(world.deliveries).toEqual([]);
  });

  it('rechecks revocation after authentication but before consuming the answer', async () => {
    const { id, key } = request(host);
    host.beforeAnswer = () => host.peers.delete(desk.fingerprint);
    expect((await send(host, desk, { type: 'grant.answer', requestId: id, answer: 'allow_once' })).body)
      .toMatchObject({ status: 'rejected', error: { code: 'authorization_revoked' } });
    expect(as(host, () => host.grants.peekGrantRequest(id))).not.toBeNull();
    expect(as(host, () => host.grants.consumeCallApproval(key))).toBe(false);
    expect(world.deliveries).toEqual([]);
  });

  it('exports a host-labelled read-only stub and refuses its answer at the host', async () => {
    const recorded = as(host, () => host.grants.recordGrantRequest('delete', {
      kind: 'call', agentId: 'private', agentName: 'Private agent', projectPath: '/app',
      actions: ['agent.dispose'], where: 'private batch', deleteReview: { items: [] }, reason: 'Private reason',
    }));
    if (!recorded.ok) throw new Error('not recorded');
    refresh();
    const snapshot = desk.snapshots.find((s) => s.fingerprint === host.fingerprint)!.snapshot;
    expect(snapshot).toEqual({ grantRequests: [], pendingGrantRequests: [{
      hostLabel: 'Mac Mini', requestId: recorded.request.requestId, kind: 'call', createdAt: recorded.request.createdAt,
    }] });
    expect((await send(host, desk, { type: 'grant.answer', requestId: recorded.request.requestId, answer: 'allow_once' })).body)
      .toMatchObject({ status: 'rejected', error: { code: 'grant_answer_not_offered' } });
    expect(world.deliveries).toEqual([]);
  });

  it('refuses an agent surface even when it supplies an authorized machine as viewer', async () => {
    const { id } = request(host);
    await expect(as(host, () => host.origin.withSettingsSurface('mcp', desk.fingerprint, () => host.mobile.runGrantCommand({
      version: 1, commandId: 'agent', epoch: host.commands.epoch, type: 'grant.answer', requestId: id, answer: 'allow_once',
    }, places, { viewer: desk.fingerprint, assertAuthorized: () => {} })))).rejects.toMatchObject({ code: 'grant_answer_not_offered' });
    expect(world.deliveries).toEqual([]);
  });
});
