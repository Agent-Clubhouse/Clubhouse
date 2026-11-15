import { describe, expect, it } from 'vitest';
import {
  applyMembershipPatch, isEmptyPatch, membershipPatch, qualifyQueuedPatch, readSyncResponse, readWriteRequest,
} from './group-project-network';
import type { GroupProjectMembership } from './group-project-types';

const HOST = Array.from({ length: 32 }, () => 'aa').join(':');
const OTHER = Array.from({ length: 32 }, () => 'bb').join(':');

function snapshot(machine: string) {
  return {
    record: { id: 'gp_1', name: 'Launch', description: '', instructions: '', createdAt: 'x', metadata: {}, scope: { level: 'app', reach: 'network' }, host: { machine } },
    seq: 3,
    membership: { version: 1, autoJoin: false, explicit: [], excluded: [] },
    board: { messages: [{ id: 'm1', sender: 's', topic: 'work', body: 'b', timestamp: 't', seq: 3 }], ids: { work: ['m1'] }, protectedTopics: [], inboxOwners: {} },
  };
}

describe('group project network protocol (#3363)', () => {
  it('accepts a host speaking for its own group projects only', () => {
    expect(readSyncResponse({ v: 1, projects: [snapshot(HOST)], unchanged: [], tombstones: [] }, HOST).projects).toHaveLength(1);
    expect(() => readSyncResponse({ v: 1, projects: [snapshot(OTHER)], unchanged: [], tombstones: [] }, HOST)).toThrow('snapshot host');
  });

  it('refuses a copy of a group project that is not shared with the network', () => {
    const local = snapshot(HOST);
    local.record.scope = { level: 'app', reach: 'local' };
    expect(() => readSyncResponse({ v: 1, projects: [local], unchanged: [], tombstones: [] }, HOST)).toThrow();
  });

  it('marks tombstones as the answering host\'s, and drops unsafe ids', () => {
    const response = readSyncResponse({ v: 1, projects: [], unchanged: ['../x', 'gp_2'], tombstones: [{ groupProjectId: 'gp_9', seq: 4, deletedAt: 't', host: { machine: OTHER } }] }, HOST);
    expect(response.unchanged).toEqual(['gp_2']);
    expect(response.tombstones).toEqual([{ groupProjectId: 'gp_9', host: { machine: HOST }, seq: 4, deletedAt: 't', state: 'deleted' }]);
  });

  it('validates every write it is asked to apply', () => {
    const write = (w: unknown) => ({ v: 1, writes: [{ id: 'w1', groupProjectId: 'gp_1', queuedAt: 't', author: { label: 'a' }, write: w }] });
    expect(readWriteRequest(write({ op: 'post', sender: 's', topic: 'work', body: 'b' })).writes[0].write).toEqual({ op: 'post', sender: 's', topic: 'work', body: 'b' });
    expect(() => readWriteRequest(write({ op: 'post', sender: 's', topic: 'work' }))).toThrow();
    expect(() => readWriteRequest(write({ op: 'rm -rf' }))).toThrow();
    expect(() => readWriteRequest(write({ op: 'membership', patch: { addExplicit: [], removeExplicit: [], addExcluded: [], removeExcluded: [], set: { explicit: [] } } }))).toThrow();
    expect(() => readWriteRequest({ v: 1, writes: Array.from({ length: 101 }, () => write({ op: 'ensureChannels' }).writes[0]) })).toThrow();
  });

  it('turns one membership into another with a patch the host applies to its own current record', () => {
    const base: GroupProjectMembership = { version: 1, autoJoin: true, explicit: [{ address: 'a', kind: 'durable', addedAt: 't' }], excluded: [] };
    const next: GroupProjectMembership = {
      ...base, explicit: [...base.explicit, { address: `b@${OTHER}`, kind: 'durable', addedAt: 't' }], excluded: [{ address: 'c', excludedAt: 't' }], autoJoinOffer: 'accepted',
    };
    const patch = membershipPatch(base, next);
    expect(isEmptyPatch(patch)).toBe(false);
    expect(isEmptyPatch(membershipPatch(base, base))).toBe(true);
    // The host's record changed meanwhile: the patch keeps that change.
    const hostNow: GroupProjectMembership = { ...base, explicit: [...base.explicit, { address: 'd', kind: 'helper', addedAt: 't' }] };
    expect(applyMembershipPatch(hostNow, patch)).toEqual({
      ...hostNow,
      explicit: [...hostNow.explicit, { address: `b@${OTHER}`, kind: 'durable', addedAt: 't' }],
      excluded: [{ address: 'c', excludedAt: 't' }],
      autoJoinOffer: 'accepted',
    });
  });
});

describe('a queued patch from before entries were keyed by address (#3516)', () => {
  const empty = { addExplicit: [], removeExplicit: [], addExcluded: [], removeExcluded: [] };
  const held = { version: 1, autoJoin: false, explicit: [], excluded: [], disabledTools: { lead: ['a'] } } as unknown as GroupProjectMembership;

  it('rekeys this computer\'s bare ids to id@<self>, keeps the host\'s entries, and returns what it can\'t attribute', () => {
    const patch = { ...empty, set: { disabledTools: { lead: ['a'], builder: ['b'], ghost: ['c'] }, subscriptions: { builder: { add: ['x'], remove: [] } } } };
    const out = qualifyQueuedPatch(patch, OTHER, held, (id) => id === 'builder');
    // 'lead' is held by the host's record and not ours; 'builder' is ours; 'ghost' is neither.
    expect(out.patch.set).toEqual({
      disabledTools: { lead: ['a'], [`builder@${OTHER}`]: ['b'] },
      subscriptions: { [`builder@${OTHER}`]: { add: ['x'], remove: [] } },
    });
    expect(out.unattributed).toEqual(['ghost']);
  });

  it('leaves qualified keys and patches without these maps alone', () => {
    const patch = { ...empty, set: { disabledTools: { [`builder@${OTHER}`]: ['b'] }, autoJoin: true } };
    expect(qualifyQueuedPatch(patch, OTHER, held, () => true)).toEqual({ patch, unattributed: [] });
  });
});
