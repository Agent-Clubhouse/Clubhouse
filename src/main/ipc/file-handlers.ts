import { execFile } from 'child_process';
import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as fileService from '../services/file-service';
import * as searchService from '../services/search-service';
import { startWatch, stopWatch } from '../services/file-watch-service';
import { appLog } from '../services/log-service';
import { assertAllowedPath } from '../services/path-sandbox';
import { editorSettings } from './settings-handlers';
import type { FileSearchOptions } from '../../shared/types';
import { booleanArg, numberArg, objectArg, stringArg, withValidatedArgs } from './validation';
import { tel } from '../telemetry/facade';
import { classifyFsError, classifySearchError, editorBucket, flowClassifyingThrows } from '../telemetry/workspace';
import { ATTR, countBucket } from '../../shared/telemetry/attributes';

type FileOp = Parameters<typeof ATTR.fileOp>[0];

/**
 * Count a file-service operation by result (spec §4.9). Errors are counted by
 * errno code (or `path_denied`) and rethrown unchanged.
 */
async function fileOp<T>(op: FileOp, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    tel.count('clubhouse.file.ops', 1, [ATTR.fileOp(op), ATTR.fileResult('ok')]);
    return result;
  } catch (err) {
    tel.count('clubhouse.file.ops', 1, [ATTR.fileOp(op), ATTR.fileResult('error'), ATTR.errorType(classifyFsError(err))]);
    throw err;
  }
}

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE.READ_TREE, withValidatedArgs(
    [
      stringArg(),
      objectArg<{ includeHidden?: boolean; depth?: number }>({
        optional: true,
        validate: (value, argName) => {
          if (value.includeHidden !== undefined) booleanArg()(value.includeHidden, `${argName}.includeHidden`);
          if (value.depth !== undefined) numberArg({ integer: true, min: 0 })(value.depth, `${argName}.depth`);
        },
      }),
    ],
    (event, dirPath: string, options?: { includeHidden?: boolean; depth?: number }) => fileOp('read_tree', () =>
    tel.flow('clubhouse.file.tree.read', {}, async (span) => {
    await assertAllowedPath(dirPath);
    const controller = new AbortController();
    const abort = () => controller.abort();
    event.sender.once('destroyed', abort);
    const stats = { nodeCount: 0, hitCap: false };
    try {
      return await fileService.readTree(dirPath, { ...options, signal: controller.signal, stats });
    } finally {
      span.set(ATTR.treeNodeCount(countBucket(stats.nodeCount)), ATTR.treeHitCap(stats.hitCap));
      try { event.sender.off('destroyed', abort); } catch { /* sender already destroyed */ }
    }
    })),
  ));

  ipcMain.handle(IPC.FILE.READ, withValidatedArgs([stringArg()], (_event, filePath: string) => fileOp('read', async () => {
    await assertAllowedPath(filePath);
    try {
      return await fileService.readFile(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to read file', {
        meta: { filePath, code, error: message },
      });
      throw new Error(`Failed to read file "${filePath}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.WRITE, withValidatedArgs([stringArg(), stringArg({ minLength: 0 })], (_event, filePath: string, content: string) => fileOp('write', async () => {
    await assertAllowedPath(filePath);
    try {
      await fileService.writeFile(filePath, content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to write file', {
        meta: { filePath, code, error: message },
      });
      throw new Error(`Failed to write file "${filePath}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.READ_BINARY, withValidatedArgs([stringArg()], (_event, filePath: string) => fileOp('read_binary', async () => {
    await assertAllowedPath(filePath);
    try {
      return await fileService.readBinary(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to read binary file', {
        meta: { filePath, code, error: message },
      });
      throw new Error(`Failed to read binary file "${filePath}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.SHOW_IN_FOLDER, withValidatedArgs([stringArg()], async (_event, filePath: string) => {
    await assertAllowedPath(filePath);
    shell.showItemInFolder(filePath);
  }));

  ipcMain.handle(IPC.FILE.MKDIR, withValidatedArgs([stringArg()], (_event, dirPath: string) => fileOp('mkdir', async () => {
    await assertAllowedPath(dirPath);
    try {
      await fileService.mkdir(dirPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to create directory', {
        meta: { dirPath, code, error: message },
      });
      throw new Error(`Failed to create directory "${dirPath}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.DELETE, withValidatedArgs([stringArg()], (_event, filePath: string) => fileOp('delete', async () => {
    await assertAllowedPath(filePath);
    try {
      await fileService.deleteFile(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to delete file', {
        meta: { filePath, code, error: message },
      });
      throw new Error(`Failed to delete file "${filePath}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.RENAME, withValidatedArgs([stringArg(), stringArg()], (_event, oldPath: string, newPath: string) => fileOp('rename', async () => {
    await assertAllowedPath(oldPath);
    await assertAllowedPath(newPath);
    try {
      await fileService.rename(oldPath, newPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to rename file', {
        meta: { oldPath, newPath, code, error: message },
      });
      throw new Error(`Failed to rename "${oldPath}" to "${newPath}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.COPY, withValidatedArgs([stringArg(), stringArg()], (_event, src: string, dest: string) => fileOp('copy', async () => {
    await assertAllowedPath(src);
    await assertAllowedPath(dest);
    try {
      await fileService.copy(src, dest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to copy file', {
        meta: { src, dest, code, error: message },
      });
      throw new Error(`Failed to copy "${src}" to "${dest}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.STAT, withValidatedArgs([stringArg()], (_event, filePath: string) => fileOp('stat', async () => {
    await assertAllowedPath(filePath);
    try {
      return await fileService.stat(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      appLog('core:file', 'error', 'Failed to stat file', {
        meta: { filePath, code, error: message },
      });
      throw new Error(`Failed to stat "${filePath}": ${code} - ${message}`);
    }
  })));

  ipcMain.handle(IPC.FILE.WATCH_START, withValidatedArgs([stringArg(), stringArg()], (event, watchId: string, glob: string) => {
    startWatch(watchId, glob, event.sender);
  }));

  ipcMain.handle(IPC.FILE.WATCH_STOP, withValidatedArgs([stringArg()], (event, watchId: string) => {
    stopWatch(watchId, event.sender.id);
  }));

  ipcMain.handle(IPC.FILE.SEARCH, withValidatedArgs([
    stringArg(),
    stringArg({ minLength: 0 }),
    objectArg<FileSearchOptions>({ optional: true }),
  ], (_event, rootPath: string, query: string, options?: FileSearchOptions) => {
    // The query text and globs are never sent (spec §4.9), only engine, flags and outcome.
    return flowClassifyingThrows('clubhouse.search.query', {
      attrs: [
        ATTR.searchRegex(options?.regex === true),
        ATTR.searchCaseSensitive(options?.caseSensitive === true),
        ATTR.searchWholeWord(options?.wholeWord === true),
      ],
    }, async (span) => {
      await assertAllowedPath(rootPath);
      const result = await searchService.searchFiles(rootPath, query, options, (engine) => span.set(ATTR.searchEngine(engine)));
      span.set(ATTR.searchTruncated(result.truncated), ATTR.searchMatchCount(countBucket(result.totalMatches)));
      return result;
    }, classifySearchError);
  }));

  ipcMain.handle(IPC.FILE.OPEN_IN_EDITOR, withValidatedArgs([stringArg()], async (_event, filePath: string) => {
    await assertAllowedPath(filePath);
    const { editorCommand } = editorSettings.getSettings();
    return tel.flow('clubhouse.editor.open_external', { attrs: [ATTR.editorBucket(editorBucket(editorCommand))] }, () =>
      openInEditor(editorCommand, filePath));
  }));
}

function openInEditor(editorCommand: string, filePath: string): Promise<void> {
  // LB-M15: Wait for process to complete before returning so errors are detected
  return new Promise<void>((resolve, reject) => {
    execFile(editorCommand, [filePath], (err) => {
      if (err) {
        appLog('core:file', 'error', 'Failed to open file in editor', {
          meta: { filePath, editorCommand, error: err.message },
        });
        reject(new Error(`Failed to open in editor: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}
