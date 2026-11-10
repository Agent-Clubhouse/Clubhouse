/**
 * Asynchronous durable-agent creation (#2226).
 *
 * `git worktree add` can take up to a minute on a big repo, so this API
 * returns as soon as the agent's record exists (in the 'creating' state) and
 * runs the worktree work in the background. Each stage is reported to the
 * listeners registered with onDurableCreationEvent: config_created,
 * worktree_added, config_injected, then ready, or failed (with a reason) or
 * cancelled. agent-config.ts persists the creating state first, so a quit
 * mid-create is cleaned up on the next launch.
 */
import type { DurableAgentConfig, DurableWorktreeOptions, StartDurableCreationParams } from '../../shared/types';
import type { OrchestratorId } from '../orchestrators';
import { ATTR } from '../../shared/telemetry/attributes';
import { tel, tagError } from '../telemetry/facade';
import { orchestratorAttr } from '../telemetry/spawn-telemetry';
import { appLog } from './log-service';
import {
  DurableCreationCancelledError,
  beginDurableCreation,
  cancelDurableCreation,
  onDurableCreationEvent,
  type DurableCreationHandle,
} from './agent-config';

export { cancelDurableCreation, onDurableCreationEvent };
export type { DurableCreationListener } from './agent-config';

export interface StartDurableCreationOptions {
  /** Extra injection into the new worktree after the project defaults (e.g. a managed helper's setup). */
  inject?: (config: DurableAgentConfig) => Promise<void>;
  /** An inject failure fails the creation instead of being logged (a managed helper's setup, #2899). */
  injectRequired?: boolean;
  /** False for a managed agent: the project's legacy agent defaults are neither checked nor written (#3243). */
  projectDefaults?: false;
}

export type DurableCreationOutcome = 'ready' | 'failed' | 'cancelled';

export interface StartedDurableCreation {
  agentId: string;
  /** The agent's record in the 'creating' state. */
  config: DurableAgentConfig;
  /** Resolves with how the creation ended. Never rejects. */
  done: Promise<DurableCreationOutcome>;
}

/**
 * Start creating a durable agent and return its id at once, while the
 * worktree is made in the background. Throws only for a request that is
 * refused up front (a bad name, folder, branch or base, or one already in
 * use); every later failure arrives as a 'failed' event, and the agent's
 * record stays, marked failed with the reason, until it is deleted.
 *
 * The whole creation, refusals included, is one `clubhouse.agent.create`
 * flow; its `clubhouse.git.worktree_add` step records how long the worktree
 * took, so slow repos show up in telemetry.
 */
export function startDurableCreation(
  projectPath: string,
  params: StartDurableCreationParams,
  options: StartDurableCreationOptions = {},
): Promise<StartedDurableCreation> {
  let started!: (handle: DurableCreationHandle) => void;
  let refused!: (err: unknown) => void;
  const handleReady = new Promise<DurableCreationHandle>((resolve, reject) => { started = resolve; refused = reject; });
  let outcome: DurableCreationOutcome = 'failed';

  const flow = tel.flow(
    'clubhouse.agent.create',
    { attrs: [ATTR.usesWorktree(params.useWorktree !== false), ATTR.orchestrator(orchestratorAttr(params.orchestrator))] },
    async () => {
      let handle: DurableCreationHandle;
      try {
        handle = await beginDurableCreation(projectPath, params, { emitEvents: true, keepFailedRecord: true, inject: options.inject, injectRequired: options.injectRequired, projectDefaults: options.projectDefaults });
      } catch (err) {
        refused(err);
        // validation is tagged at its throw site; anything else is a write failure.
        throw tagError(err, 'write_failed');
      }
      started(handle);
      try {
        await handle.done;
        outcome = 'ready';
      } catch (err) {
        if (err instanceof DurableCreationCancelledError) {
          outcome = 'cancelled';
          return;
        }
        throw tagError(err, 'write_failed');
      }
    },
  );
  const done = Promise.resolve(flow).then(
    (): DurableCreationOutcome => outcome,
    (err: unknown): DurableCreationOutcome => {
      appLog('core:agent-config', 'warn', 'Agent creation failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return outcome;
    },
  );
  return handleReady.then((handle) => ({ agentId: handle.config.id, config: handle.config, done }));
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`params.${key} must be a string`);
  return value;
}

function optionalBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`params.${key} must be a boolean`);
  return value;
}

/** Validate the fields of a START_DURABLE_CREATION request; the folder and branch fields are checked again by agent-config (#2221). */
export function parseWorktreeOptions(raw: Record<string, unknown>): DurableWorktreeOptions {
  const folderName = optionalString(raw, 'folderName');
  const branchName = optionalString(raw, 'branchName');
  const branchFrom = optionalString(raw, 'branchFrom');
  return {
    ...(folderName !== undefined ? { folderName } : {}),
    ...(branchName !== undefined ? { branchName } : {}),
    ...(branchFrom !== undefined ? { branchFrom } : {}),
  };
}

export function parseStartCreationParams(raw: Record<string, unknown>): StartDurableCreationParams {
  const name = raw.name;
  const color = raw.color;
  if (typeof name !== 'string' || name.length === 0) throw new Error('params.name must be a non-empty string');
  if (typeof color !== 'string' || color.length === 0) throw new Error('params.color must be a non-empty string');
  const mcpIds = raw.mcpIds;
  if (mcpIds !== undefined && (!Array.isArray(mcpIds) || mcpIds.some((id) => typeof id !== 'string'))) {
    throw new Error('params.mcpIds must be an array of strings');
  }
  const mcpConfigs = raw.mcpConfigs;
  if (mcpConfigs !== undefined && (typeof mcpConfigs !== 'object' || mcpConfigs === null || Array.isArray(mcpConfigs))) {
    throw new Error('params.mcpConfigs must be an object');
  }
  const model = optionalString(raw, 'model');
  return {
    name,
    color,
    ...(model !== undefined && model !== 'default' ? { model } : {}),
    useWorktree: optionalBoolean(raw, 'useWorktree'),
    orchestrator: optionalString(raw, 'orchestrator') as OrchestratorId | undefined,
    freeAgentMode: optionalBoolean(raw, 'freeAgentMode'),
    mcpIds: mcpIds as string[] | undefined,
    mcpConfigs: mcpConfigs as Record<string, Record<string, string>> | undefined,
    parentAgentId: optionalString(raw, 'parentAgentId'),
    disposable: optionalBoolean(raw, 'disposable'),
    ...parseWorktreeOptions(raw),
  };
}
