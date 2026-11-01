/**
 * Live model lists from each CLI's own handshake (#2569). Every probe spawns
 * the user's CLI, completes the handshake, reads the model list and kills the
 * process. None sends a prompt, so none costs tokens:
 *
 * - Claude Code: the stream-json control `initialize` reply's `models[]`.
 * - Codex: app-server `initialize`, then `model/list`.
 * - Copilot CLI: ACP `initialize`, then `session/new`, whose result lists the
 *   models; the session is closed unprompted, and the folder Copilot made
 *   for it is removed (removeUnpromptedCopilotSession).
 *
 * The protocol clients are the chat drivers' own (ClaudeStreamTransport,
 * CodexAppServerClient, AcpSession). The parsers are exported for the
 * recorded fixtures in adapters/__fixtures__/models and acp/copilot-cli.
 */

import type { ChildProcess } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ClaudeStreamTransport } from '../chat/claude/stream-transport';
import { initializedFromWire } from '../chat/claude/normalizer';
import { spawnClaude } from '../chat/claude/spawn';
import { killStructuredChild, resolveStructuredSpawn } from './adapters/structured-spawn';
import { CodexAppServerClient } from './adapters/codex-app-server-client';
import type { Model } from './adapters/codex-protocol';
import { AcpSession, type AcpAgentProfile, type AcpSessionState } from './adapters/acp-session';
import { sessionChoices } from './adapters/acp-chat-mapper';
import { copilotSessionStateDir, resolveCopilotAcpSpawn, selectAcpProfile } from './adapters/copilot-acp';
import type { ModelInfo } from './types';
import { buildCliSpawnEnv } from '../util/shell';

