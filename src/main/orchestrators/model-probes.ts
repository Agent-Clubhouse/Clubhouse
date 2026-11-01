/**
 * Live model lists from each CLI's own handshake (#2569). Every probe spawns
 * the user's CLI, completes the handshake, reads the model list and kills the
 * process. None sends a prompt, so none costs tokens:
 *
 * - Claude Code: the stream-json control `initialize` reply's `models[]`.
 * - Codex: app-server `initialize`, then `model/list`.
 * - Copilot CLI: ACP `initialize`, then `session/new`, whose result lists the
 *   models; the session is closed unprompted.
 *
 * The protocol clients are the chat drivers' own (ClaudeStreamTransport,
 * CodexAppServerClient, AcpSession). The parsers are exported for the
 * recorded fixtures in adapters/__fixtures__/models and acp/copilot-cli.
 */

import type { ChildProcess } from 'child_process';
import { ClaudeStreamTransport } from '../chat/claude/stream-transport';
import { initializedFromWire } from '../chat/claude/normalizer';
import { spawnClaude } from '../chat/claude/spawn';
import { killStructuredChild, resolveStructuredSpawn } from './adapters/structured-spawn';
import { CodexAppServerClient } from './adapters/codex-app-server-client';
import type { Model } from './adapters/codex-protocol';
import { AcpSession, type AcpAgentProfile, type AcpSessionState } from './adapters/acp-session';
import { sessionChoices } from './adapters/acp-chat-mapper';
import { resolveCopilotAcpSpawn, selectAcpProfile } from './adapters/copilot-acp';
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

export async function probeCopilotModels(ctx: ModelProbeContext): Promise<ModelInfo[] | null> {
  const session = new AcpSession({
    ...resolveCopilotAcpSpawn({ binary: ctx.binary }),
    cwd: ctx.cwd,
    // These clients use the env as given; Claude's transport layers it over the shell env itself.
    env: buildCliSpawnEnv(ctx.env),
    rpcTimeoutMs: ctx.timeoutMs,
    profile: selectAcpProfile,
    onLog: ctx.log,
  });
  const detach = onAbort(ctx.signal, () => session.kill());
  try {
    await session.start();
    await session.newSession({ cwd: ctx.cwd, mcpServers: [] });
    return acpSessionModels(session.getState(), session.agentProfile.modelCostHint);
  } finally {
    detach();
    // session/close (bounded) so the unprompted session isn't left open, then kill.
    if (ctx.signal.aborted) session.kill();
    else await session.close();
  }
}
