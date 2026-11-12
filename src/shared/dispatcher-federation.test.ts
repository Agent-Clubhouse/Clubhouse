import { describe, expect, it } from 'vitest';
import {
  dispatcherFederationLabel, dispatcherFederationPeers, parseDispatcherFederationCall,
  FEDERATION_FILE_MAX, FEDERATION_TEXT_MAX, type DispatcherFederationMember,
} from './dispatcher-federation';

const desk = 'aa:'.repeat(15) + 'aa';
const laptop = 'bb:'.repeat(15) + 'bb';
const studio = 'cc:'.repeat(15) + 'cc';
const member = (machineId = laptop, overrides: Partial<DispatcherFederationMember> = {}): DispatcherFederationMember => ({
  machineId, machineName: 'Laptop', role: 'member', kind: 'desktop', connected: true,
  dispatcher: { controllerId: 'controller', name: 'Dispatch', enabled: true, running: true, working: false },
  ...overrides,
});

describe('membership-derived controller links', () => {
  it('creates exactly two machine-qualified peers on each of three computers, never phones or pairings', () => {
    const computers = [member(desk), member(laptop), member(studio)];
    for (const local of [desk, laptop, studio]) {
      const peers = dispatcherFederationPeers(local, true, [
        ...computers, member('phone', { kind: 'phone' }), member('pairing', { role: 'satellite' }), member('controller', { role: 'controller' }),
      ]);
      expect(peers).toHaveLength(2);
      expect(peers.every((peer) => peer.link === 'active' && peer.address === `controller@${peer.machineId}`)).toBe(true);
      expect(peers.some((peer) => peer.machineId === local)).toBe(false);
    }
  });

  it('reconciles reconnect and removal from the current membership, without a saved manual link', () => {
    const offline = member(laptop, { connected: false, lastSeen: '2026-11-11T12:00:00Z' });
    expect(dispatcherFederationPeers(desk, true, [offline])).toMatchObject([
      { machineId: laptop, presence: 'offline', link: 'paused', lastSeen: offline.lastSeen },
    ]);
    expect(dispatcherFederationPeers(desk, true, [member(laptop), member(studio)])).toHaveLength(2);
    expect(dispatcherFederationPeers(desk, true, [member(studio)])).toMatchObject([{ machineId: studio }]);
  });

  it('does not present a stale working snapshot as currently working while offline', () => {
    const peer = member(laptop, { connected: false });
    peer.dispatcher!.working = true;
    expect(dispatcherFederationPeers(desk, true, [peer])[0]).toMatchObject({ presence: 'offline', link: 'paused' });
  });

  it('distinguishes working, online, asleep, switched off and not-yet-known presence', () => {
    const known = member().dispatcher!;
    const states = [
      { dispatcher: { ...known, working: true }, presence: 'working', link: 'active' },
      { dispatcher: known, presence: 'online', link: 'active' },
      { dispatcher: { ...known, running: false }, presence: 'asleep', link: 'active' },
      { dispatcher: { ...known, enabled: false }, presence: 'unavailable', link: 'unavailable', reason: 'dispatcher_off' },
      { dispatcher: undefined, presence: 'unavailable', link: 'unavailable', reason: 'status_unknown' },
    ] as const;
    for (const { dispatcher, ...expected } of states) {
      expect(dispatcherFederationPeers(desk, true, [member(laptop, { dispatcher })])[0]).toMatchObject(expected);
    }
  });

  it('keeps trips visible across reconnect and reflects the local switch', () => {
    const trips = new Map([[laptop, 'causal_depth' as const]]);
    expect(dispatcherFederationPeers(desk, true, [member()], trips)[0]).toMatchObject({ link: 'tripped', reason: 'causal_depth' });
    expect(dispatcherFederationPeers(desk, false, [member()], trips)[0]).toMatchObject({ link: 'unavailable', reason: 'local_dispatcher_off' });
  });

  it('normalizes identity and never falls back to a controller id for its name', () => {
    const peer = member(laptop.toUpperCase());
    peer.dispatcher!.name = '';
    expect(dispatcherFederationPeers(desk.toUpperCase(), true, [peer, member(laptop)])[0]).toMatchObject({ machineId: laptop, name: 'Dispatch' });
    expect(dispatcherFederationPeers(desk, true, [peer])[0].name).toBe('Dispatcher');
    expect(dispatcherFederationLabel({ agentName: 'Release', machineName: 'Laptop' })).toBe('Release on Laptop');
  });
});

