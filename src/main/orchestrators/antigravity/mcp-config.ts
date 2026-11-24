/**
 * Clubhouse MCP delivery for Antigravity (#3793, #3794).
 *
 * Terminal: a `clubhouse` stdio entry is merged into
 * `<worktree>/.agents/mcp_config.json` (https://antigravity.google/docs/mcp/).
 * Managed delivery (#3792) merges its servers into the same file through
 * mergeAntigravityMcpServers; this module is the only writer of that file.
 *
 * Edits, ownership receipts, path safety and the concurrency boundary are
 * workspace-json.ts's: entries are owned members of the `mcpServers` object.
 *
 * The entry holds neither the nonce nor the agent id (#2222): the bridge reads
 * CLUBHOUSE_HOOK_NONCE, CLUBHOUSE_AGENT_ID and CLUBHOUSE_MCP_PORT from the
 * environment agy passes it. Whether agy passes its environment to stdio
 * children is undocumented (#3802 V3); if it doesn't, the bridge can't
 * authenticate and the identity fence below refuses the start.
 *
 * Chat: the bridge goes to `agy acp` as an ACP stdio server with explicit
 * `env`, over the ACP pipe only (https://antigravity.google/docs/ide/extensions/acp/).
 * A server answering under the name `clubhouse` is never trusted on its name:
 * only a nonce-verified handshake for this launch counts (awaitAuthenticatedBridge).
 */
import * as path from 'path';
import { getBridgeScriptPath, CLUBHOUSE_NONCE_ENV } from '../../services/clubhouse-mcp/injection';
import { ANTIGRAVITY_BRIDGE_SERVER_NAME, ANTIGRAVITY_PATHS } from '../../../shared/providers/antigravity';
import type { McpServerDef } from '../../../shared/types';
import { readGlobalMcpServerNames } from './profile-reads';
import {
  AntigravityWorkspaceError, fail, finalText, insertLines, keysOf, memberLine, sha256, shapeProblem, slotOf, stripOwned, transact,
  type AntigravityWorkspaceErrorCode, type CommittedOwnership, type FileOptions as WorkspaceFileOptions,
} from './workspace-json';

export { fileReceiptStore, memoryReceiptStore, setAntigravityReceiptStore, type ReceiptStore } from './workspace-json';

export const CLUBHOUSE_MCP_SERVER_NAME = ANTIGRAVITY_BRIDGE_SERVER_NAME;

export function antigravityWorkspaceMcpPath(worktree: string): string {
  return path.join(worktree, ...ANTIGRAVITY_PATHS.mcpConfig.split('/'));
}

export function isAntigravityWorkspaceMcpPath(file: string): boolean {
  const resolved = path.resolve(file);
  return path.basename(resolved) === 'mcp_config.json' && path.basename(path.dirname(resolved)) === ANTIGRAVITY_PATHS.configDir;
}

/** Why a merge refused; every code means "do not launch with this config". */
export type AntigravityMcpConfigErrorCode = AntigravityWorkspaceErrorCode;
/** The workspace-json error: refusals from the MCP file and hooks file share one class. */
export const AntigravityMcpConfigError = AntigravityWorkspaceError;
export type AntigravityMcpConfigError = AntigravityWorkspaceError;

const MCP = ANTIGRAVITY_PATHS.mcpConfig;
const SERVERS = 'mcpServers';
const BRIDGE_SLOT = slotOf(SERVERS, ANTIGRAVITY_BRIDGE_SERVER_NAME);
const isManagedSlot = (slot: string): boolean => slot !== BRIDGE_SLOT && (JSON.parse(slot) as [string | null, string])[0] === SERVERS;

// ── Entry lines ────────────────────────────────────────────────────────────

/** The bridge line. No env: no nonce, no identity (see top). */
export function bridgeMemberText(bridgeScriptPath: string = getBridgeScriptPath()): string {
  return `"${CLUBHOUSE_MCP_SERVER_NAME}": {"command": "node", "args": [${JSON.stringify(bridgeScriptPath)}]}`;
}

/** A managed server line, in the one form Clubhouse writes. */
export function managedMemberText(name: string, def: McpServerDef): string {
  return memberLine(name, JSON.stringify(def));
}

