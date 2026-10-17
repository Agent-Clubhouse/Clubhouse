import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useChromeStore } from './chromeStore';
import { useChromeFlagStore } from './chromeFlag';
import type { Agent, Project } from '../../shared/types';

/**
 * The scope model (docs/chrome-redesign-spec.md §4.5): in the new chrome the
 * sidebar selection decides what Terminal, Files and Git point at.
 *
 * - An agent row selected: that agent's worktree (or the project root, for an
 *   agent without a worktree).
 * - A project header selected: the project root.
 *
 * Built-in plugins read this directly (spec §6). It is null with the flag off
 * and for remote projects, where plugins keep their own behavior.
 */
/** Tabs that follow the scope: picking an agent on one of these keeps the tab. */
export const SCOPE_FOLLOWING_TABS: ReadonlySet<string> = new Set(['plugin:terminal', 'plugin:files', 'plugin:git']);

export interface ChromeScope {
  kind: 'agent' | 'project';
  projectId: string;
  /** Absolute directory the scope points at. */
  cwd: string;
  /** The same directory relative to the project root ('.' for the root). */
  relativeRoot: string;
  /** What the scope is, for display: the agent or project name. */
  label: string;
  agentId?: string;
  agentName?: string;
  /** True when the scope is an agent's own worktree. */
  isWorktree: boolean;
}

/** `path` relative to `root`, or '.' when they are the same or `path` is outside `root`. */
export function relativeTo(root: string, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const p = norm(path);
  if (!r || p === r || !p.startsWith(`${r}/`)) return '.';
  return p.slice(r.length + 1) || '.';
}

export function resolveChromeScope(
  project: Project | undefined,
  agent: Agent | undefined,
  projectScopeId: string | null,
): ChromeScope | null {
  if (!project) return null;
  const label = project.displayName || project.name;
  const projectScope: ChromeScope = {
    kind: 'project', projectId: project.id, cwd: project.path, relativeRoot: '.', label, isWorktree: false,
  };
  if (projectScopeId === project.id || !agent || agent.projectId !== project.id) return projectScope;
  if (!agent.worktreePath) {
    return { ...projectScope, kind: 'agent', label: agent.name, agentId: agent.id, agentName: agent.name };
  }
  return {
    kind: 'agent',
    projectId: project.id,
    cwd: agent.worktreePath,
    relativeRoot: relativeTo(project.path, agent.worktreePath),
    label: agent.name,
    agentId: agent.id,
    agentName: agent.name,
    isWorktree: true,
  };
}

/**
 * The current scope for `projectId`, or null when the new chrome is off, the
 * project is not the active local project, or `projectId` is missing.
 */
export function useChromeScope(projectId: string | undefined | null): ChromeScope | null {
  const enabled = useChromeFlagStore((s) => s.enabled);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = useProjectStore((s) => (enabled && projectId ? s.projects.find((p) => p.id === projectId) : undefined));
  const agent = useAgentStore((s) => (enabled && s.activeAgentId ? s.agents[s.activeAgentId] : undefined));
  const projectScopeId = useChromeStore((s) => s.projectScopeId);
  if (!enabled || !projectId || projectId !== activeProjectId) return null;
  return resolveChromeScope(project, agent, projectScopeId);
}
