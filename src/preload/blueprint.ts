import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const blueprint = {
  blueprint: {
  /**
   * Open a native save dialog and write the supplied JSON content to the
   * chosen path. The user picking a path is the consent gate — this can
   * write anywhere on disk, no project-directory sandbox.
   */
  saveToFile: (defaultName: string, content: string) =>
    ipcRenderer.invoke(IPC.BLUEPRINT.SAVE_TO_FILE, defaultName, content) as Promise<{
      canceled: boolean; filePath?: string; error?: string;
    }>,
  /**
   * Open a native file dialog and read+parse the chosen file. Bypasses the
   * project-directory sandbox, same consent model as saveToFile.
   */
  openAndRead: () =>
    ipcRenderer.invoke(IPC.BLUEPRINT.OPEN_AND_READ) as Promise<{
      canceled: boolean; data?: Record<string, unknown>; filePath?: string; error?: string;
    }>,
  /** Scan .clubhouse/blueprints/ across all projects and return summaries. */
  list: () => ipcRenderer.invoke(IPC.BLUEPRINT.LIST) as Promise<Array<{
    filePath: string; name: string; description?: string;
    viewCount: number; agentCount: number; wireCount: number;
    version: number; source: string; createdAt?: string; agentNames: string[];
  }>>,
  /** Read and parse a single blueprint file by absolute path. */
  read: (filePath: string) => ipcRenderer.invoke(IPC.BLUEPRINT.READ, filePath) as Promise<Record<string, unknown> | null>,
  /** Delete a blueprint file by absolute path. */
  delete: (filePath: string) => ipcRenderer.invoke(IPC.BLUEPRINT.DELETE, filePath) as Promise<boolean>,
  },
};
