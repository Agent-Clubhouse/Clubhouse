/**
 * Renderer side of Clubhouse-managed agents (#2819): unwraps ManagedResult
 * into values or a plain-language error, and hooks that refetch when main
 * says parts, templates or setups changed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedAgentSetup,
  ManagedAgentStatus,
  ManagedErrorCode,
  ManagedPartKind,
  ManagedPartSummary,
  ManagedResult,
  ManagedTemplate,
} from '../../../shared/managed-agents-types';

const MESSAGES: Record<ManagedErrorCode, string> = {
  not_found: 'It no longer exists. Reload and try again.',
  stale: 'It changed since you opened it. Reload to see the latest version.',
  invalid: 'Check the name, paths and fields.',
  builtin_read_only: 'Built-in parts can\'t be edited. Make your copy instead.',
  in_use: 'Agents still use it.',
  not_managed: 'This agent isn\'t Clubhouse managed.',
  not_permitted: 'This change isn\'t allowed from here.',
  name_taken: 'That name is taken. Pick another.',
  failed: 'Something went wrong. Try again.',
};

export class ManagedUiError extends Error {
  constructor(readonly code: ManagedErrorCode, message: string) {
    super(message);
  }
}

export async function unwrap<T>(p: Promise<ManagedResult<T>>): Promise<T> {
  const r = await p;
  if (r.ok === true) return r.value;
  throw new ManagedUiError(r.code, r.message || MESSAGES[r.code]);
}

export function errorText(err: unknown): string {
  if (err instanceof ManagedUiError) return err.message;
  return MESSAGES.failed;
}

export const managed = () => window.clubhouse.managed;

/**
 * Refetch on mount and whenever main broadcasts a managed change. Disabled
 * (an unmanaged row, ids not known yet), it loads nothing and
 * doesn't listen, so a list of agent rows adds no listeners.
 */
function useLive<T>(load: () => Promise<T>, deps: unknown[], enabled = true): { value: T | null; error: string | null; reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const run = useCallback(() => {
    if (!enabled) return;
    const id = ++seq.current;
    load().then((v) => { if (id === seq.current) { setValue(v); setError(null); } })
      .catch((err) => { if (id === seq.current) setError(errorText(err)); });
  }, [enabled, ...deps]);
  useEffect(() => {
    // New ids: the last answer was about something else, so it doesn't show meanwhile.
    setValue(null);
    setError(null);
    if (!enabled) return;
    run();
    const off = managed().onChanged(run);
    return () => { seq.current++; off(); };
  }, [run, enabled]);
  return { value, error, reload: run };
}

export function useManagedParts(kind: ManagedPartKind) {
  return useLive<ManagedPartSummary[]>(() => unwrap(managed().listParts(kind)), [kind]);
}

export function useManagedTemplates() {
  return useLive<Array<ManagedTemplate & { usedBy: number }>>(() => unwrap(managed().listTemplates()), []);
}

export function useManagedStatus(projectPath: string | undefined, agentId: string | undefined) {
  return useLive<ManagedAgentStatus | null>(
    () => (projectPath && agentId ? unwrap(managed().status(projectPath, agentId)) : Promise.resolve(null)),
    [projectPath, agentId],
    !!projectPath && !!agentId,
  );
}

/** The agent's setup, or null for an unmanaged agent (and while either id is unknown). */
export function useManagedSetup(projectPath: string | undefined, agentId: string | undefined) {
  return useLive<ManagedAgentSetup | null>(
    () => (projectPath && agentId ? unwrap(managed().getSetup(projectPath, agentId)) : Promise.resolve(null)),
    [projectPath, agentId],
    !!projectPath && !!agentId,
  );
}

/** The wildcards a block can use, with this agent's values when known. */
export const WILDCARDS: Array<{ token: string; describe: string }> = [
  { token: '@@AgentName', describe: 'agent name' },
  { token: '@@Path', describe: 'its folder' },
  { token: '@@StandbyBranch', describe: 'its branch' },
  { token: '@@BuildCommand', describe: 'build command' },
  { token: '@@TestCommand', describe: 'test command' },
  { token: '@@LintCommand', describe: 'lint command' },
];

export function partKindLabel(kind: ManagedPartKind, plural = false): string {
  if (kind === 'block') return plural ? 'Instruction blocks' : 'Instruction block';
  if (kind === 'skill') return plural ? 'Skills' : 'Skill';
  return plural ? 'MCP servers' : 'MCP server';
}

/** "Built-in", "Custom · used by 4 agents", or "<agent> only". */
export function sourceLabel(part: Pick<ManagedPartSummary, 'builtin' | 'usedBy'>, agentId?: string, agentName?: string): string {
  if (part.builtin) return part.usedBy.length > 0 ? `Built-in · ${part.usedBy.length} agent${part.usedBy.length === 1 ? '' : 's'}` : 'Built-in';
  const others = part.usedBy.filter((u) => u.agentId !== agentId).length;
  if (agentId && part.usedBy.some((u) => u.agentId === agentId) && others === 0) return `${agentName ?? 'This agent'} only`;
  const n = part.usedBy.length;
  return n === 0 ? 'Custom' : `Custom · ${n} agent${n === 1 ? '' : 's'}`;
}
