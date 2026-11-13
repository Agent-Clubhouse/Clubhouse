import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { ImportUserResult } from '../../shared/project-import';
import { projectImportService } from '../services/project-import/service';
import { ImportError } from '../services/project-import/types';
import { appLog } from '../services/log-service';
import { stringArg, withValidatedArgs } from './validation';

async function result<T>(operation: () => Promise<T>): Promise<ImportUserResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const reason = error instanceof ImportError ? error.reason : 'operation_failed';
    appLog('core:project', 'warn', 'Import user operation failed', { meta: { reason } });
    return { ok: false, reason, message: error instanceof ImportError ? error.message : 'Import status is unavailable. Existing files and projects were preserved; inspect the recorded destination before retrying.' };
  }
}

/** User-only UI surfaces. These expose no approval token or agent creation/start authority. */
export function registerProjectImportHandlers(): void {
  ipcMain.handle(IPC.PROJECT.IMPORT_LIST, () => result(() => projectImportService.listForUser()));
  ipcMain.handle(IPC.PROJECT.IMPORT_CANCEL, withValidatedArgs([stringArg({ maxLength: 200 }), stringArg({ maxLength: 4096 })],
    (_event, importId, destination) => result(() => projectImportService.cancelForUser(importId, destination))));
}
