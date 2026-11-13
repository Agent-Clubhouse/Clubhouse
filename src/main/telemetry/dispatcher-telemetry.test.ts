import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { abortPending } from './facade';
import { captureEvents, type EventCapture } from './__test-utils__/event-capture';
import {
  dispatcherTelemetryActive,
  recordDispatcherControl,
  recordFederatedRequest,
  recordFederationLink,
  recordFederationLimit,
  recordDispatcherTurn,
  recordMemoryHealth,
  recordMemoryUpkeep,
  recordNewsTriage,
  type DispatcherMemoryHealth,
} from './dispatcher-telemetry';
import { EVENTS, getAttributeSpec } from '../../shared/telemetry/attributes';

const DISPATCHER_EVENTS = [
  'clubhouse.dispatcher.turn',
  'clubhouse.dispatcher.memory_health',
  'clubhouse.dispatcher.memory_upkeep',
  'clubhouse.dispatcher.news_triage',
] as const;

const HEALTH: DispatcherMemoryHealth = {
  pages: 12, bytes: 20_480, topics: 5, agentPages: 3, timelinePages: 3, indexBytes: 9_000, indexCapBytes: 8_192,
  unlinkedTopics: 2, staleTopics: 1, unconfirmedTopics: 4, conflictingPages: 2, neglectedPages: 3, brokenLinks: 3, missingSources: 1,
};

/** Every Dispatcher event, once, through the public recorders. */
function recordOneOfEach(): void {
  recordDispatcherTurn('background', { tokens: { input: 1200, cachedInput: 800, cacheWrite: 100, output: 300, reasoning: 50 }, costUsd: 0.0123, costIsEstimate: true });
  recordMemoryHealth(HEALTH);
  recordMemoryUpkeep({ outcome: 'ok', rolledDays: 2, rolledWeeks: 1, linksFixed: 4, pruned: 1, toCheck: 3, review: true });
  recordNewsTriage({ kind: 'answer', show: 'now', reason: 'answer', fromAgent: true });
}

let capture: EventCapture | null = null;
afterEach(() => {
  capture?.stop();
  capture = null;
  abortPending();
});

describe('Dispatcher telemetry with telemetry off', () => {
  it('records nothing and says so', () => {
    expect(dispatcherTelemetryActive()).toBe(false);
    recordOneOfEach();
    expect(recordDispatcherControl({ tool: 'connect_orchestrators', actorId: 'disp', targets: ['a'], outcome: 'ok' })).toBe(false);
    // Turned on afterwards: nothing was buffered from before.
    capture = captureEvents();
    expect(capture.events).toEqual([]);
  });
});