/** The file Clubhouse writes when there is none, before its lines go in. */
export const CREATED_SKELETON = '{\n  "mcpServers": {}\n}\n';

// ── Collision check ────────────────────────────────────────────────────────

/** The reason a configured `clubhouse` server blocks the start, or undefined. Pure. */
export function findClubhouseCollision(projectServers: Record<string, unknown> | readonly string[] | undefined): string | undefined {
  if (!projectServers) return undefined;
  const names = Array.isArray(projectServers) ? projectServers : Object.keys(projectServers);
  return names.includes(CLUBHOUSE_MCP_SERVER_NAME)
    ? 'The project configures an MCP server named "clubhouse", which Antigravity would run instead of the Clubhouse bridge. Rename it, then start the agent again.'
    : undefined;
}

export type CheckResult = { ok: true } | { ok: false; code: AntigravityMcpConfigErrorCode; reason: string };

/**
 * Refuse when any readable config outside the workspace file defines
 * `clubhouse`: the global `~/.gemini/config/mcp_config.json` (names only, read
 * only) or the project's own server list. An unparsable global file refuses
 * too, since the check can't pass. Plugin servers can't all be listed from
 * documented files; the identity fence is the backstop for those.
 */
export async function checkClubhouseCollisions(input: { home?: string; projectServers?: Record<string, unknown> | readonly string[] }): Promise<CheckResult> {
  const project = findClubhouseCollision(input.projectServers);
  if (project) return { ok: false, code: 'collision', reason: project };
  const global = await readGlobalMcpServerNames(input.home);
  if (global.status === 'unreadable') {
    return { ok: false, code: 'unparsable', reason: `Your Antigravity MCP config (~/.gemini/config/mcp_config.json) could not be checked for a "clubhouse" server: ${global.reason}. Fix the file, then start the agent again.` };
  }
  if (global.status === 'ok' && global.names.includes(CLUBHOUSE_MCP_SERVER_NAME)) {
    return { ok: false, code: 'collision', reason: 'Your Antigravity MCP config (~/.gemini/config/mcp_config.json) defines a server named "clubhouse", which Antigravity would run instead of the Clubhouse bridge. Rename it, then start the agent again.' };
  }
  return { ok: true };
}

// ── File operations ────────────────────────────────────────────────────────

export interface FileOptions extends WorkspaceFileOptions {
  bridgeScriptPath?: string;
}

export interface MergeOutcome { file: string; created: boolean }

const containersAfter = (owned: CommittedOwnership, removed: string[], added: boolean): string[] => {
  const kept = owned.containers.filter((c) => !removed.includes(c));
  return added && !kept.includes(SERVERS) ? [...kept, SERVERS] : kept;
};

const namesOf = (text: string): string[] => keysOf(text, SERVERS);

/**
 * Merge the bridge line into `<worktree>/.agents/mcp_config.json`, replacing
 * a bridge line a committed receipt shows Clubhouse wrote earlier. Call
 * `configPipeline.snapshotFile` on the same path first, so stop and app quit
 * clean it up. `created` tells the caller to add the path to
 * `.git/info/exclude`. Throws AntigravityMcpConfigError, leaving the file as
 * it was, on any refusal: the agent must not start.
 */
export async function mergeAntigravityWorkspaceMcp(worktree: string, options: FileOptions = {}): Promise<MergeOutcome> {
  const line = bridgeMemberText(options.bridgeScriptPath);
  const { file, created } = await transact(worktree, MCP, options, (current, owned) => {
    const stripped = stripOwned(current ?? CREATED_SKELETON, owned, (slot) => slot === BRIDGE_SLOT);
    if (stripped.ok === false) return fail(MCP, stripped.code, stripped.reason);
    if (namesOf(stripped.text).includes(CLUBHOUSE_MCP_SERVER_NAME)) {
      // No adoption from matching bytes (a start interrupted before its receipt was committed lands here too).
      return fail(MCP, 'collision', 'a "clubhouse" server that Clubhouse has no record of writing is configured. If an interrupted Clubhouse start left it, remove that entry');
    }
    const next = insertLines(stripped.text, SERVERS, [line]);
    if (next.ok === false) return fail(MCP, next.code, next.reason);
    return { next: next.text, owned: {
      ...owned,
      created: owned.created || current === null,
      members: { ...owned.members, [BRIDGE_SLOT]: [sha256(line)] },
      containers: containersAfter(owned, stripped.removedContainers, next.addedContainer),
    } };
  });
  return { file, created };
}

