import { widerOrSame, type GrantAction, type GrantTarget } from './agent-grants';
import type { GrantChangeMode } from './agent-grant-changes';

/**
 * What the Dispatcher teaches in its first conversation (#3048, part of
 * #3034): the intro it opens with, the suggestions under it, and the answer
 * to "What else can you do?".
 *
 * The answer is built from the Dispatcher's real grants (#2921), never
 * written by hand, so it can't drift from what it is allowed to do. Every
 * grant action has an entry in ABILITIES (the type makes sure), and each line
 * names the widest target a grant covers and whether it asks first.
 *
 * The welcome (#2814) explains what the Dispatcher is and how agents connect
 * to it; contextual tips are #2030's. Nothing here repeats those: the intro
 * speaks as the Dispatcher, and the suggestions are things to say to it.
 */

/** The five groups "What else can you do?" answers in, in order. */
export const CAPABILITY_GROUPS = [
  { id: 'agents', title: 'Your agents' },
  { id: 'new', title: 'New agents and connections' },
  { id: 'schedules', title: 'Schedules and follow-ups' },
  { id: 'projects', title: 'Projects and settings' },
  { id: 'tracking', title: 'Keeping track' },
] as const;

/**
 * After the five: what has a tool but is turned off in the Dispatcher's
 * permissions (#3238), so it can tell "turned off" from "not something
 * Clubhouse can do".
 */
export const TURNED_OFF_GROUP = { id: 'off', title: 'Turned off in your settings' } as const;

export type CapabilityGroupId = (typeof CAPABILITY_GROUPS)[number]['id'] | typeof TURNED_OFF_GROUP.id;

/** What kind of thing an action's target names, which decides how the target is said. */
type Noun = 'agent' | 'project' | 'action' | 'app' | 'library' | 'parts' | 'templates';

interface Ability {
  group: CapabilityGroupId;
  /** The verb, with the target said after it: "message" + "agents connected to me". For `app`, the whole line. */
  verb: string;
  noun: Noun;
  /**
   * The whole line for some targets, where verb and target would read oddly.
   * Undefined falls back to verb and target; null leaves the grant out.
   */
  line?: (target: GrantTarget) => string | null | undefined;
}

const anyProject = (t: GrantTarget) => t.kind === 'any' || (t.kind === 'project' && t.project === 'any');

/**
 * Every grant action, and how the Dispatcher says it. Null for the few that
 * mean nothing to the person reading (with the reason). A new action fails
 * the type check until it is added here. The order here is the order of the
 * verbs in a line.
 */
const ABILITIES: Readonly<Record<GrantAction, Ability | null>> = {
  'agent.message': { group: 'agents', verb: 'message', noun: 'agent' },
  'agent.wake': { group: 'agents', verb: 'wake', noun: 'agent' },
  'agent.sleep': { group: 'agents', verb: 'put to sleep', noun: 'agent' },
  'agent.reset': { group: 'agents', verb: 'clear the context of', noun: 'agent' },
  'agent.restart': { group: 'agents', verb: 'restart', noun: 'agent' },
  'agent.display': { group: 'agents', verb: 'rename', noun: 'agent' },
  'agent.configure': { group: 'agents', verb: 'change the model of', noun: 'agent' },
  'agent.grant': { group: 'agents', verb: 'change the setup and permissions of', noun: 'agent' },
  'agent.dispose': { group: 'agents', verb: 'delete', noun: 'agent' },
  'agent.create': { group: 'new', verb: 'create agents in', noun: 'project' },
  'connection.manage': { group: 'new', verb: 'make and remove connections for', noun: 'agent' },
  'connection.bootstrap': { group: 'new', verb: 'connect', noun: 'agent', line: () => 'connect agents I create in the same call to me' },
  'library.read': { group: 'new', verb: 'see', noun: 'library' },
  'library.write': { group: 'new', verb: 'edit', noun: 'parts' },
  'template.write': { group: 'new', verb: 'edit', noun: 'templates' },
  'template.push': { group: 'new', verb: 'push template changes to agents', noun: 'app' },
  'action.read': { group: 'schedules', verb: 'see', noun: 'action' },
  'action.write': {
    group: 'schedules', verb: 'change', noun: 'action',
    // On the app, it makes its own Actions.
    line: (t) => (t.kind === 'app' ? 'set up Actions that run on a schedule or when something happens' : undefined),
  },
  'action.run': { group: 'schedules', verb: 'run', noun: 'action' },
  'project.add': {
    group: 'projects', verb: 'add', noun: 'project',
    // The target is a folder that isn't a project yet.
    line: (t) => (anyProject(t) ? 'add or open projects' : t.kind === 'project' && typeof t.project === 'object' ? `add ${folderName(t.project.path)} as a project` : null),
  },
  'project.read': { group: 'projects', verb: 'see the settings of', noun: 'project' },
  'project.display': { group: 'projects', verb: 'rename', noun: 'project' },
  'project.configure': { group: 'projects', verb: 'change the defaults of', noun: 'project' },
  'settings.app.read': { group: 'projects', verb: 'see app settings', noun: 'app' },
  'settings.app.write': { group: 'projects', verb: 'change app settings', noun: 'app' },
  'device.read': { group: 'projects', verb: 'see your devices', noun: 'app' },
  'device.manage': { group: 'projects', verb: 'rename, reconnect or remove your devices', noun: 'app' },
  'agent.read': { group: 'tracking', verb: 'see the status and output of', noun: 'agent' },
  'user.notify': { group: 'tracking', verb: 'send you notifications', noun: 'app' },
  // Plumbing, not something to offer: the model list feeds a picker, and asking for a permission is how any agent asks.
  'models.read': null,
  'grant.request': null,
  'browser.read': null,
  'browser.act': null,
  // Group projects and canvas browsers are joined on a canvas, and the Dispatcher has none.
  'group_project.read': null,
  'group_project.post': null,
  'group_project.admin': null,
};

