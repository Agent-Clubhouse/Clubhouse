import { useEffect, useState } from 'react';
import type { Agent, AgentMcpConnection } from '../../../../shared/types';
import type { ChatMcpServer, ChatMcpServerStatus } from '../../../../shared/chat';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
import { CardNote, DetailsCard } from './DetailsCard';

/**
 * The MCP servers card (#2093). It lists what the agent is connected to: the
 * servers the CLI reported at session start (Claude chat), or else the
 * Clubhouse MCP when the agent has finished its handshake. The Clubhouse MCP
 * row carries the agent's wires. Servers set in Clubhouse that the agent
 * isn't known to have loaded are listed apart, as configured.
 */

/** The server name Clubhouse injects its own MCP under (clubhouse-mcp/injection.ts). */
export const CLUBHOUSE_MCP = 'clubhouse';

export type McpRowStatus = ChatMcpServerStatus | 'configured';

export interface McpRow {
  name: string;
  status: McpRowStatus;
  /** Tools the Clubhouse MCP gave the agent, when known. */
  toolCount?: number;
}

const STATUS_WORD: Record<McpRowStatus, string> = {
  connected: 'Connected',
  pending: 'Connecting',
  needs_auth: 'Needs sign-in',
  failed: 'Failed',
  disabled: 'Off',
  unknown: 'Unknown',
  configured: 'Configured',
};

const ORDER: McpRowStatus[] = ['connected', 'needs_auth', 'pending', 'failed', 'unknown', 'disabled', 'configured'];

/**
 * The live rows and the configured-only names. `live` is the CLI's list (null
 * when the runtime doesn't report one); `clubhouse` is the agent's Clubhouse
 * MCP connection for its current run.
 */
export function mcpRows(live: ChatMcpServer[] | null, clubhouse: AgentMcpConnection | null, configured: string[]): { rows: McpRow[]; configuredOnly: string[] } {
  const rows: McpRow[] = (live ?? []).map((s) => ({ name: s.name, status: s.status }));
  if (clubhouse) {
    const toolCount = clubhouse.toolCount ?? undefined;
    const row = rows.find((r) => r.name === CLUBHOUSE_MCP);
    // The bridge saw the handshake, so it's connected even if the CLI listed it as pending at start.
    if (row) Object.assign(row, { status: 'connected', toolCount });
    else rows.unshift({ name: CLUBHOUSE_MCP, status: 'connected', toolCount });
  }
  rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const configuredOnly = configured.filter((id) => !rows.some((r) => r.name === id));
  return { rows, configuredOnly };
}

/** The one-line answer: "3 connected · 1 needs sign-in · 9 not connected", then anything only configured. */
export function mcpSummary(rows: McpRow[], configuredOnly: string[]): string {
  const connected = rows.filter((r) => r.status === 'connected').length;
  const signIn = rows.filter((r) => r.status === 'needs_auth').length;
  const others = rows.length - connected - signIn;
  const parts: string[] = [];
  if (connected) parts.push(`${connected} connected`);
  if (signIn) parts.push(`${signIn} ${signIn === 1 ? 'needs' : 'need'} sign-in`);
  if (others) parts.push(`${others} not connected`);
  if (configuredOnly.length) parts.push(`${configuredOnly.length} configured`);
  return parts.length ? parts.join(' · ') : 'none';
}

/**
 * The agent's Clubhouse MCP connection for its current run: null until it
 * finishes the handshake after it started, or when it isn't running here.
 */
export function useClubhouseMcpConnection(agent: Agent, spawnedAt: number | undefined, refreshKey: unknown): AgentMcpConnection | null {
  const [conn, setConn] = useState<AgentMcpConnection | null>(null);
  const live = agent.status === 'running' && !isRemoteProjectId(agent.projectId);
  useEffect(() => { setConn(null); }, [agent.id, live, spawnedAt]);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      Promise.resolve().then(() => window.clubhouse.mcpBinding.getAgentConnection(agent.id)).then(
        (c) => { if (alive && current === request) setConn(c && (spawnedAt === undefined || c.connectedAt >= spawnedAt) ? c : null); },
        // telemetry-exempt: with the Clubhouse MCP off everywhere its handlers aren't registered; the card lists no connection.
        () => { if (alive && current === request) setConn(null); },
      );
    };
    // Subscribe before the read so a handshake during the request isn't missed.
    const unsubscribe = window.clubhouse.mcpBinding.onAgentConnectionChanged((agentId) => {
      if (agentId === agent.id) refresh();
    });
    refresh();
    return () => { alive = false; unsubscribe(); };
  }, [agent.id, live, spawnedAt, refreshKey]);
  return conn;
}