export interface ModelProbeContext {
  binary: string;
  cwd: string;
  /** Profile env to layer over the login shell's (CLAUDE_CONFIG_DIR, CODEX_HOME…). */
  env?: Record<string, string>;
  /** Kills the probe's process when aborted. */
  signal: AbortSignal;
  /** Backstop for each request, in case the abort is never seen. */
  timeoutMs: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_ENTRY: ModelInfo = { id: 'default', label: 'Default' };

/** Codex and Copilot have no `default` entry of their own; Clubhouse's means "don't pass --model". */
function withDefaultEntry(models: ModelInfo[]): ModelInfo[] {
  return models.some((m) => m.id === DEFAULT_ENTRY.id) ? models : [{ ...DEFAULT_ENTRY }, ...models];
}

function onAbort(signal: AbortSignal, fn: () => void): () => void {
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

// ── Claude Code ──────────────────────────────────────────────────────────

/** Models from Claude's `initialize` control response (the inner `response` object). */
export function parseClaudeInitializeModels(response: Record<string, unknown>): ModelInfo[] | null {
  const event = initializedFromWire(response);
  if (event.kind !== 'initialized') return null;
  const models = event.models
    .filter((m) => m.value)
    .map((m): ModelInfo => ({
      id: m.value,
      label: m.displayName || m.value,
      ...(m.description && { description: m.description }),
      ...(m.value === 'default' && { isDefault: true }),
      ...(m.efforts.length > 0 && { efforts: m.efforts }),
      ...(m.resolvedModel && m.resolvedModel !== m.value && { resolvedId: m.resolvedModel }),
    }));
  return models.length > 0 ? models : null;
}

export async function probeClaudeModels(ctx: ModelProbeContext): Promise<ModelInfo[] | null> {
  let child: ChildProcess | undefined;
  const transport = new ClaudeStreamTransport(
    {
      binary: ctx.binary,
      cwd: ctx.cwd,
      permissionMode: 'default',
      includePartialMessages: false,
      env: ctx.env,
      signal: ctx.signal,
      log: ctx.log,
    },
    (opts) => (child = spawnClaude(opts)),
  );
  try {
    // Spawns `claude -p` in stream-json mode and completes `initialize`; no user message is written.
    await transport.start();
    for await (const event of transport.events) {
      if (event.kind === 'initialized') return parseClaudeInitializeModels(event.raw);
      if (event.kind === 'session_ended') return null;
    }
    return null;
  } finally {
    if (child) await killStructuredChild(child);
  }
}

// ── Codex ────────────────────────────────────────────────────────────────

/** Models from Codex app-server `model/list` pages, in Codex's order. */
export function parseCodexModelList(data: ReadonlyArray<Partial<Model>>): ModelInfo[] | null {
  const models = data
    .map((m): ModelInfo | null => {
      const id = m.model || m.id;
      if (!id) return null;
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter(Boolean);
      return {
        id,
        label: m.displayName || id,
        ...(m.description && { description: m.description }),
        ...(m.isDefault && { isDefault: true }),
        ...(efforts.length > 0 && { efforts }),
        ...(m.hidden && { hidden: true }),
      };
    })
    .filter((m): m is ModelInfo => m !== null);
  return models.length > 0 ? withDefaultEntry(models) : null;
}

/** model/list pages followed at most, so a server that keeps returning a cursor can't hold the probe. */
const CODEX_MAX_PAGES = 5;

export async function probeCodexModels(ctx: ModelProbeContext): Promise<ModelInfo[] | null> {
  ctx.signal.throwIfAborted();
  const client = new CodexAppServerClient({
    ...resolveStructuredSpawn(ctx.binary, ['app-server']),
    cwd: ctx.cwd,
    // These clients use the env as given; Claude's transport layers it over the shell env itself.
    env: buildCliSpawnEnv(ctx.env),
    rpcTimeoutMs: ctx.timeoutMs,
    onLog: ctx.log,
  });
  const detach = onAbort(ctx.signal, () => client.kill());
  try {
    await client.start();
    const data: Model[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < CODEX_MAX_PAGES; page++) {
      const res = await client.request('model/list', cursor ? { cursor } : {});
      data.push(...(res?.data ?? []));
      cursor = res?.nextCursor ?? null;
      if (!cursor) break;
    }
    return parseCodexModelList(data);
  } finally {
    detach();
    client.kill();
  }
}

// ── Copilot CLI (ACP) ────────────────────────────────────────────────────

/**
 * Models from an ACP session's state after `session/new`, as the chat model
 * picker reads them. Copilot's default isn't marked: session/new reports its
 * built-in default, not the user's configured one (#2293).
 */
export function acpSessionModels(
  state: Pick<AcpSessionState, 'configOptions' | 'legacyModels'>,
  modelCostHint?: AcpAgentProfile['modelCostHint'],
): ModelInfo[] | null {
  const { models } = sessionChoices(state as AcpSessionState, modelCostHint);
  if (!models?.length) return null;
  return withDefaultEntry(models.map((m): ModelInfo => ({
    id: m.id,
    label: m.label,
    ...(m.description && { description: m.description }),
    ...(m.costHint && { costHint: m.costHint }),
  })));
}

/** Everything an unprompted Copilot session folder holds (1.0.103). Anything else means it was used. */
const UNPROMPTED_COPILOT_FILES = new Set(['workspace.yaml', '.workspace-fork.lock', path.join('checkpoints', 'index.md')]);
const UNPROMPTED_COPILOT_DIRS = new Set(['checkpoints', 'files', 'research']);

/** Relative paths of every file under `dir`, or a reason to keep it (a symlink or an unexpected folder). */
async function listUnpromptedLayout(dir: string, rel = ''): Promise<string[] | string> {
  const files: string[] = [];
  for (const entry of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const entryRel = path.join(rel, entry.name);
    if (entry.isSymbolicLink()) return `symlink ${entryRel}`;
    if (entry.isDirectory()) {
      if (rel || !UNPROMPTED_COPILOT_DIRS.has(entry.name)) return `unexpected folder ${entryRel}`;
      const inner = await listUnpromptedLayout(dir, entryRel);
      if (typeof inner === 'string') return inner;
      files.push(...inner);
    } else {
      files.push(entryRel);
    }
  }
  return files;
}

/**
 * Remove the session folder Copilot created for a probe's own `session/new`,
 * and nothing else. Only the folder named exactly `sessionId`, directly under
 * `stateDir`, is a candidate, and it is kept unless it holds just what an
 * unprompted session leaves (a workspace.yaml for this id with no summaries,
 * a lock, an empty checkpoint index). Never throws; returns whether it removed it.
 */
export async function removeUnpromptedCopilotSession(
  stateDir: string,
  sessionId: string,
  log?: ModelProbeContext['log'],
): Promise<boolean> {
  const keep = (reason: string) => {
    log?.('debug', 'Kept the model probe\'s Copilot session folder', { sessionId, reason });
    return false;
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(sessionId)) return keep('not a plain session id');
  const root = path.resolve(stateDir);
  const dir = path.resolve(root, sessionId);
  if (path.dirname(dir) !== root || path.basename(dir) !== sessionId) return keep('path did not resolve under the session-state dir');
  try {
    const stat = await fsp.lstat(dir);
    if (!stat.isDirectory()) return keep('not a folder');
    const layout = await listUnpromptedLayout(dir);
    if (typeof layout === 'string') return keep(layout);
    const extra = layout.find((f) => !UNPROMPTED_COPILOT_FILES.has(f));
    if (extra) return keep(`holds ${extra}`);
    const workspace = await fsp.readFile(path.join(dir, 'workspace.yaml'), 'utf8');
    if (!new RegExp(`^id: ${sessionId}$`, 'm').test(workspace)) return keep('workspace.yaml names another session');
    if (!/^summary_count: 0$/m.test(workspace)) return keep('workspace.yaml has summaries');
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    // telemetry-exempt: the folder is kept; logged at debug
    return keep(err instanceof Error ? err.message : String(err));
  }
}

export async function probeCopilotModels(ctx: ModelProbeContext): Promise<ModelInfo[] | null> {
  ctx.signal.throwIfAborted();
  // These clients use the env as given; Claude's transport layers it over the shell env itself.
  const env = buildCliSpawnEnv(ctx.env);
  const session = new AcpSession({
    ...resolveCopilotAcpSpawn({ binary: ctx.binary }),
    cwd: ctx.cwd,
    env,
    rpcTimeoutMs: ctx.timeoutMs,
    profile: selectAcpProfile,
    onLog: ctx.log,
  });
  const detach = onAbort(ctx.signal, () => session.kill());
  let sessionId: string | null = null;
  try {
    await session.start();
    sessionId = (await session.newSession({ cwd: ctx.cwd, mcpServers: [] })).sessionId;
    return acpSessionModels(session.getState(), session.agentProfile.modelCostHint);
  } finally {
    detach();
    // session/close (bounded) so the unprompted session isn't left open, then kill.
    if (ctx.signal.aborted) {
      session.kill();
    } else {
      await session.close();
      if (sessionId) await removeUnpromptedCopilotSession(copilotSessionStateDir(env), sessionId, ctx.log);
    }
  }
}
