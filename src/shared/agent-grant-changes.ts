import { isGrantAction, widerOrSame, type Grant, type GrantAction, type GrantMode, type GrantTarget } from './agent-grants';

/**
 * A person's changes to an agent's Clubhouse permissions (#2971, part of
 * #2921), saved on the agent (`DurableAgentConfig.grants`). The default grants
 * (`default-grants.ts`) stay the base; each change sets one action on one
 * target to Off, Ask first or Allow, and "Reset to defaults" clears them.
 * Only the user changes them for now: no agent tool writes them.
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
}

/** One action on one target, the unit a change sets. */
export function grantKey(g: { action: GrantAction; target: GrantTarget }): string {
  return `${g.action}@${targetKey(g.target)}`;
}

export function targetKey(t: GrantTarget): string {
  switch (t.kind) {
    case 'project': return `project:${typeof t.project === 'string' ? t.project : `path:${t.project.path}`}`;
    case 'group_project': return `group_project:${t.role}`;
    case 'connected': return t.excludeDispatcher ? 'connected:not_dispatcher' : 'connected';
    case 'action': return `action:${t.id}`;
    default: return t.kind;
  }
}

/**
 * Grants nobody can turn off: a helper always reaches its orchestrator to
 * report (#2921, "agent.message on parent (fixed)"). Shown greyed.
 */
export function isFixedGrant(g: { action: GrantAction; target: GrantTarget }): boolean {
  return g.action === 'agent.message' && g.target.kind === 'parent';
}

/** The grants an agent has: its defaults with its saved changes applied. */
export function applyGrantChanges(defaults: readonly Grant[], saved: AgentGrantChanges | undefined): Grant[] {
  if (!saved?.changes?.length) return [...defaults];
  const changed = new Map(saved.changes.filter((c) => !isFixedGrant(c)).map((c) => [grantKey(c), c]));
  const out = defaults.filter((g) => !changed.has(grantKey(g)));
  for (const c of changed.values()) {
    if (c.mode === 'off') continue;
    out.push({ action: c.action, target: c.target, mode: c.mode, source: c.by === 'dispatcher' ? 'dispatcher' : 'user' });
  }
  return out;
}

/**
 * A saved value read back: anything that isn't a well-formed change is
 * dropped, never widened, and each change is rebuilt from its known fields.
 */
export function normalizeGrantChanges(raw: unknown): AgentGrantChanges | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as AgentGrantChanges).changes)) return undefined;
  const changes: GrantChange[] = [];
  for (const c of (raw as { changes: unknown[] }).changes) {
    if (!c || typeof c !== 'object') continue;
    const { action, target, mode, by, at } = c as Record<string, unknown>;
    if (!isGrantAction(action) || !isGrantTarget(target) || (mode !== 'allow' && mode !== 'ask' && mode !== 'off')) continue;
    changes.push({
      action, target: rebuildTarget(target), mode,
      ...((by === 'user' || by === 'dispatcher') && { by }),
      ...(typeof at === 'string' && at.length <= 40 && { at }),
    });
  }
  return changes.length > 0 ? { changes } : undefined;
}

function rebuildTarget(t: GrantTarget): GrantTarget {
  switch (t.kind) {
    case 'project': return { kind: 'project', project: typeof t.project === 'string' ? t.project : { path: t.project.path } };
    case 'group_project': return { kind: 'group_project', role: t.role };
    case 'connected': return t.excludeDispatcher ? { kind: 'connected', excludeDispatcher: true } : { kind: 'connected' };
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

/** Set one change, replacing any for the same action and target. Setting a key back to its default mode removes the change. */
export function withGrantChange(saved: AgentGrantChanges | undefined, change: GrantChange, defaults: readonly Grant[]): AgentGrantChanges | undefined {
  const key = grantKey(change);
  const rest = (saved?.changes ?? []).filter((c) => grantKey(c) !== key);
  const base = defaults.find((g) => grantKey(g) === key);
  const isDefault = base ? base.mode === change.mode : change.mode === 'off';
  const changes = isDefault ? rest : [...rest, change];
  return changes.length > 0 ? { changes } : undefined;
}

/** One row of the Clubhouse permissions page: an action on a target, its mode and where that comes from. */
export interface GrantRow {
  action: GrantAction;
  target: GrantTarget;
  mode: GrantChangeMode;
  /** The default's mode, for "Reset" and to show a change. */
  defaultMode: GrantChangeMode;
  source: 'every_agent' | 'structural' | 'user' | 'dispatcher' | 'none';
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
  const rows: GrantRow[] = [];
  const seen = new Set<string>();
  for (const g of defaults) {
    const key = grantKey(g);
    if (seen.has(key)) continue;
    seen.add(key);
    const fixed = isFixedGrant(g);
    const change = fixed ? undefined : changes.get(key);
    rows.push({
      action: g.action, target: g.target, mode: change?.mode ?? g.mode, defaultMode: g.mode,
      source: change ? (change.by === 'dispatcher' ? 'dispatcher' : 'user') : g.source === 'every_agent' ? 'every_agent' : 'structural',
      fixed,
    });
  }
  for (const [key, c] of changes) {
    if (seen.has(key) || isFixedGrant(c)) continue;
    rows.push({ action: c.action, target: c.target, mode: c.mode, defaultMode: 'off', source: c.by === 'dispatcher' ? 'dispatcher' : 'user', fixed: false });
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
  'agent.dispose': 'Remove helpers',
  'agent.grant': 'Change setup, Access and permissions',
  'connection.manage': 'Make and remove connections',
  'group_project.read': 'Read the board',
  'group_project.post': 'Post to the board',
  'group_project.admin': 'Manage the group project',
  'project.read': 'See project settings',
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
};

/** The heading a target's rows go under. */
export function grantTargetLabel(t: GrantTarget): string {
  switch (t.kind) {
    case 'self': return 'Itself';
    case 'parent': return 'Its orchestrator';
    case 'my_helpers': return 'Its helpers';
    case 'connected': return t.excludeDispatcher ? 'Connected agents, except the Dispatcher' : 'Connected agents';
    case 'group_project': return t.role === 'admin' ? 'Group projects it runs' : 'Group projects it is in';
    case 'group_members': return 'Members of group projects it runs';
    case 'project': return t.project === 'own' ? 'Its project' : t.project === 'any' ? 'Every project' : `Project ${t.project.path}`;
    case 'app': return 'The app';
    case 'action': return 'One Action';
    case 'any': return 'Every agent, project and library';
  }
}
