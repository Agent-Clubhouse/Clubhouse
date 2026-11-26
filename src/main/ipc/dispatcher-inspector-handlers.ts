/**
 * IPC for the Dispatcher inspector (#3912). Each handler checks Dispatcher
 * debug in main first, from the saved experimental settings, and refuses with
 * `dispatcher_inspector:debug_off` when it is off: the renderer's own idea of
 * the switch is never trusted, and a stable build reads it as off.
 *
 * Read-only and local only (no Annex route). What is read never reaches logs
 * or telemetry: a failure logs the operation and an error code, nothing else,
 * and rejects with that code alone.
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { DispatcherRole } from '../../shared/dispatcher-behavior';
import { getAllProviders } from '../orchestrators';
import { appLog } from '../services/log-service';
import {
  defaultDispatcherOrchestrator, getDispatcherChatConfig, getDispatcherState,
} from '../services/dispatcher/dispatcher-service';
import { getDispatcherChatPath, getDispatcherMemoryPath, getDispatcherPath } from '../services/dispatcher/dispatcher-paths';
import {
  assertDispatcherDebugOn, inspectInstructions, inspectMemoryAccess, inspectMemoryIndex, inspectMemoryPage,
  inspectSkill, inspectSkills, InspectorError, type InspectorContext,
} from '../services/dispatcher/dispatcher-inspector';

const NS = 'core:dispatcher';

/** The CLI a role runs on: its saved one, as the next start writes it. Null before that agent exists. */
function activeProvider(role: DispatcherRole): string | null {
  const agent = role === 'work' ? getDispatcherState().config : getDispatcherChatConfig();
  if (!agent) return null;
  return agent.orchestrator ?? defaultDispatcherOrchestrator() ?? null;
}

export function inspectorContext(): InspectorContext {
  return {
    folders: { work: getDispatcherPath(), chat: getDispatcherChatPath() },
    memoryRoot: getDispatcherMemoryPath(),
    providers: getAllProviders(),
    activeProvider,
  };
}

/** Gate, then run; a failure is logged and rethrown as its code only. */
async function guarded<T>(op: string, run: (ctx: InspectorContext) => Promise<T>): Promise<T> {
  try {
    assertDispatcherDebugOn();
    return await run(inspectorContext());
  } catch (err) {
    const inspectorError = err instanceof InspectorError ? err : new InspectorError('unreadable');
    // telemetry-exempt: a debug-only read; the code is logged, never the content or the path
    appLog(NS, inspectorError.code === 'debug_off' ? 'info' : 'warn', 'Dispatcher inspector read refused', {
      meta: { op, code: inspectorError.code, ...(!(err instanceof InspectorError) && { errno: (err as NodeJS.ErrnoException)?.code ?? 'unknown' }) },
    });
    throw new Error(inspectorError.message);
  }
}

/** Registered once, by registerDispatcherHandlers. */
export function registerDispatcherInspectorHandlers(): void {
  ipcMain.handle(IPC.DISPATCHER.INSPECT_INSTRUCTIONS, () => guarded('instructions', inspectInstructions));
  ipcMain.handle(IPC.DISPATCHER.INSPECT_SKILLS, () => guarded('skills', inspectSkills));
  // Arguments are checked after the gate (by the service), so an off switch refuses everything alike.
  ipcMain.handle(IPC.DISPATCHER.INSPECT_SKILL, (_event, role: unknown, name: unknown) =>
    guarded('skill', (ctx) => inspectSkill(ctx, role as DispatcherRole, name as string)));
  ipcMain.handle(IPC.DISPATCHER.INSPECT_MEMORY_INDEX, () => guarded('memory_index', inspectMemoryIndex));
  ipcMain.handle(IPC.DISPATCHER.INSPECT_MEMORY_PAGE, (_event, page: unknown) =>
    guarded('memory_page', (ctx) => inspectMemoryPage(ctx, page as string)));
  ipcMain.handle(IPC.DISPATCHER.INSPECT_MEMORY_ACCESS, () => guarded('memory_access', inspectMemoryAccess));
}

