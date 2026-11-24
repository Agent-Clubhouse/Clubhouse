/**
 * The Antigravity ACP chat driver (#3797): the provider-neutral ACP driver
 * (../acp) with Antigravity's launch spec, plus the Clubhouse MCP bridge
 * passed with an explicit environment.
 *
 * Whether `agy` hands its own environment to the stdio MCP servers it starts
 * isn't documented (design V3), so the bridge entry carries its agent id,
 * nonce and port in the ACP `env` field, which the ACP spec makes explicit.
 * That entry travels only over the ACP stdio pipe: never argv, a file or a log.
 *
 * Not registered here: the integrator registers it once its gates close
 * (src/main/chat/acp/README.md, "Before registration").
 */

import type { ChatDriver, ChatDriverProbe, ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { ANTIGRAVITY_BRIDGE_SERVER_NAME } from '../../../shared/providers/antigravity';
import type { AcpLog } from '../acp/connection';
import { createAcpChatDriver, type AcpDriverDeps } from '../acp/driver';
import { antigravityAcpLaunchSpec, type AntigravityLaunchOptions } from './launch';
import type { AntigravityAcpMcp, AcpMcpServer } from './mcp';

export interface AntigravityAcpDriverDeps extends AcpDriverDeps, AntigravityLaunchOptions {
  /** The bridge builder and server planner (H2's mcp-config module). */
  mcp: AntigravityAcpMcp;
}

/** A start refused before anything was launched; the message says why. */
export class AntigravityChatStartError extends Error {}

export function createAntigravityAcpDriver(deps: AntigravityAcpDriverDeps): ChatDriver {
  const inner = createAcpChatDriver(antigravityAcpLaunchSpec(deps), deps);
  return {
    id: inner.id,
    provider: inner.provider,
    ...(inner.optIn && { optIn: true }),
    probe: (binaryPath: string, env?: Record<string, string>, opts?: { commandPrefix?: string }): Promise<ChatDriverProbe> => inner.probe(binaryPath, env, opts),
    start: async (opts: ChatDriverStartOptions): Promise<ChatDriverSession> => {
      // No HTTP endpoints: the docs say HTTP MCP servers need `--process-per-session`,
      // which this launch doesn't use, so the bridge goes as its stdio entry.
      const { mcpHttpEndpoints: _http, ...rest } = opts;
      return inner.start({ ...rest, mcpServers: antigravityMcpServers(opts, deps.mcp, deps.log) });
    },
  };
}

/**
 * The start's MCP servers with the bridge rebuilt for ACP. Refuses the start
 * when the bridge isn't there (the Clubhouse MCP always runs) or a project
 * server claims the bridge's name: Antigravity documents that on a name
 * collision "the server that is already running keeps it", so a server under
 * that name is never trusted to be the bridge.
 */
export function antigravityMcpServers(opts: Pick<ChatDriverStartOptions, 'agentId' | 'env' | 'mcpServers'>, mcp: AntigravityAcpMcp, log?: AcpLog): Record<string, unknown> {
  const { [ANTIGRAVITY_BRIDGE_SERVER_NAME]: bridgeDef, ...projectServers } = opts.mcpServers ?? {};
  const nonce = opts.env?.CLUBHOUSE_HOOK_NONCE;
  const port = Number(opts.env?.CLUBHOUSE_MCP_PORT);
  if (!bridgeDef || !nonce || !Number.isInteger(port) || port <= 0) {
    throw new AntigravityChatStartError('The Clubhouse MCP bridge is not ready, so Antigravity chat did not start. Retry chat, or open the agent in the terminal.');
  }
  const bridge = mcp.buildAntigravityAcpBridgeServer({ agentId: opts.agentId, nonce, mcpPort: port });
  // HTTP servers need `--process-per-session` (ACP guide), which this launch
  // doesn't use, so the planner leaves them out with a notice.
  const plan = mcp.planAntigravityAcpMcpServers({ bridge, projectServers, mcpCapabilities: { http: false, sse: false } });
  if (!plan.ok) throw new AntigravityChatStartError(plan.reason);
  for (const notice of plan.notices) log?.('warn', notice);
  return Object.fromEntries(plan.servers.map((s) => [s.name, toServerEntry(s)]));
}

/** Back to the MCP entry shape the neutral driver maps (`env`/`headers` as records). */
function toServerEntry(server: AcpMcpServer): Record<string, unknown> {
  const record = (pairs: Array<{ name: string; value: string }>) => Object.fromEntries(pairs.map((p) => [p.name, p.value]));
  if ('type' in server) return { type: server.type, url: server.url, headers: record(server.headers) };
  return { command: server.command, args: server.args, env: record(server.env) };
}
