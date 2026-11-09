import { isGrantAction, widerOrSame, type Grant, type GrantAction, type GrantMode, type GrantTarget } from './agent-grants';

/**
 * Changes to an agent's Clubhouse permissions (#2971, part of #2921), saved
 * in the app's data folder (agent-grants-store). Three layers, each over the
 * one before:
 * - the default grants (`default-grants.ts`), from what the agent is;
 * - `template`: what the template it was made from sets, written at creation
 *   and by a template push;
 * - `changes`: the person's own (or the Dispatcher's), which "Reset to
 *   defaults" clears, leaving the template's.
 * Each entry sets one action on one target to Off, Ask first or Allow.
 */
export type GrantChangeMode = GrantMode | 'off';

export interface GrantChange {
  action: GrantAction;
  target: GrantTarget;
  mode: GrantChangeMode;
  /** Who made it, shown beside it. */
  by?: 'user' | 'dispatcher';
  /** ISO time, for "changed 2m ago". */
  at?: string;
}

export interface AgentGrantChanges {
  changes: GrantChange[];
  /** What its template sets (#2971): no `by` or `at`, shown as "From its template". */
  template?: GrantChange[];
}

/** One permission a template sets. `mode: null` (in a push only) takes the template's setting away. */
export interface TemplateGrant {
  action: GrantAction;
  target: GrantTarget;
  mode: GrantChangeMode | null;
}

/** One action on one target, the unit a change sets. */
export function grantKey(g: { action: GrantAction; target: GrantTarget }): string {
  return `${g.action}@${targetKey(g.target)}`;
}

export function targetKey(t: GrantTarget): string {
  switch (t.kind) {
    case 'project': return `project:${typeof t.project === 'string' ? t.project : `path:${t.project.path}`}`;
    case 'group_project': return `group_project:${t.role}`;
    case 'connected': return t.onlyDispatcher ? 'connected:dispatcher' : t.excludeDispatcher ? 'connected:not_dispatcher' : 'connected';
    case 'action': return `action:${t.id}`;
    default: return t.kind;
  }
}

/**
 * The rows an orchestrator's approval setting (Helper control) sets: starting
 * helpers (agent.create on its own or any project) and removing them
 * (agent.dispose on its helpers). A template never sets these itself (#2971).
 */
export function isHelperControlRow(g: { action: GrantAction; target: GrantTarget }): boolean {
  return (g.action === 'agent.create' && g.target.kind === 'project' && (g.target.project === 'own' || g.target.project === 'any'))
    || (g.action === 'agent.dispose' && g.target.kind === 'my_helpers');
}

/**
 * Grants nobody can turn off: a helper always reaches its orchestrator to
 * report (#2921, "agent.message on parent (fixed)"). Shown greyed.
 */
export function isFixedGrant(g: { action: GrantAction; target: GrantTarget }): boolean {
  return g.action === 'agent.message' && g.target.kind === 'parent';
}

function overlay(base: readonly Grant[], layer: readonly GrantChange[] | undefined, sourceOf: (c: GrantChange) => Grant['source']): Grant[] {
  if (!layer?.length) return [...base];
  const changed = new Map(layer.filter((c) => !isFixedGrant(c)).map((c) => [grantKey(c), c]));
  const out = base.filter((g) => !changed.has(grantKey(g)));
  for (const c of changed.values()) {
    if (c.mode === 'off') continue;
    out.push({ action: c.action, target: c.target, mode: c.mode, source: sourceOf(c) });
  }
  return out;
}

/** The defaults with the template's layer over them: what "Reset to defaults" goes back to. */
export function templateBase(defaults: readonly Grant[], saved: AgentGrantChanges | undefined): Grant[] {
  return overlay(defaults, saved?.template, () => 'template');
}