const EMPTY_BINDINGS: McpBindingEntry[] = [];

function useAgentBindings(agentId: string): McpBindingEntry[] {
  const all = useMcpBindingStore((s) => s.bindings);
  const mine = all.filter((b) => b.agentId === agentId);
  return mine.length ? mine : EMPTY_BINDINGS;
}

const KIND_WORD: Record<McpBindingEntry['targetKind'], string> = {
  agent: 'agent',
  browser: 'browser',
  terminal: 'terminal',
  'group-project': 'group project',
};

function StatusMark({ status }: { status: McpRowStatus }) {
  const fill = status === 'connected' ? 'bg-ctp-success'
    : status === 'needs_auth' ? 'bg-ctp-warning'
    : status === 'failed' ? 'bg-ctp-error'
    : null;
  return fill
    ? <span className={`w-2 h-2 rounded-full flex-shrink-0 ${fill}`} aria-hidden="true" />
    : <span className="w-2 h-2 rounded-full border border-ctp-overlay0 flex-shrink-0" aria-hidden="true" />;
}

function ServerRow({ row }: { row: McpRow }) {
  const detail = row.toolCount !== undefined ? `${STATUS_WORD[row.status]} · ${row.toolCount} ${row.toolCount === 1 ? 'tool' : 'tools'}` : STATUS_WORD[row.status];
  return (
    <li className="h-7 flex items-center gap-2 pl-[33px] pr-3.5 text-[12.5px] text-ctp-text" data-testid="details-mcp-row" data-status={row.status}>
      <StatusMark status={row.status} />
      <span className="truncate font-medium">{row.name === CLUBHOUSE_MCP ? 'Clubhouse' : row.name}</span>
      <span className="ml-auto text-xs text-ctp-overlay1 whitespace-nowrap">{detail}</span>
    </li>
  );
}

export function McpCard({ agent, live, spawnedAt, refreshKey, open, onToggle }: {
  agent: Agent;
  /** The CLI's MCP servers (chat), or null when the runtime doesn't report them. */
  live: ChatMcpServer[] | null;
  spawnedAt: number | undefined;
  refreshKey: unknown;
  open: boolean;
  onToggle: () => void;
}) {
  // Opening the card checks again, so a handshake since the last turn shows up.
  const clubhouse = useClubhouseMcpConnection(agent, spawnedAt, `${String(refreshKey)}:${open}`);
  const bindings = useAgentBindings(agent.id);
  const { rows, configuredOnly } = mcpRows(live, clubhouse, agent.mcpIds ?? []);
  const hasClubhouse = rows.some((r) => r.name === CLUBHOUSE_MCP);

  let note: string | null = null;
  if (rows.length === 0 && configuredOnly.length === 0) {
    note = agent.status === 'running' ? 'This agent isn’t connected to any MCP servers.' : 'MCP servers show here while the agent is running.';
  } else if (live === null && configuredOnly.length > 0) {
    note = 'This runtime doesn’t report which of these it loaded.';
  } else if (live === null) {
    note = 'This runtime doesn’t report its other MCP servers.';
  }

  return (
    <DetailsCard id="mcp" title="MCP servers" summary={mcpSummary(rows, configuredOnly)} open={open} onToggle={onToggle}>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((r) => <ServerRow key={r.name} row={r} />)}
        </ul>
      )}
      {hasClubhouse && bindings.length > 0 && (
        <ul className="flex flex-col pb-1" aria-label="Wires" data-testid="details-mcp-wires">
          {bindings.map((b) => (
            <li key={b.targetId} className="h-6 flex items-center gap-2 pl-[49px] pr-3.5 text-xs text-ctp-subtext1">
              <span className="truncate">Wired to {b.targetName ?? b.label}</span>
              <span className="ml-auto text-ctp-overlay1 whitespace-nowrap">{KIND_WORD[b.targetKind] ?? b.targetKind}</span>
            </li>
          ))}
        </ul>
      )}
      {configuredOnly.length > 0 && (
        <>
          <p className="pr-3.5 pl-[33px] pt-1.5 pb-0.5 text-xs text-ctp-overlay1">Set in Clubhouse</p>
          <ul className="flex flex-col" data-testid="details-mcp-configured">
            {configuredOnly.map((id) => <ServerRow key={id} row={{ name: id, status: 'configured' }} />)}
          </ul>
        </>
      )}
      {note && <CardNote>{note}</CardNote>}
    </DetailsCard>
  );
}