/** How a target is said for a kind of thing, or null when it says nothing to the reader (the Dispatcher itself, its own folder). */
function scopeOf(noun: Noun, target: GrantTarget): string | null {
  const everything = target.kind === 'any' || target.kind === 'app';
  switch (noun) {
    case 'agent':
      switch (target.kind) {
        case 'any': return 'any agent';
        // Wake it on a connection is the user's switch, said with the connection, not as a reach of its own.
        case 'connected': return target.onlyDispatcher || target.wakeOn ? null : 'agents connected to me';
        case 'my_helpers': return 'my helpers';
        case 'project':
          if (target.project === 'any') return 'agents in any project';
          return typeof target.project === 'string' ? null : `agents in ${folderName(target.project.path)}`;
        default: return null;
      }
    case 'project':
      if (anyProject(target)) return 'any project';
      return target.kind === 'project' && typeof target.project === 'object' ? folderName(target.project.path) : null;
    case 'action':
      switch (target.kind) {
        case 'any': case 'app': return 'any Action';
        case 'self': return 'my own Actions';
        case 'action': return 'an Action you shared with me';
        default: return null;
      }
    case 'library': return everything ? 'shared parts and templates' : null;
    case 'parts': return everything ? 'shared parts' : null;
    case 'templates': return everything ? 'templates' : null;
    case 'app':
      return everything ? '' : null;
  }
}

function folderName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The whole line a grant reads as on its own, undefined when it is verb and target, or null when it isn't said. */
function wholeLine(ability: Ability, target: GrantTarget): string | null | undefined {
  const line = ability.line?.(target);
  if (line !== undefined) return line;
  if (ability.noun === 'app') return scopeOf('app', target) === null ? null : ability.verb;
  return undefined;
}

/** One line of the answer. */
export interface CapabilityLine {
  text: string;
  /** The grant actions behind it, for tests and telemetry. */
  actions: GrantAction[];
  /** It asks the user first. */
  asks: boolean;
}

export interface CapabilityGroup {
  id: CapabilityGroupId;
  title: string;
  lines: CapabilityLine[];
}

/** A grant as either list shapes it: an effective grant, or a permissions-page row (Off is skipped). */
export interface GrantLike {
  action: GrantAction;
  target: GrantTarget;
  mode: GrantChangeMode;
}

const RANK: Record<GrantChangeMode, number> = { off: 0, ask: 1, allow: 2 };

/** Memory isn't a grant: the Dispatcher always reads and searches what it remembers. */
export const MEMORY_LINE = 'remember what we decide, and search what was said before';

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function joinVerbs(verbs: string[]): string {
  if (verbs.length <= 1) return verbs.join('');
  return `${verbs.slice(0, -1).join(', ')} or ${verbs[verbs.length - 1]}`;
}

