/**
 * Agent spawn, create and delete helpers (spec §4.4, Phase 4b). The spans
 * themselves are tel.flow / tel.step calls at the call sites; this file holds
 * the facts a spawn collects along the way and the metrics recorded at its end.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { tel } from './facade';
import { errorTypeOf } from './types';

type Kind = Parameters<typeof ATTR.agentKind>[0];
type Runtime = Parameters<typeof ATTR.agentRuntime>[0];
type Orchestrator = Parameters<typeof ATTR.orchestrator>[0];

/** What a spawn learned on its way, set as it goes and attached to the span at the end. */
export interface SpawnFacts {
  orchestrator?: string;
  /** Unset until the spawn picks a runtime; omitted from attributes until then. */
  runtime?: Runtime;
  clubhouseMode?: boolean;
  mcpEnabled?: boolean;
  hooksEnabled?: boolean;
  profileActive?: boolean;
  wrapperApplied?: boolean;
  model?: string;
  /** Headless only: the process never got a PID. */
  noPid?: boolean;
}

export function orchestratorAttr(id: string | undefined): Orchestrator {
  return id === 'claude-code' || id === 'codex-cli' || id === 'copilot-cli' ? id : 'other';
}

/** Bucket a model string. The raw value is never sent. */
export function modelFamily(model: string | undefined): Parameters<typeof ATTR.modelFamily>[0] {
  if (!model || model === 'default') return 'default';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.startsWith('gpt-5')) return 'gpt-5';
  return 'other';
}

export function spawnAttrs(f: SpawnFacts): TelAttr[] {
  const attrs: TelAttr[] = [ATTR.orchestrator(orchestratorAttr(f.orchestrator)), ATTR.modelFamily(modelFamily(f.model))];
  if (f.runtime) attrs.push(ATTR.agentRuntime(f.runtime));
  if (f.clubhouseMode !== undefined) attrs.push(ATTR.clubhouseMode(f.clubhouseMode));
  if (f.mcpEnabled !== undefined) attrs.push(ATTR.mcpEnabled(f.mcpEnabled));
  if (f.hooksEnabled !== undefined) attrs.push(ATTR.hooksEnabled(f.hooksEnabled));
  if (f.profileActive !== undefined) attrs.push(ATTR.profileActive(f.profileActive));
  if (f.wrapperApplied !== undefined) attrs.push(ATTR.wrapperApplied(f.wrapperApplied));
  return attrs;
}

/** Count one spawn attempt; on success also its duration. */
export function recordSpawn(kind: Kind, f: SpawnFacts, startMs: number, error: unknown, atMs = Date.now()): void {
  const dims = [ATTR.agentKind(kind), ATTR.orchestrator(orchestratorAttr(f.orchestrator))];
  if (f.runtime) dims.push(ATTR.agentRuntime(f.runtime));
  const failed = error !== undefined || f.noPid === true;
  const errorType = error !== undefined ? errorTypeOf(error) : f.noPid ? 'headless_no_pid' : undefined;
  tel.count('clubhouse.agent.spawns', 1, [
    ...dims,
    ATTR.outcome(failed ? 'error' : 'ok'),
    ...(errorType ? [ATTR.errorType(errorType)] : []),
  ]);
  if (!failed) tel.count('clubhouse.agent.spawn.duration', (atMs - startMs) / 1000, dims);
}