/** The grants an agent has: its defaults, its template's layer, then its own changes. */
export function applyGrantChanges(defaults: readonly Grant[], saved: AgentGrantChanges | undefined): Grant[] {
  return overlay(templateBase(defaults, saved), saved?.changes, (c) => (c.by === 'dispatcher' ? 'dispatcher' : 'user'));
}

/** What an agent carries over its defaults, the template's and its own together (its own win): for Copy and Save as template. */
export function carriedGrants(saved: AgentGrantChanges | undefined): GrantChange[] {
  const out = new Map<string, GrantChange>();
  for (const c of [...(saved?.template ?? []), ...(saved?.changes ?? [])]) {
    if (!isFixedGrant(c) && !isHelperControlRow(c)) out.set(grantKey(c), { action: c.action, target: c.target, mode: c.mode });
  }
  return [...out.values()];
}

/**
 * Set or take away entries in the template's layer (a push sends only what
 * changed; creation sends them all). A mode of null takes one away.
 */
export function withTemplateGrants(saved: AgentGrantChanges | undefined, grants: readonly TemplateGrant[]): AgentGrantChanges | undefined {
  const layer = new Map((saved?.template ?? []).map((c) => [grantKey(c), c]));
  for (const g of grants) {
    if (isFixedGrant(g) || isHelperControlRow(g)) continue;
    if (g.mode === null) layer.delete(grantKey(g));
    else layer.set(grantKey(g), { action: g.action, target: g.target, mode: g.mode });
  }
  return shaped(saved?.changes ?? [], [...layer.values()]);
}

/** A saved value from its two layers; undefined when both are empty. */
export function shaped(changes: GrantChange[], template: GrantChange[] | undefined): AgentGrantChanges | undefined {
  if (changes.length === 0 && !template?.length) return undefined;
  return { changes, ...(template?.length && { template }) };
}

/** Each well-formed entry of a list, rebuilt from its known fields; anything else is dropped, never widened. */
function parseEntries(list: unknown, withWho: boolean): GrantChange[] {
  if (!Array.isArray(list)) return [];
  const out: GrantChange[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const { action, target, mode, by, at } = c as Record<string, unknown>;
    if (!isGrantAction(action) || !isGrantTarget(target) || (mode !== 'allow' && mode !== 'ask' && mode !== 'off')) continue;
    out.push({
      action, target: rebuildTarget(target), mode,
      ...(withWho && (by === 'user' || by === 'dispatcher') && { by }),
      ...(withWho && typeof at === 'string' && at.length <= 40 && { at }),
    });
  }
  return out;
}

/** A template's permissions, checked: null modes kept only when `forPush`. Fixed rows are dropped. */
export function normalizeTemplateGrants(raw: unknown, forPush = false): TemplateGrant[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = new Map<string, TemplateGrant>();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const { action, target, mode } = c as Record<string, unknown>;
    if (!isGrantAction(action) || !isGrantTarget(target)) continue;
    if (mode === null && !forPush) continue;
    if (mode !== null && mode !== 'allow' && mode !== 'ask' && mode !== 'off') continue;
    const g: TemplateGrant = { action, target: rebuildTarget(target), mode: mode as TemplateGrant['mode'] };
    if (!isFixedGrant(g) && !isHelperControlRow(g)) out.set(grantKey(g), g);
  }
  return [...out.values()];
}

/**
 * A saved value read back: anything that isn't a well-formed change is
 * dropped, never widened, and each change is rebuilt from its known fields.
 */
export function normalizeGrantChanges(raw: unknown): AgentGrantChanges | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { changes?: unknown; template?: unknown };
  if (!Array.isArray(r.changes) && !Array.isArray(r.template)) return undefined;
  return shaped(parseEntries(r.changes, true), parseEntries(r.template, false));
}

