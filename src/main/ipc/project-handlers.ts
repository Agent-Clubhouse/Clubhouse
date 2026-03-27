import { ipcMain, dialog, BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { IPC } from '../../shared/ipc-channels';
import * as projectStore from '../services/project-store';
import { ensureGitignore } from '../services/agent-config';
import { readLaunchWrapper, writeLaunchWrapper, readMcpCatalog, writeMcpCatalog, readDefaultMcps, writeDefaultMcps } from '../services/agent-settings-service';
import { appLog } from '../services/log-service';
import { isInsideGitRepo } from '../services/git-service';
import { arrayArg, objectArg, stringArg, withValidatedArgs } from './validation';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC.PROJECT.LIST, async () => {
    return projectStore.list();
  });

  ipcMain.handle(IPC.PROJECT.ADD, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    const project = await projectStore.add(dirPath);
    try {
      await ensureGitignore(dirPath);
    } catch {
      // Non-fatal
    }
    return project;
  }));

  ipcMain.handle(IPC.PROJECT.REMOVE, withValidatedArgs([stringArg()], async (_event, id: string) => {
    return projectStore.remove(id);
  }));

  ipcMain.handle(IPC.PROJECT.PICK_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Project Directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.PROJECT.CHECK_GIT, withValidatedArgs([stringArg()], async (_event, dirPath: string) => {
    return isInsideGitRepo(dirPath);
  }));

  ipcMain.handle(IPC.PROJECT.GIT_INIT, withValidatedArgs([stringArg()], (_event, dirPath: string) => {
    try {
      execSync('git init', { cwd: dirPath, encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }));

  ipcMain.handle(IPC.PROJECT.UPDATE, withValidatedArgs([stringArg(), objectArg<Record<string, unknown>>()], async (_event, id: string, updates: Record<string, unknown>) => {
    return projectStore.update(id, updates as any);
  }));

  ipcMain.handle(IPC.PROJECT.PICK_ICON, withValidatedArgs([stringArg()], async (_event, projectId: string) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: 'Choose Project Icon',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return projectStore.setIcon(projectId, result.filePaths[0]);
  }));

  ipcMain.handle(IPC.PROJECT.REORDER, withValidatedArgs([arrayArg(stringArg())], async (_event, orderedIds: string[]) => {
    return projectStore.reorder(orderedIds);
  }));

  ipcMain.handle(IPC.PROJECT.READ_ICON, withValidatedArgs([stringArg()], async (_event, filename: string) => {
    return projectStore.readIconData(filename);
  }));

  ipcMain.handle(IPC.PROJECT.PICK_IMAGE, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: 'Choose Image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    };
    const mime = mimeMap[ext] || 'image/png';
    const data = await fsp.readFile(filePath);
    return `data:${mime};base64,${data.toString('base64')}`;
  });

  ipcMain.handle(IPC.PROJECT.SAVE_CROPPED_ICON, withValidatedArgs([stringArg(), stringArg()], async (_event, projectId: string, dataUrl: string) => {
    return projectStore.saveCroppedIcon(projectId, dataUrl);
  }));

  ipcMain.handle(IPC.PROJECT.LIST_CLUBHOUSE_FILES, withValidatedArgs([stringArg()], async (_event, projectPath: string): Promise<string[]> => {
    const clubhouseDir = path.join(projectPath, '.clubhouse');
    try {
      await fsp.access(clubhouseDir);
    } catch {
      return [];
    }
    try {
      const results: string[] = [];
      const walk = async (dir: string, prefix: string) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            results.push(rel + '/');
            await walk(path.join(dir, entry.name), rel);
          } else {
            results.push(rel);
          }
        }
      };
      await walk(clubhouseDir, '');
      return results;
    } catch {
      return [];
    }
  }));

  ipcMain.handle(IPC.PROJECT.RESET_PROJECT, withValidatedArgs([stringArg()], async (_event, projectPath: string): Promise<boolean> => {
    const clubhouseDir = path.join(projectPath, '.clubhouse');
    try {
      await fsp.access(clubhouseDir);
    } catch {
      return true;
    }
    try {
      appLog('core:project', 'warn', 'Resetting project .clubhouse directory', {
        meta: { projectPath },
      });
      await fsp.rm(clubhouseDir, { recursive: true, force: true });
      return true;
    } catch (err) {
      appLog('core:project', 'error', 'Failed to reset project directory', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }));

  ipcMain.handle(IPC.PROJECT.READ_LAUNCH_WRAPPER, withValidatedArgs([stringArg()], async (_event, projectPath: string) => {
    try {
      return await readLaunchWrapper(projectPath);
    } catch (err) {
      appLog('core:project', 'error', 'Failed to read launch wrapper', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      return undefined;
    }
  }));

  ipcMain.handle(IPC.PROJECT.WRITE_LAUNCH_WRAPPER, withValidatedArgs([stringArg(), objectArg({ optional: true })], async (_event, projectPath: string, wrapper: unknown) => {
    try {
      if (wrapper && (typeof wrapper !== 'object' || !('binary' in wrapper) || !('orchestratorMap' in wrapper))) {
        throw new Error('Invalid launch wrapper config: must have binary and orchestratorMap');
      }
      await writeLaunchWrapper(projectPath, (wrapper as any) || undefined);
    } catch (err) {
      appLog('core:project', 'error', 'Failed to write launch wrapper', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }));

  ipcMain.handle(IPC.PROJECT.READ_MCP_CATALOG, withValidatedArgs([stringArg()], async (_event, projectPath: string) => {
    try {
      return await readMcpCatalog(projectPath);
    } catch (err) {
      appLog('core:project', 'error', 'Failed to read MCP catalog', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      return [];
    }
  }));

  ipcMain.handle(IPC.PROJECT.WRITE_MCP_CATALOG, withValidatedArgs([stringArg(), arrayArg(objectArg())], async (_event, projectPath: string, catalog: unknown[]) => {
    try {
      await writeMcpCatalog(projectPath, catalog as any[]);
    } catch (err) {
      appLog('core:project', 'error', 'Failed to write MCP catalog', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }));

  ipcMain.handle(IPC.PROJECT.READ_DEFAULT_MCPS, withValidatedArgs([stringArg()], async (_event, projectPath: string) => {
    try {
      return await readDefaultMcps(projectPath);
    } catch (err) {
      appLog('core:project', 'error', 'Failed to read default MCPs', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      return [];
    }
  }));

  ipcMain.handle(IPC.PROJECT.WRITE_DEFAULT_MCPS, withValidatedArgs([stringArg(), arrayArg(stringArg())], async (_event, projectPath: string, mcpIds: string[]) => {
    try {
      await writeDefaultMcps(projectPath, mcpIds);
    } catch (err) {
      appLog('core:project', 'error', 'Failed to write default MCPs', {
        meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }));
}