describe('Dispatcher telemetry with telemetry on', () => {
  it('records a turn with its side of the split, tokens and cost', () => {
    capture = captureEvents();
    expect(dispatcherTelemetryActive()).toBe(true);
    recordDispatcherTurn('background', { tokens: { input: 1200, cachedInput: 800, cacheWrite: 100, output: 300, reasoning: 50 }, costUsd: 0.0123, costIsEstimate: true });
    expect(capture.named('clubhouse.dispatcher.turn')).toEqual([expect.objectContaining({
      attrs: {
        'clubhouse.dispatcher.work': 'background',
        'clubhouse.dispatcher.turn.usage_reported': true,
        'clubhouse.dispatcher.turn.input_tokens': 1200,
        'clubhouse.dispatcher.turn.cached_input_tokens': 800,
        'clubhouse.dispatcher.turn.cache_write_tokens': 100,
        'clubhouse.dispatcher.turn.output_tokens': 300,
        'clubhouse.dispatcher.turn.reasoning_tokens': 50,
        'clubhouse.dispatcher.turn.cost_micro_usd': 12_300,
        'clubhouse.cost.estimate': true,
      },
    })]);
  });

  it('a turn the provider reported nothing for says so and carries no figures', () => {
    capture = captureEvents();
    recordDispatcherTurn('conversations', { tokens: { input: Number.NaN } });
    expect(capture.events[0].attrs).toEqual({ 'clubhouse.dispatcher.work': 'conversations', 'clubhouse.dispatcher.turn.usage_reported': false });
  });

  it('records memory health, with the index against its cap', () => {
    capture = captureEvents();
    recordMemoryHealth(HEALTH);
    expect(capture.events[0]).toMatchObject({
      name: 'clubhouse.dispatcher.memory_health',
      attrs: {
        'clubhouse.dispatcher.memory.pages': 12,
        'clubhouse.dispatcher.memory.bytes': 20_480,
        'clubhouse.dispatcher.memory.topics': 5,
        'clubhouse.dispatcher.memory.agent_pages': 3,
        'clubhouse.dispatcher.memory.timeline_pages': 3,
        'clubhouse.dispatcher.memory.index_bytes': 9_000,
        'clubhouse.dispatcher.memory.index_cap_bytes': 8_192,
        'clubhouse.dispatcher.memory.index_over_cap': true,
        'clubhouse.dispatcher.memory.unlinked_topics': 2,
        'clubhouse.dispatcher.memory.stale_topics': 1,
        'clubhouse.dispatcher.memory.conflicting_pages': 2,
        'clubhouse.dispatcher.memory.neglected_pages': 3,
        'clubhouse.dispatcher.memory.unconfirmed_topics': 4,
        'clubhouse.dispatcher.memory.broken_links': 3,
        'clubhouse.dispatcher.memory.missing_sources': 1,
      },
    });
    recordMemoryHealth({ ...HEALTH, indexBytes: 100 });
    expect(capture.events[1].attrs['clubhouse.dispatcher.memory.index_over_cap']).toBe(false);
  });

  it('records what upkeep did, and a run that failed', () => {
    capture = captureEvents();
    recordMemoryUpkeep({ outcome: 'ok', rolledDays: 2, rolledWeeks: 1, linksFixed: 4, pruned: 1, toCheck: 3, review: true });
    recordMemoryUpkeep({ outcome: 'error' });
    expect(capture.events.map((e) => e.attrs)).toEqual([
      {
        'clubhouse.outcome': 'ok',
        'clubhouse.dispatcher.upkeep.rolled_days': 2,
        'clubhouse.dispatcher.upkeep.rolled_weeks': 1,
        'clubhouse.dispatcher.upkeep.links_fixed': 4,
        'clubhouse.dispatcher.upkeep.pruned': 1,
        'clubhouse.dispatcher.upkeep.to_check': 3,
        'clubhouse.dispatcher.upkeep.review': true,
      },
      {
        'clubhouse.outcome': 'error',
        'clubhouse.dispatcher.upkeep.rolled_days': 0,
        'clubhouse.dispatcher.upkeep.rolled_weeks': 0,
        'clubhouse.dispatcher.upkeep.links_fixed': 0,
        'clubhouse.dispatcher.upkeep.pruned': 0,
        'clubhouse.dispatcher.upkeep.to_check': 0,
        'clubhouse.dispatcher.upkeep.review': false,
      },
    ]);
  });

  it('records triage outcomes, with held items only on a check-in and the rewrite always none (#3193)', () => {
    capture = captureEvents();
    recordNewsTriage({ kind: 'answer', show: 'now', reason: 'answer', fromAgent: true });
    recordNewsTriage({ kind: 'check_in', show: 'check_in', fromAgent: false, held: 3 });
    recordNewsTriage({ kind: 'routine', show: 'later', reason: 'routine', fromAgent: true, held: 9 });
    expect(capture.events.map((e) => e.attrs)).toEqual([
      {
        'clubhouse.dispatcher.news.kind': 'answer',
        'clubhouse.dispatcher.news.show': 'now',
        'clubhouse.dispatcher.news.reason': 'answer',
        'clubhouse.dispatcher.news.from_agent': true,
        'clubhouse.dispatcher.news.rewrite': 'none',
        'clubhouse.dispatcher.news.rewrite_reason': 'none',
      },
      {
        'clubhouse.dispatcher.news.kind': 'check_in',
        'clubhouse.dispatcher.news.show': 'check_in',
        'clubhouse.dispatcher.news.reason': 'none',
        'clubhouse.dispatcher.news.from_agent': false,
        'clubhouse.dispatcher.news.held': 3,
        'clubhouse.dispatcher.news.rewrite': 'none',
        'clubhouse.dispatcher.news.rewrite_reason': 'none',
      },
      {
        'clubhouse.dispatcher.news.kind': 'routine',
        'clubhouse.dispatcher.news.show': 'later',
        'clubhouse.dispatcher.news.reason': 'routine',
        'clubhouse.dispatcher.news.from_agent': true,
        'clubhouse.dispatcher.news.rewrite': 'none',
        'clubhouse.dispatcher.news.rewrite_reason': 'none',
      },
    ]);
  });

  it('carries no content: only registered counts, flags and closed codes, no ids', () => {
    capture = captureEvents();
    recordOneOfEach();
    expect(capture.events.map((e) => e.name).sort()).toEqual([...DISPATCHER_EVENTS].sort());
    for (const event of capture.events) {
      for (const [key, value] of Object.entries(event.attrs)) {
        const spec = getAttributeSpec(key);
        expect(spec, key).toBeDefined();
        expect(['int', 'bool', 'enum'], key).toContain(spec!.kind);
        if (spec!.kind === 'enum') expect(spec!.values, key).toContain(value);
      }
    }
  });

  it('a recorder never throws, whatever it is handed', () => {
    capture = captureEvents();
    expect(() => recordDispatcherTurn('background', null as unknown as { tokens?: undefined })).not.toThrow();
    expect(() => recordMemoryHealth(null as unknown as DispatcherMemoryHealth)).not.toThrow();
  });
});