function rebuildTarget(t: GrantTarget): GrantTarget {
  switch (t.kind) {
    case 'project': return { kind: 'project', project: typeof t.project === 'string' ? t.project : { path: t.project.path } };
    case 'group_project': return { kind: 'group_project', role: t.role };
    case 'connected':
      return t.onlyDispatcher ? { kind: 'connected', onlyDispatcher: true }
        : t.excludeDispatcher ? { kind: 'connected', excludeDispatcher: true } : { kind: 'connected' };
    case 'action': return { kind: 'action', id: t.id };
    default: return { kind: t.kind };
  }
}

function isGrantTarget(t: unknown): t is GrantTarget {
  if (!t || typeof t !== 'object') return false;
  const target = t as { kind?: unknown; project?: unknown; role?: unknown };
  switch (target.kind) {
    case 'self': case 'parent': case 'my_helpers': case 'connected': case 'group_members': case 'app': case 'any':
      return true;
    case 'project':
      return target.project === 'own' || target.project === 'any'
        || (!!target.project && typeof target.project === 'object' && typeof (target.project as { path?: unknown }).path === 'string');
    case 'group_project':
      return target.role === 'member' || target.role === 'admin';
    case 'action':
      return typeof (target as { id?: unknown }).id === 'string' && (target as { id: string }).id.length > 0 && (target as { id: string }).id.length <= 200;
    default:
      return false;
  }
}

/**
 * Set one change, replacing any for the same action and target. Setting a key
 * back to what the defaults and the template give removes the change. The
 * template's layer is kept.
 */
export function withGrantChange(saved: AgentGrantChanges | undefined, change: GrantChange, defaults: readonly Grant[]): AgentGrantChanges | undefined {
  const key = grantKey(change);
  const rest = (saved?.changes ?? []).filter((c) => grantKey(c) !== key);
  const isDefault = baseModeOf(defaults, saved, key) === change.mode;
  return shaped(isDefault ? rest : [...rest, change], saved?.template);
}

/** A key's mode before the person's own changes: the template's, else the default's, else Off. */
function baseModeOf(defaults: readonly Grant[], saved: AgentGrantChanges | undefined, key: string): GrantChangeMode {
  const t = saved?.template?.find((c) => grantKey(c) === key);
  if (t) return t.mode;
  return defaults.find((g) => grantKey(g) === key)?.mode ?? 'off';
}

/** Clear the person's changes, keeping what the template sets. */
export function withoutOwnChanges(saved: AgentGrantChanges | undefined): AgentGrantChanges | undefined {
  return shaped([], saved?.template);
}

/** One row of the Clubhouse permissions page: an action on a target, its mode and where that comes from. */
export interface GrantRow {
  action: GrantAction;
  target: GrantTarget;
  mode: GrantChangeMode;
  /** The default's mode, for "Reset" and to show a change. */
  defaultMode: GrantChangeMode;
  source: 'every_agent' | 'structural' | 'template' | 'user' | 'dispatcher' | 'none';
  fixed: boolean;
  /**
   * Another row allows this action on a wider target, so this row's own
   * setting changes nothing: the key of that row. Shown as "Allowed by …",
   * and not changeable on its own.
   */
  coveredBy?: string;
}

