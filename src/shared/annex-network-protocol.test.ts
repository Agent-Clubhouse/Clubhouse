import { describe, it, expect } from 'vitest';
import { NETWORK_MESSAGE_MAX_BYTES, parseNetworkMessage, type NetworkMember } from './annex-network-protocol';

const FP = Array.from({ length: 16 }, () => 'ab').join(':');
const CERT = Array.from({ length: 32 }, () => 'cd').join(':');

const member: NetworkMember = {
  fingerprint: FP,
  publicKey: 'MCowBQYDK2VwAyEA',
  certFingerprint: CERT,
  name: 'Studio',
  icon: 'computer',
  color: 'indigo',
  kind: 'desktop',
  hosts: ['192.168.1.9', 'studio.tail1234.ts.net'],
  port: 9443,
  joinedAt: '2026-11-08T10:00:00.000Z',
};

const json = (value: unknown) => JSON.stringify(value);

describe('Annex Network protocol (#3060)', () => {
  it.each([
    ['hello', { v: 1, type: 'hello', member }],
    ['members', { v: 1, type: 'members', members: [member], removals: [{ fingerprint: FP, removedAt: '2026-11-08T11:00:00Z' }] }],
    ['member-joined', { v: 1, type: 'member-joined', member }],
    ['member-removed', { v: 1, type: 'member-removed', removal: { fingerprint: FP, removedAt: '2026-11-08T11:00:00Z' } }],
    ['member-renamed', { v: 1, type: 'member-renamed', fingerprint: FP, name: 'Studio 2', at: '2026-11-08T11:00:00Z' }],
    ['hello without a port (no server)', { v: 1, type: 'hello', member: { ...member, port: undefined, hosts: [] } }],
  ])('accepts %s', (_name, message) => {
    expect(parseNetworkMessage(json(message))).toEqual({ ok: true, message: JSON.parse(json(message)) });
  });

  // Every kind of control message the main Annex socket carries, and some that don't exist.
  it.each([
    'pty:input', 'pty:resize', 'agent:spawn', 'agent:kill', 'agent:wake', 'canvas:mutation', 'clipboard:image',
    'permission:response', 'chat:send', 'session:pause', 'replay', 'snapshot', 'file:read', 'settings:update', 'run', '',
  ])('refuses a %j message as not membership', (type) => {
    expect(parseNetworkMessage(json({ v: 1, type, payload: { agentId: 'a', data: 'rm -rf ~\n' } }))).toEqual({ ok: false, reason: 'not-membership' });
  });

  it.each([
    ['an extra field on the message', { v: 1, type: 'hello', member, payload: { data: 'x' } }],
    ['an extra field on the member', { v: 1, type: 'hello', member: { ...member, command: 'agent:spawn' } }],
    ['a bad fingerprint', { v: 1, type: 'hello', member: { ...member, fingerprint: 'nope' } }],
    ['a bad certificate fingerprint', { v: 1, type: 'hello', member: { ...member, certFingerprint: 'ab:cd' } }],
    ['an unknown kind', { v: 1, type: 'hello', member: { ...member, kind: 'server' } }],
    ['too many hosts', { v: 1, type: 'hello', member: { ...member, hosts: Array(9).fill('h') } }],
    ['a bad port', { v: 1, type: 'hello', member: { ...member, port: 70000 } }],
    ['an empty name', { v: 1, type: 'hello', member: { ...member, name: '' } }],
    ['a bad time', { v: 1, type: 'member-removed', removal: { fingerprint: FP, removedAt: 'yesterday' } }],
    ['members that is not a list', { v: 1, type: 'members', members: member, removals: [] }],
    ['too many members', { v: 1, type: 'members', members: Array(65).fill(member), removals: [] }],
    ['a renamed message missing its time', { v: 1, type: 'member-renamed', fingerprint: FP, name: 'x' }],
  ])('refuses %s as malformed', (_name, message) => {
    expect(parseNetworkMessage(json(message))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses another protocol version, non-JSON, a non-object and an oversized message', () => {
    expect(parseNetworkMessage(json({ v: 2, type: 'hello', member }))).toEqual({ ok: false, reason: 'version' });
    expect(parseNetworkMessage('{nope')).toEqual({ ok: false, reason: 'not-json' });
    expect(parseNetworkMessage('[1,2]')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseNetworkMessage('x'.repeat(NETWORK_MESSAGE_MAX_BYTES + 1))).toEqual({ ok: false, reason: 'too-large' });
    expect(parseNetworkMessage(Buffer.from(json({ v: 1, type: 'hello', member }))).ok).toBe(true);
  });
});