/**
 * Managed delivery's servers (#3792) in the same file. Lines a committed
 * receipt shows Clubhouse delivered come out first, so servers dropped from
 * the setup go away, across app restarts too; an entry the person wrote or
 * edited is never touched, and a wanted name it already uses is refused.
 * Throws AntigravityMcpConfigError on any refusal, leaving the file as it was.
 */
export async function mergeAntigravityMcpServers(
  worktree: string,
  servers: Record<string, McpServerDef>,
  options: FileOptions = {},
): Promise<MergeOutcome> {
  if (CLUBHOUSE_MCP_SERVER_NAME in servers) fail(MCP, 'collision', 'a managed server may not be named "clubhouse"');
  const lines = Object.keys(servers).sort().map((name) => [name, managedMemberText(name, servers[name])] as const);
  const { file, created } = await transact(worktree, MCP, options, (current, owned) => {
    if (current === null && lines.length === 0) return 'unchanged';
    const stripped = stripOwned(current ?? CREATED_SKELETON, owned, isManagedSlot);
    if (stripped.ok === false) return fail(MCP, stripped.code, stripped.reason);
    const names = namesOf(stripped.text);
    const taken = lines.map(([n]) => n).filter((n) => names.includes(n));
    if (taken.length) fail(MCP, 'ambiguous_ownership', `MCP server ${taken.map((n) => JSON.stringify(n)).join(', ')} is already configured and Clubhouse has no record of writing it`);
    const next = insertLines(stripped.text, SERVERS, lines.map(([, l]) => l));
    if (next.ok === false) return fail(MCP, next.code, next.reason);
    const members = Object.fromEntries(Object.entries(owned.members).filter(([slot]) => !isManagedSlot(slot)));
    for (const [n, l] of lines) members[slotOf(SERVERS, n)] = [sha256(l)];
    const nextOwned: CommittedOwnership = {
      ...owned,
      created: owned.created || current === null,
      members,
      containers: containersAfter(owned, stripped.removedContainers, next.addedContainer),
    };
    const text = finalText(next.text, nextOwned, CREATED_SKELETON);
    return text === current ? 'unchanged' : { next: text, owned: nextOwned };
  });
  return { file, created };
}

/**
 * A plugin template's servers, written at agent creation like a `.mcp.json`
 * template entry: they become part of the person's config, with no receipt,
 * so no later Clubhouse cleanup removes them. A name already in use is refused.
 */
export async function addAntigravityTemplateMcpServers(
  worktree: string,
  servers: Record<string, McpServerDef>,
  options: FileOptions = {},
): Promise<MergeOutcome> {
  if (CLUBHOUSE_MCP_SERVER_NAME in servers) fail(MCP, 'collision', 'a template server may not be named "clubhouse"');
  const names = Object.keys(servers).sort();
  const { file, created } = await transact(worktree, MCP, options, (current, owned) => {
    if (names.length === 0) return 'unchanged';
    const base = current ?? CREATED_SKELETON;
    const problem = shapeProblem(base, SERVERS);
    if (problem) return fail(MCP, 'unparsable', problem);
    const taken = names.filter((n) => namesOf(base).includes(n));
    if (taken.length) fail(MCP, 'ambiguous_ownership', `MCP server ${taken.map((n) => JSON.stringify(n)).join(', ')} is already configured`);
    const next = insertLines(base, SERVERS, names.map((n) => managedMemberText(n, servers[n])));
    if (next.ok === false) return fail(MCP, next.code, next.reason);
    // Not owned: the template entries (and any object added for them) are the person's now.
    return { next: next.text, owned };
  });
  return { file, created };
}

export type RestoreResult = 'clean' | 'restored' | 'deleted' | { repair: string };

/**
 * Take the bridge line out of the workspace file, from its current bytes and
 * the committed receipt. Edits the person made while the agent ran are kept;
 * a file Clubhouse created and nobody touched is deleted. A `clubhouse` entry
 * without a committed receipt, a link, or bytes that don't parse are left as
 * they are and reported for repair. Managed servers are delivery's and stay.
 */
