/**
 * The Connections card in Agent details (#2232): the agent's Clubhouse MCP
 * wires, from the binding store the canvas draws from, listed the way the
 * Canvases card lists boards. An agent wired both ways reads "two-way", as a
 * bidirectional canvas wire does; the orchestrator ↔ helper wires (#2225)
 * read "helper, two-way".
 *
 * Read-only until the connection tools land (#2230, #2253). `onDisconnect`
 * is the hook for them: given, each wire gets a Disconnect action.
 */

import { useMemo } from 'react';
import type { Agent } from '../../../../shared/types';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useAgentStore } from '../../../stores/agentStore';
import { CardNote, DetailsCard } from '../details/DetailsCard';
import { openAgent } from './orchestration-hooks';

export type ConnectionDirection = 'two-way' | 'to' | 'from';

export interface Connection {
  /** The other end: an agent id, or the target id for browsers, terminals and group projects. */
  id: string;
  name: string;
  kind: McpBindingEntry['targetKind'];
  direction: ConnectionDirection;
  /** The other end is one of this agent's helpers, or its orchestrator. */
  family: 'helper' | 'parent' | null;
}

const KIND_WORD: Record<McpBindingEntry['targetKind'], string> = {
  agent: 'agent',
  browser: 'browser',
  terminal: 'terminal',
  'group-project': 'group project',
};

/**
 * Every wire touching `agentId`, one row per other end. Agent wires in both
 * directions fold into one two-way row, as the canvas draws them.
 */
export function agentConnections(
  bindings: readonly McpBindingEntry[],
  agentId: string,
  family: { helperIds: ReadonlySet<string>; parentId?: string },
): Connection[] {
  const rows = new Map<string, Connection>();
  const familyOf = (id: string): Connection['family'] => (family.helperIds.has(id) ? 'helper' : id === family.parentId ? 'parent' : null);
  for (const b of bindings) {
    if (b.agentId === agentId) {
      const existing = rows.get(b.targetId);
      if (existing) {
        if (existing.direction === 'from') existing.direction = 'two-way';
        continue;
      }
      rows.set(b.targetId, {
        id: b.targetId,
        name: b.targetKind === 'group-project' ? (b.projectName || b.targetName || b.label) : (b.targetName || b.label),
        kind: b.targetKind,
        direction: 'to',
        family: b.targetKind === 'agent' ? familyOf(b.targetId) : null,
      });
    } else if (b.targetKind === 'agent' && b.targetId === agentId) {
      const existing = rows.get(b.agentId);
      if (existing) {
        if (existing.direction === 'to') existing.direction = 'two-way';
        continue;
      }
      rows.set(b.agentId, { id: b.agentId, name: b.agentName || b.agentId, kind: 'agent', direction: 'from', family: familyOf(b.agentId) });
    }
  }
  // Family first (parent, then helpers), then group projects, then the rest by name.
  const rank = (c: Connection) => (c.family === 'parent' ? 0 : c.family === 'helper' ? 1 : c.kind === 'group-project' ? 2 : 3);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The meta text after a connection's name. */
export function connectionMeta(c: Connection): string {
  if (c.kind !== 'agent') return KIND_WORD[c.kind];
  const dir = c.direction === 'two-way' ? 'two-way' : c.direction === 'to' ? 'sends to it' : 'sends to this agent';
  if (c.family === 'helper') return `helper, ${dir}`;
  if (c.family === 'parent') return `orchestrator, ${dir}`;
  return dir;
}

export function ConnectionsCard({ agent, helperIds, parentId, open, onToggle, onDisconnect }: {
  agent: Agent;
  helperIds: ReadonlySet<string>;
  parentId?: string;
  open: boolean;
  onToggle: () => void;
  /** #2253: remove a wire. Without it the card is read-only. */
  onDisconnect?: (connection: Connection) => void;
}) {
  const bindings = useMcpBindingStore((s) => s.bindings);
  const rail = useAgentStore((s) => s.agents);
  const connections = useMemo(
    () => agentConnections(bindings, agent.id, { helperIds, parentId }),
    [bindings, agent.id, helperIds, parentId],
  );

  return (
    <DetailsCard
      id="connections"
      title="Connections"
      summary={connections.length === 0 ? 'none' : String(connections.length)}
      open={open}
      onToggle={onToggle}
    >
      {connections.length === 0 ? (
        <CardNote>No Clubhouse MCP wires. Wires drawn on a canvas, and the ones between an orchestrator and its helpers, show here.</CardNote>
      ) : (
        <ul className="flex flex-col" data-testid="connections-list">
          {connections.map((c) => {
            const openable = c.kind === 'agent' && !!rail[c.id];
            return (
              <li key={c.id}>
                <div className="w-[calc(100%-28px)] ml-[22px] h-[30px] flex items-center gap-2 pl-3 pr-2.5 rounded-md hover:bg-surface-0" data-testid="connection-row">
                  <span className="text-[12.5px] text-ctp-text truncate">{c.name}</span>
                  <span className="text-xs text-ctp-overlay1 whitespace-nowrap" data-testid="connection-meta">{connectionMeta(c)}</span>
                  <span className="ml-auto flex items-center gap-2.5">
                    {onDisconnect && (
                      <button type="button" onClick={() => onDisconnect(c)} className="text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer" data-testid="connection-disconnect">
                        Disconnect
                      </button>
                    )}
                    {openable && (
                      <button type="button" onClick={() => openAgent(rail[c.id].projectId, c.id)} className="text-xs text-ctp-accent hover:underline cursor-pointer" data-testid="connection-open">
                        Open
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DetailsCard>
  );
}
