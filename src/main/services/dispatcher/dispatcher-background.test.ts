import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/nonexistent-base-dir' }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../actions', () => ({
  actionsReady: () => false,
  ensureAppAction: vi.fn(),
  ensureAppSubscription: vi.fn(),
  removeAppAction: vi.fn(),
  setAppActionGate: vi.fn(),
}));
vi.mock('../clubhouse-mcp/binding-manager', () => ({ bindingManager: { getBindingsForAgent: () => [] } }));
vi.mock('./dispatcher-service', () => ({
  getDispatcherAgentId: () => null,
  getDispatcherState: () => ({ enabled: false }),
  onDispatcherChanged: () => () => undefined,
}));
vi.mock('./dispatcher-behavior', () => ({
  getDispatcherBehaviorPlan: vi.fn(),
  onDispatcherBehaviorChanged: () => () => undefined,
}));
vi.mock('./dispatcher-usage', () => ({ startDispatcherUsage: vi.fn() }));

import type { AppActionGate } from '../actions';
import { DISPATCHER_BEHAVIOR_PLANS, type DispatcherBehavior } from '../../../shared/dispatcher-behavior';
import { CHECK_IN_ACTION, CHECK_IN_TEXT, UPKEEP_IDLE_ACTION, UPKEEP_NIGHTLY_ACTION } from './dispatcher-background-plan';
import {
  _resetDispatcherBackgroundForTesting,
  _setBackgroundDepsForTesting,
  runDispatcherUpkeep,
  startDispatcherBackground,
  syncDispatcherBackground,
  upkeepReviewText,
} from './dispatcher-background';
import { renderTopicPage } from './dispatcher-memory';

const DISPATCHER = 'disp-1';

interface World {
  ready: boolean;
  enabled: boolean;
  agentId: string | null;
  level: DispatcherBehavior;
  connected: number;
  /** Hidden actions that exist, by name, with what they were last set to. */
  actions: Map<string, { kind: 'action' | 'subscription'; input: unknown }>;
  writes: number;
  gates: Map<string, AppActionGate>;
  behaviorListeners: Set<() => void>;
  dispatcherListeners: Set<() => void>;
  now: number;
}

let world: World;
let tmp: string;
let memory: string;

function install(): void {
  _setBackgroundDepsForTesting({
    ready: () => world.ready,
    ensureAction: (name, input) => { world.writes++; world.actions.set(name, { kind: 'action', input }); },
    ensureSubscription: (name, input) => { world.writes++; world.actions.set(name, { kind: 'subscription', input }); },
    remove: (name) => { if (world.actions.delete(name)) world.writes++; },
    setGate: (name, gate) => { if (gate) world.gates.set(name, gate); else world.gates.delete(name); },
    enabled: () => world.enabled,
    dispatcherAgentId: () => world.agentId,
    connectedAgents: () => world.connected,
    plan: () => DISPATCHER_BEHAVIOR_PLANS[world.level],
    onBehaviorChanged: (fn) => { world.behaviorListeners.add(fn); return () => world.behaviorListeners.delete(fn); },
    onDispatcherChanged: (fn) => { world.dispatcherListeners.add(fn); return () => world.dispatcherListeners.delete(fn); },
    memoryRoot: () => memory,
    stateFile: () => path.join(tmp, 'dispatcher-upkeep.json'),
    now: () => world.now,
  });
}