export async function restoreAntigravityWorkspaceMcp(file: string, options: FileOptions = {}): Promise<RestoreResult> {
  const worktree = path.dirname(path.dirname(path.resolve(file)));
  try {
    let leftover = false;
    const result = await transact(worktree, MCP, options, (current, owned) => {
      if (current === null) return 'unchanged';
      const stripped = stripOwned(current, owned, (slot) => slot === BRIDGE_SLOT);
      if (stripped.ok === false) return fail(MCP, stripped.code, stripped.reason);
      leftover = namesOf(stripped.text).includes(CLUBHOUSE_MCP_SERVER_NAME);
      if (stripped.removed.length === 0) return 'unchanged';
      const members = { ...owned.members };
      delete members[BRIDGE_SLOT];
      const nextOwned: CommittedOwnership = { ...owned, members, containers: containersAfter(owned, stripped.removedContainers, false) };
      return { next: finalText(stripped.text, nextOwned, CREATED_SKELETON), owned: nextOwned };
    });
    if (leftover) return { repair: 'a "clubhouse" server that Clubhouse has no record of writing is still configured' };
    return result.deleted ? 'deleted' : result.changed ? 'restored' : 'clean';
  } catch (err) {
    if (err instanceof AntigravityWorkspaceError) return { repair: err.message };
    throw err;
  }
}

// ── ACP mcpServers (chat) ──────────────────────────────────────────────────

/** ACP v1 `McpServerStdio` (https://agentclientprotocol.com/protocol/session-setup). */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export type AcpMcpServer = AcpStdioMcpServer | AcpHttpMcpServer;

/**
 * The bridge as an ACP stdio server. ACP makes `env` explicit, so the
 * launch's identity and nonce go here; this value travels only over the ACP
 * stdio pipe. Never put it in argv, a file or a log line.
 */
export function buildAntigravityAcpBridgeServer(input: { agentId: string; nonce: string; mcpPort: number; bridgeScriptPath?: string }): AcpStdioMcpServer {
  if (!input.agentId) throw new Error('Antigravity ACP bridge: agentId is required');
  if (!input.nonce) throw new Error('Antigravity ACP bridge: nonce is required');
  if (!Number.isInteger(input.mcpPort) || input.mcpPort <= 0 || input.mcpPort > 65535) throw new Error('Antigravity ACP bridge: invalid MCP port');
  return {
    name: CLUBHOUSE_MCP_SERVER_NAME,
    command: 'node',
    args: [input.bridgeScriptPath ?? getBridgeScriptPath()],
    env: [
      { name: 'CLUBHOUSE_AGENT_ID', value: input.agentId },
      { name: CLUBHOUSE_NONCE_ENV, value: input.nonce },
      { name: 'CLUBHOUSE_MCP_PORT', value: String(input.mcpPort) },
    ],
  };
}

const nameValues = (v: unknown): Array<{ name: string; value: string }> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string').map(([name, value]) => ({ name, value }))
    : [];

export type AcpPlan = { ok: true; servers: AcpMcpServer[]; notices: string[] } | { ok: false; reason: string };

/**
 * Servers for ACP `session/new`, `load` and `resume`: the bridge first, then
 * the project's stdio servers with only their declared env, then its HTTP
 * servers only when `initialize` advertised `mcpCapabilities.http`.
 * Others are left to the workspace file with a notice. A project server named
 * `clubhouse` refuses the start.
 */