describe('the Dispatcher events are registered and documented', () => {
  const spec = fs.readFileSync(path.join(__dirname, '../../../docs/telemetry-otel-spec.md'), 'utf-8');
  // The spec abbreviates `clubhouse.` as `c.`, and lists an event's attributes in one table row.
  const documented = (key: string) => spec.includes(`\`${key}\``) || spec.includes(`\`${key.replace(/^clubhouse\./, 'c.')}\``);
  const row = (event: string) => spec.split('\n').find((l) => l.startsWith(`| \`${event.replace(/^clubhouse\./, 'c.')}\` |`)) ?? '';

  it.each(DISPATCHER_EVENTS)('%s is a Standard event with its own row in §4.18', (name) => {
    expect(EVENTS[name].level).toBe('standard');
    expect(documented(name)).toBe(true);
    expect(row(name)).not.toBe('');
  });

  it('every attribute an event carries is named in its row', () => {
    capture = captureEvents();
    recordOneOfEach();
    for (const event of capture.events) {
      const line = row(event.name);
      for (const key of Object.keys(event.attrs)) {
        const short = key.replace(/^clubhouse\./, 'c.');
        // Sibling attributes are written `.suffix` after the first of their family.
        const suffix = `\`.${key.split('.').pop()}\``;
        expect(line.includes(`\`${short}\``) || line.includes(suffix), `${event.name}: ${key}`).toBe(true);
      }
    }
  });
});


describe('federation telemetry (#3350)', () => {
  const request = { originRequestId: 'private-request-id', origin: { machineId: 'private-origin', agentId: 'private-agent', machineName: 'Private machine', agentName: 'Private name' },
    machineId: 'private-target', targetId: 'private-controller', delivery: 'accepted' as const, outcome: 'under_way' as const, triage: 'now' as const,
    text: 'Private task content', reason: 'Private report content' };
  it('does nothing while off and tolerates a failed measurement', () => {
    recordFederatedRequest(request, 'crossing'); recordFederationLink('active'); recordFederationLimit();
    capture = captureEvents(); expect(capture.events).toEqual([]);
    expect(() => recordFederatedRequest(null as unknown as typeof request, 'crossing')).not.toThrow();
  });
  it('records every delivery and triage state and a limit trip with no identifiers', () => {
    capture = captureEvents();
    for (const delivery of ['accepted', 'delivered', 'refused', 'expired'] as const) recordFederatedRequest({ ...request, delivery }, 'crossing');
    for (const triage of ['now', 'check_in', 'needs_user', 'decline', 'pending'] as const) recordFederatedRequest({ ...request, triage }, 'triage');
    for (const outcome of ['under_way', 'waiting_user', 'answered', 'declined', 'failed'] as const) recordFederatedRequest({ ...request, outcome }, 'crossing');
    recordFederationLimit();
    expect(capture.named('clubhouse.dispatcher.federation').map((e) => e.attrs['clubhouse.federation.delivery']).slice(0, 4)).toEqual(['accepted', 'delivered', 'refused', 'expired']);
    expect(capture.named('clubhouse.dispatcher.federation').slice(4, 9).map((e) => e.attrs['clubhouse.federation.triage'])).toEqual(['now', 'check_in', 'needs_user', 'decline', 'pending']);
    expect(capture.named('clubhouse.dispatcher.federation').slice(9, 14).map((e) => e.attrs['clubhouse.federation.outcome'])).toEqual(['under_way', 'waiting_user', 'answered', 'declined', 'failed']);
    expect(capture.events.at(-1)?.attrs).toEqual({ 'clubhouse.federation.event': 'limit' });
    const allowed = ['clubhouse.federation.delivery', 'clubhouse.federation.outcome', 'clubhouse.federation.event', 'clubhouse.federation.triage'];
    for (const event of capture.events) for (const key of Object.keys(event.attrs)) expect(allowed).toContain(key);
    const serialized = JSON.stringify(capture.events);
    for (const privateValue of ['private-request-id', 'private-origin', 'private-agent', 'private-target', 'private-controller', 'Private machine', 'Private name', 'Private task content', 'Private report content']) expect(serialized).not.toContain(privateValue);
    for (const event of capture.events) for (const key of Object.keys(event.attrs)) expect(getAttributeSpec(key)?.kind).toBe('enum');
  });
  it('records link admission, offline pause, resume, unavailable and removal without labels', () => {
    capture = captureEvents();
    for (const state of ['active', 'paused', 'active', 'unavailable', 'removed'] as const) recordFederationLink(state);
    expect(capture.named('clubhouse.dispatcher.federation_link').map((e) => e.attrs['clubhouse.federation.link_state'])).toEqual(['active', 'paused', 'active', 'unavailable', 'removed']);
    for (const event of capture.events) expect(Object.keys(event.attrs)).toEqual(['clubhouse.federation.link_state']);
    expect(EVENTS['clubhouse.dispatcher.federation_link'].level).toBe('standard');
  });
});
