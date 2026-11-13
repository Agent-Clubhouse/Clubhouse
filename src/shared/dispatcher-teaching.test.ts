import { describe, expect, it } from 'vitest';
import { GRANT_ACTIONS, type Grant, type GrantAction, type GrantTarget } from './agent-grants';
import { applyGrantChanges } from './agent-grant-changes';
import { defaultGrants } from './default-grants';
import {
  ABILITIES_SUGGESTION, CAPABILITY_GROUPS, MEMORY_LINE, STATUS_SUGGESTION,
  buildDispatcherSuggestions, capabilitiesText, dispatcherCapabilities, dispatcherIntro,
  type CapabilityGroup, type TeachingAgent,
} from './dispatcher-teaching';

const DISPATCHER = defaultGrants({ dispatcher: true, helper: false, orchestrates: false, crossProject: false });

function lines(groups: CapabilityGroup[]): string[] {
  return groups.flatMap((g) => g.lines.map((l) => l.text));
}

function actionsShown(groups: CapabilityGroup[]): Set<GrantAction> {
  return new Set(groups.flatMap((g) => g.lines.flatMap((l) => l.actions)));
}

/** Not offered to the reader, on purpose (see ABILITIES). */
const UNSAID: ReadonlySet<GrantAction> = new Set(['memory.write', 'models.read', 'grant.request', 'browser.read', 'browser.act', 'group_project.read', 'group_project.post', 'group_project.lead', 'group_project.admin']);