const names = () => [...world.actions.keys()].sort();
const setLevel = (level: DispatcherBehavior) => { world.level = level; for (const fn of world.behaviorListeners) fn(); };
const dispatcherChanged = () => { for (const fn of world.dispatcherListeners) fn(); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-background-'));
  memory = path.join(tmp, 'memory');
  world = {
    ready: true, enabled: true, agentId: DISPATCHER, level: 'standard', connected: 2,
    actions: new Map(), writes: 0, gates: new Map(), behaviorListeners: new Set(), dispatcherListeners: new Set(),
    now: new Date(2026, 10, 9, 12, 0).getTime(),
  };
  install();
});
afterEach(() => {
  _resetDispatcherBackgroundForTesting();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('syncing the hidden Actions with Behavior', () => {
  it('sets up the current level’s Actions at start, always turned on', () => {
    startDispatcherBackground();
    expect(names()).toEqual([CHECK_IN_ACTION, UPKEEP_IDLE_ACTION, UPKEEP_NIGHTLY_ACTION].sort());
    expect(world.actions.get(UPKEEP_IDLE_ACTION)?.kind).toBe('subscription');
    for (const a of world.actions.values()) expect(a.input).toMatchObject({ enabled: true });
  });

  it('re-syncs when the Behavior changes: Light removes the check-ins and idle upkeep', () => {
    startDispatcherBackground();
    setLevel('light');
    expect(names()).toEqual([UPKEEP_NIGHTLY_ACTION]);
    setLevel('thorough');
    expect(names()).toEqual([CHECK_IN_ACTION, UPKEEP_IDLE_ACTION, UPKEEP_NIGHTLY_ACTION].sort());
    expect(world.actions.get(UPKEEP_IDLE_ACTION)?.input).toMatchObject({ trigger: { delayMinutes: 20 } });
  });

  it('removes everything when the Dispatcher is turned off, and brings it back when it is on', () => {
    startDispatcherBackground();
    world.enabled = false;
    dispatcherChanged();
    expect(names()).toEqual([]);
    world.enabled = true;
    dispatcherChanged();
    expect(names()).toHaveLength(3);
  });

  it('a Dispatcher change that isn’t on, off or a new agent (it starting, say) changes nothing', () => {
    startDispatcherBackground();
    const writes = world.writes;
    dispatcherChanged();
    dispatcherChanged();
    expect(world.writes).toBe(writes);
  });

  it('makes nothing before Actions start or before the Dispatcher has an agent', () => {
    world.ready = false;
    expect(syncDispatcherBackground()).toEqual([]);
    world.ready = true;
    world.agentId = null;
    expect(syncDispatcherBackground()).toEqual([]);
    expect(names()).toEqual([]);
  });

  it('installs a gate for every hidden Action and removes them on stop', () => {
    const stop = startDispatcherBackground();
    expect([...world.gates.keys()].sort()).toEqual([CHECK_IN_ACTION, UPKEEP_IDLE_ACTION, UPKEEP_NIGHTLY_ACTION].sort());
    stop();
    expect(world.gates.size).toBe(0);
    setLevel('light');
    expect(names()).toHaveLength(3);
  });
});

describe('the check-in gate', () => {
  it('sends the check-in only while an agent is connected', async () => {
    startDispatcherBackground();
    const gate = world.gates.get(CHECK_IN_ACTION)!;
    expect(await gate({ actionId: 'a', name: CHECK_IN_ACTION })).toEqual({ send: CHECK_IN_TEXT });
    world.connected = 0;
    expect(await gate({ actionId: 'a', name: CHECK_IN_ACTION })).toHaveProperty('skip');
  });
});

describe('the upkeep gate', () => {
  function topic(rel: string, status: 'confirmed' | 'unconfirmed', ageMs = 0): void {
    const file = path.join(memory, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderTopicPage({ status, source: 'pm', body: 'x\n' }));
    const t = new Date(world.now - ageMs);
    fs.utimesSync(file, t, t);
  }

  it('asks the Dispatcher to check changed notes once, then sends nothing while nothing changes', async () => {
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'index.md'), 'Short.\n');
    topic('topics/checkout.md', 'unconfirmed', 60_000);
    topic('topics/release.md', 'confirmed', 120_000);

    const first = await runDispatcherUpkeep();
    expect('send' in first && first.send).toContain('topics/checkout.md (unconfirmed)');
    expect('send' in first && first.send).toContain('topics/release.md (confirmed)');
    expect('send' in first && first.send.indexOf('checkout')).toBeLessThan('send' in first ? first.send.indexOf('release') : 0);

    world.now += 60 * 60 * 1000;
    expect(await runDispatcherUpkeep()).toHaveProperty('skip');

    // A page edited after the last upkeep is checked at the next.
    world.now += 1000;
    topic('topics/checkout.md', 'confirmed', 0);
    const third = await runDispatcherUpkeep();
    expect('send' in third && third.send).toContain('topics/checkout.md (confirmed)');
    expect('send' in third && third.send).not.toContain('release.md');
  });

  it('sends nothing for an empty memory', async () => {
    expect(await runDispatcherUpkeep()).toHaveProperty('skip');
  });
});

describe('upkeepReviewText', () => {
  const empty = { rolledUp: { days: [], weeks: [] }, linksFixed: [], archived: [], brokenLinks: [], missingSources: [], changed: false };

  it('is null when nothing changed and nothing is left to fix', () => {
    expect(upkeepReviewText([], { ...empty, rolledUp: { days: ['2026-11-01'], weeks: [] }, changed: true })).toBeNull();
  });

  it('lists what Clubhouse couldn’t fix, and says what it did, in plain words', () => {
    const text = upkeepReviewText([], {
      ...empty,
      rolledUp: { days: ['2026-11-01'], weeks: [] },
      archived: ['topics/old.md'],
      brokenLinks: [{ page: 'topics/a.md', target: 'nowhere.md' }],
      missingSources: [{ page: 'topics/b.md', source: '/t/x.jsonl#L2' }],
    })!;
    expect(text).toContain('Clubhouse rolled the timeline up, moved an unconfirmed topic nothing used into memory/archive/.');
    expect(text).toContain('- topics/a.md: the link to nowhere.md goes nowhere');
    expect(text).toContain('- topics/b.md: the file it cites is gone (/t/x.jsonl#L2)');
    expect(text).toContain('don’t call tell_user');
    expect(text).not.toMatch(/—/);
  });

  it('caps a long list and counts the rest', () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({ page: `topics/p${i}.md`, mtimeMs: i }));
    const text = upkeepReviewText(pages, empty)!;
    expect(text).toContain('- and 5 more');
    expect(text.match(/^- topics\//gm)).toHaveLength(15);
  });
});
