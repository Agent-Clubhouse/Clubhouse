/**
 * Checks the per-agent context choice (#2660) against what the CLI offers for
 * the model, when it's saved and again at launch. The check only reads a
 * catalog when an agent has a choice saved, so an agent without one starts as
 * it always did. Never writes the CLI's own config and never restarts anything.
 */
import { contextWindowRefusal, type ContextWindowOptions } from '../../shared/context-window';
import { appLog } from './log-service';
import { resolveOrchestrator, resolveProfileEnv } from './agent-system';

export type ContextWindowCheck =
  | { state: 'ok' }
  /** The CLI doesn't offer it for this model. */
  | { state: 'refused'; message: string }
  /** The catalog can't say, so it stays saved and isn't applied. */
  | { state: 'unknown'; message: string };

/** How long a settings read or a start waits on a CLI's catalog. */
const CATALOG_WAIT_MS = 10_000;

const UNREADABLE: ContextWindowOptions = { configurable: false, state: 'unavailable', label: 'Context', reason: 'Couldn\'t read this CLI\'s context settings.' };

export async function contextWindowOptionsFor(projectPath: string, orchestrator: string | undefined, model: string | undefined): Promise<ContextWindowOptions> {
  try {
    const provider = await resolveOrchestrator(projectPath, orchestrator);
    const env = await resolveProfileEnv(projectPath, provider.id);
    if (!provider.getContextWindowOptions) {
      return { configurable: false, state: 'unsupported', label: 'Context', reason: `${provider.displayName} has no context setting.` };
    }
    // The read carries on and fills the cache; a settings screen or a start doesn't wait on it.
    return await Promise.race([
      provider.getContextWindowOptions(model, env ? { env } : undefined),
      new Promise<ContextWindowOptions>((resolve) => { setTimeout(() => resolve(UNREADABLE), CATALOG_WAIT_MS).unref?.(); }),
    ]);
  } catch (err) {
    // telemetry-exempt: shown as unavailable; a saved choice isn't applied.
    appLog('core:agent', 'info', 'Could not read context options', { meta: { error: err instanceof Error ? err.message : String(err) } });
    return UNREADABLE;
  }
}

export async function contextWindowCheck(projectPath: string, orchestrator: string | undefined, model: string | undefined, value: string): Promise<ContextWindowCheck> {
  const options = await contextWindowOptionsFor(projectPath, orchestrator, model);
  const refusal = contextWindowRefusal(value, options);
  if (refusal) return { state: 'refused', message: refusal };
  if (options.configurable === false) return { state: 'unknown', message: options.reason };
  return { state: 'ok' };
}

/** The chat `notice` that says a saved choice wasn't used. A phone draws it as it does any notice. */
export const CONTEXT_WINDOW_NOTICE_CODE = 'context_window_not_applied';

export interface LaunchContextWindow {
  value?: string;
  /** Set when the saved choice wasn't used. */
  notice?: { level: 'warn'; code: typeof CONTEXT_WINDOW_NOTICE_CODE; message: string };
}

/**
 * The choice to pass to this launch or resume. One the model no longer offers
 * is cleared; one that can't be checked stays saved. Either way it isn't
 * passed, and `notice` says so.
 */
export async function contextWindowForLaunch(projectPath: string, orchestrator: string, agentId: string, model: string | undefined, value: string): Promise<LaunchContextWindow> {
  const check = await contextWindowCheck(projectPath, orchestrator, model, value);
  if (check.state === 'ok') return { value };
  const message = check.state === 'refused'
    ? `Started without the saved context choice, and cleared it. ${check.message}`
    : `Started without the saved context choice. ${check.message}`;
  if (check.state === 'refused') {
    // Dynamic: agent-config imports this file for its own check.
    const { clearContextWindow } = await import('./agent-config');
    await clearContextWindow(projectPath, agentId, message).catch((err: unknown) => {
      appLog('core:agent', 'warn', 'Could not clear the context choice', { meta: { agentId, error: err instanceof Error ? err.message : String(err) } });
    });
  }
  appLog('core:agent', 'warn', message, { meta: { agentId, orchestrator, model } });
  return { notice: { level: 'warn', code: CONTEXT_WINDOW_NOTICE_CODE, message } };
}