export function planAntigravityAcpMcpServers(input: { bridge: AcpStdioMcpServer; projectServers?: Record<string, unknown>; mcpCapabilities?: { http?: boolean; sse?: boolean } }): AcpPlan {
  const collision = findClubhouseCollision(input.projectServers);
  if (collision) return { ok: false, reason: collision };
  const servers: AcpMcpServer[] = [input.bridge];
  const notices: string[] = [];
  for (const [name, raw] of Object.entries(input.projectServers ?? {})) {
    const def = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (def && typeof def.command === 'string' && def.command) {
      const args = Array.isArray(def.args) && def.args.every((a) => typeof a === 'string') ? def.args as string[] : [];
      servers.push({ name, command: def.command, args, env: nameValues(def.env) });
      continue;
    }
    const url = def && (typeof def.url === 'string' ? def.url : typeof def.serverUrl === 'string' ? def.serverUrl : undefined);
    if (def && url && (def.type === undefined || def.type === 'http')) {
      if (input.mcpCapabilities?.http) servers.push({ type: 'http', name, url, headers: nameValues(def.headers) });
      else notices.push(`MCP server "${name}" uses HTTP, which this Antigravity version doesn't accept from Clubhouse; it is available only from the workspace config.`);
      continue;
    }
    notices.push(`MCP server "${name}" has a type Clubhouse can't pass to Antigravity; it is available only from the workspace config.`);
  }
  return { ok: true, servers, notices };
}

// ── Identity fence ─────────────────────────────────────────────────────────

/**
 * How long a launch has for its bridge to authenticate. Unmeasured: whether
 * agy starts stdio MCP servers at launch or on first use, and whether it
 * passes its environment to them, is undocumented (#3802 V3). Until V3 runs,
 * a real binary may fail this fence on every start; that is the fail-closed outcome.
 */
export const ANTIGRAVITY_BRIDGE_AUTH_DEADLINE_MS = 60_000;

/** What the fence reads; the caller passes the bridge server's and registry's functions. */
export interface BridgeIdentityDeps {
  /** The registry's current nonce for the agent (agent-registry getAgentNonce). */
  getAgentNonce(agentId: string): string | undefined;
  /** The handshake whose admitted nonce still matches (bridge-server getCurrentAgentConnection). */
  getCurrentAgentConnection(agentId: string): { connectedAt: number } | null;
  /** connection-events onAgentMcpConnected. */
  onAgentMcpConnected(listener: (agentId: string) => void): () => void;
  /** agentRegistry.onAuthChange. */
  onAuthChange(listener: (agentId: string) => void): () => void;
}

export type FenceResult = { ok: true; connectedAt: number } | { ok: false; reason: 'timeout' | 'nonce_changed' | 'aborted' };

export const FENCE_REASONS: Record<Exclude<FenceResult, { ok: true }>['reason'], string> = {
  timeout: 'The Clubhouse MCP bridge did not authenticate for this launch in time, so the agent was not given Clubhouse tools.',
  nonce_changed: 'The agent was restarted or stopped before its Clubhouse MCP bridge authenticated.',
  aborted: 'The start was cancelled before the Clubhouse MCP bridge authenticated.',
};

/**
 * Resolve ok only once the bridge server has recorded a nonce-verified
 * handshake for this agent, admitted under `expectedNonce` (this launch's)
 * and made at or after `launchedAt`. A server answering as `clubhouse` that
 * never presents the nonce never resolves ok. Holds no nonce after it settles.
 */
export function awaitAuthenticatedBridge(
  input: { agentId: string; expectedNonce: string; launchedAt: number; deadlineMs: number; signal?: AbortSignal },
  deps: BridgeIdentityDeps,
): Promise<FenceResult> {
  return new Promise<FenceResult>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (result: FenceResult): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(result);
    };
    const check = (): void => {
      if (deps.getAgentNonce(input.agentId) !== input.expectedNonce) return finish({ ok: false, reason: 'nonce_changed' });
      const conn = deps.getCurrentAgentConnection(input.agentId);
      if (conn && conn.connectedAt >= input.launchedAt) finish({ ok: true, connectedAt: conn.connectedAt });
    };
    if (!input.expectedNonce) return finish({ ok: false, reason: 'nonce_changed' });
    if (input.signal?.aborted) return finish({ ok: false, reason: 'aborted' });
    const onAbort = () => finish({ ok: false, reason: 'aborted' });
    input.signal?.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => input.signal?.removeEventListener('abort', onAbort));
    cleanups.push(deps.onAgentMcpConnected((id) => { if (id === input.agentId) check(); }));
    cleanups.push(deps.onAuthChange((id) => { if (id === input.agentId) check(); }));
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), Math.max(0, input.deadlineMs));
    cleanups.push(() => clearTimeout(timer));
    check();
  });
}
