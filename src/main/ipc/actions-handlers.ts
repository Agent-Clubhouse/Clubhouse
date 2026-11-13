/**
 * IPC for Settings > Actions (#2918). Everything a window does here, it does
 * as the person: actions it creates are owned by "You".
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as actions from '../services/actions';
import { booleanArg, objectArg, stringArg, withValidatedArgs } from './validation';

let registered = false;

export function registerActionsHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(IPC.ACTIONS.LIST, () => actions.listActions());
  ipcMain.handle(IPC.ACTIONS.USAGE, () => actions.actionUsage());
  ipcMain.handle(IPC.ACTIONS.CREATE, withValidatedArgs(
    [objectArg<Record<string, unknown>>(), stringArg({ minLength: 1, maxLength: 200, optional: true })],
    (_event, input, groupProjectId) => groupProjectId ? actions.createGroupProjectAction(input, groupProjectId) : actions.createAction(input, { kind: 'user' }),
  ));
  ipcMain.handle(IPC.ACTIONS.UPDATE, withValidatedArgs(
    [stringArg({ minLength: 1, maxLength: 200 }), objectArg<Record<string, unknown>>()],
    (_event, id, input) => actions.changeActionOnHost(id, () => actions.updateAction(id, input)),
  ));
  ipcMain.handle(IPC.ACTIONS.SET_ENABLED, withValidatedArgs(
    [stringArg({ minLength: 1, maxLength: 200 }), booleanArg()],
    (_event, id, enabled) => actions.changeActionOnHost(id, () => actions.setActionEnabled(id, enabled)),
  ));
  ipcMain.handle(IPC.ACTIONS.DELETE, withValidatedArgs(
    [stringArg({ minLength: 1, maxLength: 200 })],
    (_event, id) => actions.changeActionOnHost(id, () => actions.deleteAction(id)),
  ));
  ipcMain.handle(IPC.ACTIONS.RUN_NOW, withValidatedArgs(
    [stringArg({ minLength: 1, maxLength: 200 })],
    (_event, id) => actions.changeActionOnHost(id, () => actions.runActionNow(id)),
  ));
  ipcMain.handle(IPC.ACTIONS.HISTORY, withValidatedArgs(
    [stringArg({ minLength: 1, maxLength: 200 })],
    (_event, id) => actions.actionHistory(id),
  ));
}

/** For tests. */
export function _resetActionsHandlersForTesting(): void {
  registered = false;
}