/**
 * What the Dispatcher can do, from its grants, in the five groups. A grant is
 * left out when a wider one for the same action is at least as strong, so
 * "any agent" isn't followed by "agents connected to me". Lines with the same
 * target and mode in a group share one sentence. Empty groups are left out.
 */
export function dispatcherCapabilities(grants: readonly GrantLike[]): CapabilityGroup[] {
  const on = grants.filter((g) => g.mode !== 'off' && ABILITIES[g.action]);
  // A line of its own (setting up Actions) stays even under a wider grant, which reads differently.
  const ownLine = (g: GrantLike) => typeof ABILITIES[g.action]!.line?.(g.target) === 'string';
  const kept = on.filter((g) => ownLine(g) || !on.some((h) => h !== g && h.action === g.action
    && RANK[h.mode] >= RANK[g.mode]
    && widerOrSame(h.target, g.target) && !widerOrSame(g.target, h.target)));

  // Group, then target and mode, in the order ABILITIES lists actions.
  const order = Object.keys(ABILITIES) as GrantAction[];
  kept.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  const ownLines = new Set<string>();
  const buckets = new Map<CapabilityGroupId, Map<string, { scope: string; asks: boolean; verbs: string[]; actions: GrantAction[]; whole?: string }>>();
  for (const g of kept) {
    const ability = ABILITIES[g.action]!;
    const whole = wholeLine(ability, g.target);
    if (whole === null) continue;
    if (whole !== undefined && ownLine(g)) ownLines.add(whole);
    const scope = whole !== undefined ? '' : scopeOf(ability.noun, g.target);
    if (scope === null) continue;
    const asks = g.mode === 'ask';
    const key = whole !== undefined ? `whole:${whole}:${asks}` : `${scope}:${asks}`;
    const group = buckets.get(ability.group) ?? new Map();
    buckets.set(ability.group, group);
    const line = group.get(key) ?? { scope, asks, verbs: [], actions: [], ...(whole !== undefined && { whole }) };
    group.set(key, line);
    if (!line.actions.includes(g.action)) {
      line.actions.push(g.action);
      if (whole === undefined && !line.verbs.includes(ability.verb)) line.verbs.push(ability.verb);
    }
  }

  const out: CapabilityGroup[] = [];
  for (const { id, title } of CAPABILITY_GROUPS) {
    // A line of its own leads its group: "Set up Actions…" before "See, change or run any Action".
    const shaped = [...(buckets.get(id)?.values() ?? [])].sort((a, b) => Number(b.whole !== undefined && ownLines.has(b.whole)) - Number(a.whole !== undefined && ownLines.has(a.whole)));
    const lines: CapabilityLine[] = shaped.map((l) => {
      const body = l.whole ?? `${joinVerbs(l.verbs)} ${l.scope}`;
      return { text: sentence(l.asks ? `${body}, after asking you` : body), actions: l.actions, asks: l.asks };
    });
    if (id === 'tracking') lines.push({ text: sentence(MEMORY_LINE), actions: [], asks: false });
    if (lines.length > 0) out.push({ id, title, lines });
  }
  return out;
}

/**
 * The permissions-page rows that are Off and that no other grant covers, as
 * one group of lines (or null when there are none). Each line is said as if
 * it were on: the group's title says it's off.
 */
export function turnedOffCapabilities(rows: readonly GrantLike[], on: readonly GrantLike[]): CapabilityGroup | null {
  const off = rows.filter((r) => r.mode === 'off'
    && !on.some((g) => g.mode !== 'off' && g.action === r.action && widerOrSame(g.target, r.target)));
  const lines = dispatcherCapabilities(off.map((r) => ({ ...r, mode: 'allow' as const })))
    .flatMap((g) => g.lines)
    .filter((l) => l.actions.length > 0)
    .map((l) => ({ ...l, asks: false }));
  return lines.length > 0 ? { ...TURNED_OFF_GROUP, lines } : null;
}

/** The answer as plain markdown: a short heading per group, one line per item. */
export function capabilitiesText(groups: readonly CapabilityGroup[]): string {
  return groups.map((g) => [`**${g.title}**`, ...g.lines.map((l) => `- ${l.text}`)].join('\n')).join('\n\n');
}

// ---------------------------------------------------------------------------
// Suggestions

/** A connected agent, as the suggestions need it. */
export interface TeachingAgent {
  id: string;
  name: string;
  /** Running now, or asleep. Anything that isn't running reads as asleep. */
  running: boolean;
  /** What its card says it's for (#3041), when it has a card. */
  purpose?: string;
}