describe('dispatcherCapabilities: built from the real grants (#3048)', () => {
  it('answers the Dispatcher\'s defaults in the five groups, in order', () => {
    const groups = dispatcherCapabilities(DISPATCHER);
    expect(groups.map((g) => g.id)).toEqual(CAPABILITY_GROUPS.map((g) => g.id));
    expect(groups.map((g) => g.title)).toEqual(['Your agents', 'New agents and connections', 'Schedules and follow-ups', 'Projects and settings', 'Keeping track']);
  });

  it('says every action the Dispatcher holds on something a person would recognise, and only those', () => {
    const shown = actionsShown(dispatcherCapabilities(DISPATCHER));
    // Grants on itself (other than its own Actions) and on the Dispatcher alone say nothing to the reader.
    const sayable = DISPATCHER.filter((g) => !UNSAID.has(g.action)
      && g.target.kind !== 'self' && !(g.target.kind === 'connected' && g.target.onlyDispatcher)
      && g.target.kind !== 'group_members' && g.target.kind !== 'group_project');
    expect([...shown].sort()).toEqual([...new Set(sayable.map((g) => g.action))].sort());
  });

  it('every grant action is either said or deliberately left out', () => {
    for (const action of GRANT_ACTIONS) {
      const said = actionsShown(dispatcherCapabilities([{ action, target: { kind: 'any' }, mode: 'allow' }])).has(action);
      expect(said, action).toBe(!UNSAID.has(action));
    }
  });

  it('marks what asks first, and says it in the line', () => {
    const projects = dispatcherCapabilities(DISPATCHER).find((g) => g.id === 'projects')!;
    expect(projects.lines.find((l) => l.actions.includes('project.add'))).toMatchObject({ text: 'Add or open projects, after asking you', asks: true });
    expect(projects.lines.find((l) => l.actions.includes('settings.app.read'))).toMatchObject({ text: 'See app settings', asks: false });
    // Deleting agents (#3182) asks first by default.
    const agents = dispatcherCapabilities(DISPATCHER).find((g) => g.id === 'agents')!;
    expect(agents.lines.find((l) => l.actions.includes('agent.dispose'))).toMatchObject({ text: 'Delete any agent, after asking you', asks: true });
  });

  it('changes with the grants: turning one off, allowing one that asked, and adding one', () => {
    const before = capabilitiesText(dispatcherCapabilities(DISPATCHER));
    const changed = applyGrantChanges(DISPATCHER, {
      changes: [
        { action: 'agent.wake', target: { kind: 'connected' }, mode: 'off' },
        { action: 'project.configure', target: { kind: 'project', project: 'any' }, mode: 'allow' },
        { action: 'agent.dispose', target: { kind: 'connected' }, mode: 'allow' },
      ],
    });
    const groups = dispatcherCapabilities(changed);
    const text = capabilitiesText(groups);
    expect(text).not.toBe(before);
    expect(actionsShown(groups).has('agent.wake')).toBe(false);
    // Now allowed, it joins the other things it does to any project, and no longer asks.
    expect(lines(groups)).toContain('See the settings of, rename or change the defaults of any project');
    expect(lines(groups).some((l) => l.includes('defaults') && l.includes('asking'))).toBe(false);
    expect(lines(groups).find((l) => l.includes('agents connected to me'))).toMatch(/\bor delete agents connected to me$/);
  });

  it('leaves out a narrower grant a wider one already covers, unless the narrower allows more', () => {
    const grants: Grant[] = [
      { action: 'agent.restart', target: { kind: 'any' }, mode: 'allow' },
      { action: 'agent.restart', target: { kind: 'connected' }, mode: 'allow' },
      { action: 'agent.sleep', target: { kind: 'any' }, mode: 'ask' },
      { action: 'agent.sleep', target: { kind: 'connected' }, mode: 'allow' },
    ];
    expect(lines(dispatcherCapabilities(grants))).toEqual([
      'Put to sleep any agent, after asking you',
      'Put to sleep agents connected to me',
      'Restart any agent',
      'Remember what we decide, and search what was said before',
    ]);
  });

  it('keeps "Set up Actions" under a wider grant on every Action, first in its group', () => {
    const schedules = dispatcherCapabilities(DISPATCHER).find((g) => g.id === 'schedules')!;
    expect(schedules.lines.map((l) => l.text)).toEqual([
      'Set up Actions that run on a schedule or when something happens',
      'See, change or run any Action',
    ]);
  });

  it('names a project by its folder, and skips the Dispatcher\'s own folder', () => {
    const own: GrantTarget = { kind: 'project', project: 'own' };
    const grants: Grant[] = [
      { action: 'project.configure', target: { kind: 'project', project: { path: '/work/webapp/' } }, mode: 'allow' },
      { action: 'project.display', target: own, mode: 'allow' },
    ];
    expect(lines(dispatcherCapabilities(grants))).toEqual(['Change the defaults of webapp', 'Remember what we decide, and search what was said before']);
  });

  it('with no grants it still says it remembers, and nothing else', () => {
    expect(dispatcherCapabilities([])).toEqual([{ id: 'tracking', title: 'Keeping track', lines: [{ text: 'Remember what we decide, and search what was said before', actions: [], asks: false }] }]);
    expect(MEMORY_LINE).toMatch(/^remember/);
  });

  it('reads as plain markdown: a bold heading per group and a line per item, with no em dashes', () => {
    const text = capabilitiesText(dispatcherCapabilities(DISPATCHER));
    expect(text.startsWith('**Your agents**\n- ')).toBe(true);
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/agent\.\w|connected:|\bany\b Action\b.*\bany\b Action/);
  });
});

const lead = (over: Partial<TeachingAgent> = {}): TeachingAgent => ({ id: 'lead', name: 'webapp-lead', running: true, ...over });

function kinds(agents: TeachingAgent[]): string[] {
  return buildDispatcherSuggestions(agents).map((s) => s.kind);
}