/** Every row to show: each default, plus each saved change that isn't one. */
export function grantRows(defaults: readonly Grant[], saved: AgentGrantChanges | undefined): GrantRow[] {
  const changes = new Map((saved?.changes ?? []).map((c) => [grantKey(c), c]));
  const template = new Map((saved?.template ?? []).map((c) => [grantKey(c), c]));
  const rows: GrantRow[] = [];
  const seen = new Set<string>();
  // Defaults first, then what the template adds, then the person's own additions.
  const entries: Array<{ action: GrantAction; target: GrantTarget; base?: Grant }> = [
    ...defaults.map((g) => ({ action: g.action, target: g.target, base: g })),
    ...[...template.values()].map((c) => ({ action: c.action, target: c.target })),
    ...[...changes.values()].map((c) => ({ action: c.action, target: c.target })),
  ];
  for (const e of entries) {
    const key = grantKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    const fixed = isFixedGrant(e);
    if (fixed && !e.base) continue;
    const t = fixed ? undefined : template.get(key);
    const change = fixed ? undefined : changes.get(key);
    const base = defaults.find((g) => grantKey(g) === key);
    const defaultMode: GrantChangeMode = t?.mode ?? base?.mode ?? 'off';
    rows.push({
      action: e.action, target: e.target, mode: change?.mode ?? defaultMode, defaultMode,
      source: change ? (change.by === 'dispatcher' ? 'dispatcher' : 'user')
        : t ? 'template'
          : base ? (base.source === 'every_agent' ? 'every_agent' : 'structural') : 'none',
      fixed,
    });
  }
  for (const row of rows) {
    const wider = rows.find((other) => other !== row && other.action === row.action && other.mode === 'allow'
      && grantKey(other) !== grantKey(row) && widerOrSame(other.target, row.target) && !widerOrSame(row.target, other.target));
    if (wider) row.coveredBy = grantKey(wider);
  }
  return rows;
}

/** What the Clubhouse permissions page shows for one agent. */
export interface AgentGrantsView {
  rows: GrantRow[];
  /** What it carries over its defaults (template's and its own), for Copy another agent. */
  carried?: GrantChange[];
  helper: boolean;
  dispatcher: boolean;
  orchestrates: boolean;
}

/** What each action lets an agent do, in plain words, for the permissions page. */
export const GRANT_ACTION_LABELS: Readonly<Record<GrantAction, string>> = {
  'agent.read': 'See status, output and settings',
  'agent.message': 'Send messages and files',
  'agent.wake': 'Wake',
  'agent.sleep': 'Put to sleep',
  'agent.reset': 'Clear or compact its context',
  'agent.restart': 'Restart',
  'agent.display': 'Change name, color and icon',
  'agent.configure': 'Change CLI, model and effort',
  'agent.create': 'Create agents',
  'agent.dispose': 'Delete agents and remove helpers',
  'agent.grant': 'Change setup, Access and permissions',
  'connection.manage': 'Make and remove connections',
  'group_project.read': 'Read the board',
  'group_project.post': 'Post to the board',
  'group_project.admin': 'Manage the group project',
  'project.read': 'See project settings',
  'project.add': 'Add or open projects',
  'project.display': 'Change project name, color and icon',
  'project.configure': 'Change project defaults',
  'library.read': 'See parts and templates',
  'library.write': 'Edit shared parts',
  'template.write': 'Edit templates',
  'template.push': 'Push templates to agents',
  'settings.app.read': 'See app settings',
  'settings.app.write': 'Change app settings',
  'action.read': 'See Actions',
  'action.write': 'Change Actions',
  'action.run': 'Run Actions',
  'user.notify': 'Send you notifications',
  'models.read': 'See model lists',
  'browser.read': 'Read canvas browsers',
  'browser.act': 'Use canvas browsers',
  'grant.request': 'Ask for permissions',
  'device.read': 'See devices',
  'device.manage': 'Manage devices',
};

/** The heading a target's rows go under. */
export function grantTargetLabel(t: GrantTarget): string {
  switch (t.kind) {
    case 'self': return 'Itself';
    case 'parent': return 'Its orchestrator';
    case 'my_helpers': return 'Its helpers';
    case 'connected': return t.onlyDispatcher ? 'The Dispatcher, when connected' : t.excludeDispatcher ? 'Connected agents, except the Dispatcher' : 'Connected agents';
    case 'group_project': return t.role === 'admin' ? 'Group projects it runs' : 'Group projects it is in';
    case 'group_members': return 'Members of group projects it runs';
    case 'project': return t.project === 'own' ? 'Its project' : t.project === 'any' ? 'Every project' : `Project ${t.project.path}`;
    case 'app': return 'The app';
    case 'action': return 'One Action';
    case 'any': return 'Every agent, project and library';
  }
}