/**
 * - `status`: "What's everyone working on?", always first.
 * - `agent`: about one connected agent.
 * - `schedule`: a scheduling example, always one.
 * - `manage`: an agent-management example, always one.
 * - `abilities`: "What else can you do?", always last.
 */
export type SuggestionKind = 'status' | 'agent' | 'schedule' | 'manage' | 'abilities';

export interface DispatcherSuggestion {
  kind: SuggestionKind;
  /** What is sent, word for word, when it's picked. */
  text: string;
  /** The agent it is about, if any. */
  agentId?: string;
}

export const STATUS_SUGGESTION = 'What\'s everyone working on?';
export const ABILITIES_SUGGESTION = 'What else can you do?';
/** How many suggestions are about one agent each. */
export const MAX_AGENT_SUGGESTIONS = 2;

/** Agents with a card first (the Dispatcher knows what they're for), then running ones, then by name. */
function ranked(agents: readonly TeachingAgent[]): TeachingAgent[] {
  return [...agents].sort((a, b) => Number(!!b.purpose) - Number(!!a.purpose)
    || Number(b.running) - Number(a.running)
    || a.name.localeCompare(b.name));
}

/**
 * The suggestions under the intro: "What's everyone working on?", one or two
 * about connected agents, one scheduling example, one agent-management
 * example, and "What else can you do?". With no connected agents the examples
 * name none.
 */
export function buildDispatcherSuggestions(agents: readonly TeachingAgent[]): DispatcherSuggestion[] {
  const pool = ranked(agents);
  const out: DispatcherSuggestion[] = [{ kind: 'status', text: STATUS_SUGGESTION }];

  const about = pool.slice(0, MAX_AGENT_SUGGESTIONS);
  const asks = [(n: string) => `Catch me up on ${n}`, (n: string) => `What does ${n} need from me?`];
  about.forEach((a, i) => out.push({ kind: 'agent', text: asks[i](a.name), agentId: a.id }));

  // Management: wake one that's asleep, else let a running one sleep when done, else make one.
  const asleep = pool.find((a) => !a.running);
  const awake = pool.find((a) => a.running);
  if (asleep) out.push({ kind: 'manage', text: `Wake ${asleep.name} and ask what's left on its list`, agentId: asleep.id });
  else if (awake) out.push({ kind: 'manage', text: `Put ${awake.name} to sleep when it finishes`, agentId: awake.id });
  else out.push({ kind: 'manage', text: 'Create an agent to review my pull requests' });

  // Scheduling: another agent than the one just named, when there is one.
  const managed = out[out.length - 1].agentId;
  const planner = pool.find((a) => a.id !== managed) ?? pool[0];
  out.push(planner
    ? { kind: 'schedule', text: `Every weekday at 9, have ${planner.name} post its plan for the day`, agentId: planner.id }
    : { kind: 'schedule', text: 'Every weekday at 9, tell me what changed overnight' });

  out.push({ kind: 'abilities', text: ABILITIES_SUGGESTION });
  return out;
}

// ---------------------------------------------------------------------------
// The intro

export interface IntroFacts {
  /** Its name, as the user set it. */
  name: string;
  /** How many agents are connected to it. */
  reachable: number;
}

/**
 * Its first message, in its own voice: who it is, how many agents it can
 * reach, what it does, and that it remembers. With none connected it says how
 * to connect one, in a line, since the welcome already explained why.
 */
export function dispatcherIntro({ name, reachable }: IntroFacts): string[] {
  // The working name reads as a role; a name the user picked reads as a name.
  const hello = `Hi, I'm ${name === 'Dispatcher' ? 'the Dispatcher' : name}.`;
  const reach = reachable === 0
    ? 'No agents are connected to me yet. Turn me on in an agent\'s Details and I can reach it.'
    : `I can reach ${reachable === 1 ? 'one of your agents' : `${reachable} of your agents`}.`;
  return [
    `${hello} ${reach}`,
    'I keep track of what your agents are doing, get work going across your projects, and set up things to happen on a schedule. I remember what we decide, so you don\'t have to repeat yourself.',
  ];
}

/** What main sends the chat's empty state (IPC `dispatcher:get-teaching`). */
export interface DispatcherTeaching {
  /** The agents connected to it now. */
  agents: TeachingAgent[];
}