describe('buildDispatcherSuggestions', () => {
  it('without connected agents: the evergreen question, one management and one scheduling example, then abilities', () => {
    const out = buildDispatcherSuggestions([]);
    expect(out.map((s) => s.kind)).toEqual(['status', 'manage', 'schedule', 'abilities']);
    expect(out[0].text).toBe(STATUS_SUGGESTION);
    expect(out[out.length - 1].text).toBe(ABILITIES_SUGGESTION);
    expect(out.every((s) => !s.agentId)).toBe(true);
  });

  it('with connected agents: names them, and still exactly one scheduling and one management example', () => {
    const agents = [lead(), lead({ id: 'rel', name: 'release-lead', running: false }), lead({ id: 'docs', name: 'docs', running: false })];
    const out = buildDispatcherSuggestions(agents);
    expect(out.map((s) => s.kind)).toEqual(['status', 'agent', 'agent', 'manage', 'schedule', 'abilities']);
    expect(out.filter((s) => s.kind === 'schedule')).toHaveLength(1);
    expect(out.filter((s) => s.kind === 'manage')).toHaveLength(1);
    for (const s of out.filter((x) => x.agentId)) {
      expect(s.text).toContain(agents.find((a) => a.id === s.agentId)!.name);
    }
  });

  it('wakes an agent that is asleep, and schedules a different one', () => {
    const out = buildDispatcherSuggestions([lead(), lead({ id: 'rel', name: 'release-lead', running: false })]);
    const manage = out.find((s) => s.kind === 'manage')!;
    const schedule = out.find((s) => s.kind === 'schedule')!;
    expect(manage).toMatchObject({ agentId: 'rel', text: 'Wake release-lead and ask what\'s left on its list' });
    expect(schedule).toMatchObject({ agentId: 'lead', text: 'Every weekday at 9, have webapp-lead post its plan for the day' });
  });

  it('with only running agents, lets one sleep when it finishes', () => {
    expect(buildDispatcherSuggestions([lead()]).find((s) => s.kind === 'manage')!.text).toBe('Put webapp-lead to sleep when it finishes');
  });

  it('with one agent, both examples may name it', () => {
    const out = buildDispatcherSuggestions([lead({ running: false })]);
    expect(out.filter((s) => s.agentId === 'lead').map((s) => s.kind)).toEqual(['agent', 'manage', 'schedule']);
  });

  it('asks about at most two agents, preferring ones with a card, then running ones', () => {
    const agents = [
      lead({ id: 'a', name: 'alpha', running: false }),
      lead({ id: 'b', name: 'bravo', running: true }),
      lead({ id: 'c', name: 'charlie', running: false, purpose: 'Owns the docs' }),
      lead({ id: 'd', name: 'delta', running: true }),
    ];
    const about = buildDispatcherSuggestions(agents).filter((s) => s.kind === 'agent');
    expect(about.map((s) => s.agentId)).toEqual(['c', 'b']);
    expect(kinds(agents).filter((k) => k === 'agent')).toHaveLength(2);
  });
});

describe('dispatcherIntro', () => {
  it('speaks as the Dispatcher: its name, how many agents it reaches, what it does and that it remembers', () => {
    const [first, second] = dispatcherIntro({ name: 'Rosie', reachable: 3 });
    expect(first).toBe('Hi, I\'m Rosie. I can reach 3 of your agents.');
    expect(second).toMatch(/keep track/);
    expect(second).toMatch(/schedule/);
    expect(second).toMatch(/I remember/);
  });

  it('counts one agent in words, and says how to connect one when none are', () => {
    expect(dispatcherIntro({ name: 'Rosie', reachable: 1 })[0]).toBe('Hi, I\'m Rosie. I can reach one of your agents.');
    expect(dispatcherIntro({ name: 'Rosie', reachable: 0 })[0]).toMatch(/No agents are connected to me yet\. .*Details/);
  });

  it('reads the working name as a role', () => {
    expect(dispatcherIntro({ name: 'Dispatcher', reachable: 2 })[0]).toMatch(/^Hi, I'm the Dispatcher\./);
  });

  it('has no em dashes and never mentions a second session', () => {
    for (const n of [0, 1, 5]) {
      const text = dispatcherIntro({ name: 'Rosie', reachable: n }).join(' ');
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/coordinator|session/i);
    }
  });
});
