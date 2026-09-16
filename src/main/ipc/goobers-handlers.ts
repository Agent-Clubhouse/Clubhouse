/**
 * IPC handlers for the Goobers instance panel (spec §6.1).
 *
 * Every handler wraps in `withValidatedArgs`. `runId`, `gaggle`, `workflow`,
 * and `stage` are interpolated into upstream URL paths — validated for shape
 * here (§10.2) via `pathSegmentArg`, which also rejects path-injection
 * attempts (`../`, encoded slashes, absolute paths). The renderer is not a
 * trust boundary (§10.4): all validation lives in this file.
 *
 * Read-path and mutating handlers that need the M3 network/daemon internals
 * return a `not-implemented` error envelope for now — see goobers-service.ts.
 *
 * The platform gate (§7.8) wraps *outside* argument validation: on `win32`
 * every handler returns `unsupported-platform` regardless of args, and never
 * throws on bad input it will never act on.
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { goobersService, validateInstanceRoot } from '../services/goobers-service';
import { withValidatedArgs, stringArg, pathSegmentArg, numberArg, objectArg, ArgValidator } from './validation';
import type { RunListQuery } from '../../shared/goobers-types';

type IpcHandlerFn<Args extends unknown[], Result> = (event: Electron.IpcMainInvokeEvent, ...args: Args) => Result;

/** Runs the platform gate before anything else, including arg validation. */
function platformGated<Args extends unknown[], Result>(
  handler: IpcHandlerFn<Args, Result>,
): IpcHandlerFn<Args, Result | ReturnType<typeof goobersService.unsupportedPlatform>> {
  return (event, ...args) => {
    if (!goobersService.isSupportedPlatform) {
      return goobersService.unsupportedPlatform();
    }
    return handler(event, ...args);
  };
}

/** `withValidatedArgs` composed behind the platform gate. */
function gatedHandler<Arg, Result>(
  validator: ArgValidator<Arg>,
  handler: IpcHandlerFn<[Arg], Result>,
) {
  return platformGated(withValidatedArgs<[Arg], Result>([validator], handler));
}

function validateRunListQuery(value: RunListQuery, argName: string): void {
  const allowedKeys = new Set([
    'gaggle', 'workflow', 'stage', 'outcome', 'population', 'phase', 'trigger',
    'since', 'until', 'cursor', 'limit', 'latestPerWorkflow', 'showNoWork', 'orderByActivity',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${argName}.${key} is not a recognized RunListQuery field`);
    }
  }
}

export function registerGoobersHandlers(): void {
  ipcMain.handle(IPC.GOOBERS.GET_STATE, platformGated(() => {
    goobersService.subscribe();
    return goobersService.getState();
  }));

  ipcMain.handle(IPC.GOOBERS.VALIDATE_ROOT, gatedHandler(
    objectArg<{ path: string }>({ validate: (v, argName) => { stringArg()(v.path, `${argName}.path`); } }),
    async (_event, args) => validateInstanceRoot(args.path),
  ));

  ipcMain.handle(IPC.GOOBERS.CONNECT, platformGated(async () => {
    return goobersService.connect();
  }));

  ipcMain.handle(IPC.GOOBERS.DISCONNECT, platformGated(() => {
    return goobersService.disconnect();
  }));

  ipcMain.handle(IPC.GOOBERS.LIST_GAGGLES, platformGated(() => {
    return goobersService.notImplemented();
  }));

  ipcMain.handle(IPC.GOOBERS.LIST_WORKFLOWS, gatedHandler(
    objectArg<{ gaggle: string }>({ validate: (v, argName) => { pathSegmentArg()(v.gaggle, `${argName}.gaggle`); } }),
    () => goobersService.notImplemented(),
  ));

  ipcMain.handle(IPC.GOOBERS.LIST_RUNS, gatedHandler(
    objectArg<RunListQuery>({ optional: true, validate: validateRunListQuery }),
    () => goobersService.notImplemented(),
  ));

  ipcMain.handle(IPC.GOOBERS.GET_RUN, gatedHandler(
    objectArg<{ runId: string }>({ validate: (v, argName) => { pathSegmentArg()(v.runId, `${argName}.runId`); } }),
    () => goobersService.notImplemented(),
  ));

  ipcMain.handle(IPC.GOOBERS.GET_RUN_EVENTS, gatedHandler(
    objectArg<{ runId: string; cursor?: string; limit?: number }>({
      validate: (v, argName) => {
        pathSegmentArg()(v.runId, `${argName}.runId`);
        stringArg({ optional: true })(v.cursor, `${argName}.cursor`);
        numberArg({ optional: true, integer: true, min: 0 })(v.limit, `${argName}.limit`);
      },
    }),
    () => goobersService.notImplemented(),
  ));

  ipcMain.handle(IPC.GOOBERS.GET_STAGE_ATTEMPTS, gatedHandler(
    objectArg<{ runId: string; stage: string }>({
      validate: (v, argName) => {
        pathSegmentArg()(v.runId, `${argName}.runId`);
        pathSegmentArg()(v.stage, `${argName}.stage`);
      },
    }),
    () => goobersService.notImplemented(),
  ));

  ipcMain.handle(IPC.GOOBERS.CANCEL_RUN, gatedHandler(
    objectArg<{ runId: string }>({ validate: (v, argName) => { pathSegmentArg()(v.runId, `${argName}.runId`); } }),
    // Mutating — not-implemented until M3 wires POST /runs/{run}/cancel.
    () => goobersService.notImplemented(),
  ));

  ipcMain.handle(IPC.GOOBERS.DAEMON_STATUS, platformGated(() => {
    return goobersService.notImplemented();
  }));

  ipcMain.handle(IPC.GOOBERS.DAEMON_START, platformGated(() => {
    // Mutating, gated on manageDaemon — enforcement + spawn land with M3.
    return goobersService.notImplemented();
  }));

  ipcMain.handle(IPC.GOOBERS.DAEMON_STOP, platformGated(() => {
    return goobersService.notImplemented();
  }));

  ipcMain.handle(IPC.GOOBERS.OPEN_RUN_DIR, gatedHandler(
    objectArg<{ runId: string }>({ validate: (v, argName) => { pathSegmentArg()(v.runId, `${argName}.runId`); } }),
    // Mutating — POST /runs/{run}/reveal lands with M3.
    () => goobersService.notImplemented(),
  ));
}