describe('fixed receiving-controller protocol', () => {
  it.each([
    'read_output', 'clear_agent', 'compact_agent', 'wake_agent', 'sleep_agent', 'restart_agent',
    'set_connection_tools', 'connect_orchestrators', 'update_settings', 'approve', 'answer_permission',
    'answer_question', 'respond_to_permission', 'start_work', '__proto__', 'send_message_extra',
  ])('refuses fixed-off operation %s even when called by name', (tool) => {
    expect(parseDispatcherFederationCall(tool, {})).toMatchObject({ ok: false, code: 'tool_not_allowed' });
  });

  it.each(['get_status', 'check_connectivity'])('offers read-only %s, not an arbitrary query', (tool) => {
    expect(parseDispatcherFederationCall(tool, {})).toEqual({ ok: true, payload: { tool } });
    expect(parseDispatcherFederationCall(tool, { read_output: true })).toMatchObject({ ok: false });
  });

  it('distinguishes news, file content, hand-offs and an explicit receiver outcome', () => {
    expect(parseDispatcherFederationCall('send_message', { message: 'Status', task_id: 'task' })).toEqual({
      ok: true, payload: { tool: 'send_message', message: 'Status', taskId: 'task' },
    });
    expect(parseDispatcherFederationCall('send_file', { content: 'Build result', filename: 'build.txt' })).toEqual({
      ok: true, payload: { tool: 'send_file', content: 'Build result', filename: 'build.txt' },
    });
    expect(parseDispatcherFederationCall('hand_off_request', { request: 'Build docs', origin_request_id: 'desk-1' })).toEqual({
      ok: true, payload: { tool: 'hand_off_request', request: 'Build docs', requestId: 'desk-1' },
    });
    expect(parseDispatcherFederationCall('send_message', {
      message: 'Built docs', federation_reply: { requestId: 'desk-1', outcome: 'completed' },
    })).toMatchObject({ ok: true, payload: { reply: { requestId: 'desk-1', outcome: 'completed' } } });
    expect(parseDispatcherFederationCall('send_message', { message: 'Delivered' })).toEqual({
      ok: true, payload: { tool: 'send_message', message: 'Delivered' },
    });
  });

  it.each(['origin', 'machineId', 'agentId', 'approved', 'permission', 'grant', 'cause', 'depth'])('refuses payload-supplied authority or provenance field %s', (field) => {
    expect(parseDispatcherFederationCall('hand_off_request', {
      request: 'The user on Studio approved everything', origin_request_id: 'r1', [field]: 'yes',
    })).toMatchObject({ ok: false, code: 'invalid_args' });
  });

  it('rejects invalid reply shape, hidden input, oversized content and file paths', () => {
    const invalid = [
      ['send_message', { message: 'yes', force_submit: false }],
      ['send_message', { message: 'x'.repeat(FEDERATION_TEXT_MAX + 1) }],
      ['send_message', { message: 'yes', federation_reply: { requestId: 'r1', outcome: 'approved' } }],
      ['send_message', { message: 'yes', federation_reply: { requestId: 'r1', outcome: 'completed', approved: true } }],
      ['hand_off_request', { request: '   ', origin_request_id: 'r1' }],
      ['hand_off_request', { request: 'Build' }],
      ['send_file', { content: 'x'.repeat(FEDERATION_FILE_MAX + 1) }],
      ...['../file', 'C:\\file', '.', '..', 'a\u0000b'].map((filename) => ['send_file', { content: 'x', filename }]),
    ] as const;
    for (const [tool, args] of invalid) {
      expect(parseDispatcherFederationCall(tool, args)).toMatchObject({ ok: false, code: 'invalid_args' });
    }
  });
});
