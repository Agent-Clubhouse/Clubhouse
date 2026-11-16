import { describe, expect, it } from 'vitest';
import { ROSTER_LABEL_MAX, ROSTER_PAGE_MAX, clipLabel, readRosterAnswer, readRosterRequest } from './group-project-roster';

const HOST = Array.from({ length: 32 }, () => 'aa').join(':');
const OTHER = Array.from({ length: 32 }, () => 'bb').join(':');
const request = { v: 1 as const, groupProjectId: 'gp1', offset: 0, limit: 2 };
const page = (extra: Record<string, unknown> = {}) => ({
  v: 1, roster: 1, status: 'ok', groupProjectId: 'gp1', host: { machine: HOST }, seq: 3, generatedAt: '2026-11-15T00:00:00.000Z',
  members: [{ agentId: 'lead', machine: HOST, label: 'Lead', kind: 'durable', provenance: 'auto', inventory: 'verified', lead: 'allow', admin: 'off' }],
  copies: [], hostInventory: 'complete', machines: [], page: { offset: 0, total: 1 }, ...extra,
});

describe('group project roster wire (#3548)', () => {
  it('clamps a request\'s page size and refuses bad ids and offsets', () => {
    expect(readRosterRequest({ v: 1, groupProjectId: 'gp1', limit: 10_000 })).toEqual({ v: 1, groupProjectId: 'gp1', offset: 0, limit: ROSTER_PAGE_MAX });
    expect(() => readRosterRequest({ v: 1, groupProjectId: '../x' })).toThrow();
    expect(() => readRosterRequest({ v: 1, groupProjectId: 'gp1', offset: -1 })).toThrow();
    expect(() => readRosterRequest({ v: 2, groupProjectId: 'gp1' })).toThrow();
  });

  it('reads a page from the host that answered, and only that host', () => {
    expect(readRosterAnswer(page(), HOST, request)).toMatchObject({ status: 'ok', members: [{ agentId: 'lead', machine: HOST, lead: 'allow' }] });
    expect(() => readRosterAnswer(page(), OTHER, request)).toThrow(/host/);
    expect(() => readRosterAnswer(page({ groupProjectId: 'gp2' }), HOST, request)).toThrow();
  });

  it('refuses more members than asked for, bad roles and machines, and keeps unknown fields out', () => {
    const three = [0, 1, 2].map((i) => ({ ...page().members[0], agentId: `a${i}` }));
    expect(() => readRosterAnswer(page({ members: three }), HOST, request)).toThrow(/members/);
    expect(() => readRosterAnswer(page({ members: [{ ...page().members[0], lead: 'always' }] }), HOST, request)).toThrow();
    expect(() => readRosterAnswer(page({ members: [{ ...page().members[0], machine: 'laptop' }] }), HOST, request)).toThrow();
    const read = readRosterAnswer(page({ members: [{ ...page().members[0], path: '/secret', instructions: 'x' }] }), HOST, request);
    expect(JSON.stringify(read)).not.toContain('secret');
  });

  it('clips labels and drops control characters', () => {
    expect(clipLabel('Lead\u0000\nbot x')).toBe('Lead bot x');
    expect(clipLabel('x'.repeat(500))).toHaveLength(ROSTER_LABEL_MAX);
  });

  it('passes not found and busy through', () => {
    expect(readRosterAnswer({ v: 1, status: 'not_found' }, HOST, request)).toEqual({ v: 1, status: 'not_found' });
    expect(readRosterAnswer({ v: 1, status: 'busy' }, HOST, request)).toEqual({ v: 1, status: 'busy' });
  });
});
