import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type {
  LegacyCopyPreview,
  LegacyDefaultsSummary,
  LegacyImportPreview,
  LegacyImportResult,
} from '../shared/legacy-defaults-types';

/** The project's legacy agent defaults (#3245): read, previewed, imported as parts or copied into a plain agent. */
const legacy = {
  describe: (projectPath: string): Promise<LegacyDefaultsSummary> =>
    ipcRenderer.invoke(IPC.LEGACY_DEFAULTS.DESCRIBE, projectPath),
  previewImport: (projectPath: string): Promise<LegacyImportPreview> =>
    ipcRenderer.invoke(IPC.LEGACY_DEFAULTS.PREVIEW_IMPORT, projectPath),
  importAsParts: (projectPath: string): Promise<LegacyImportResult> =>
    ipcRenderer.invoke(IPC.LEGACY_DEFAULTS.IMPORT, projectPath),
  previewCopy: (projectPath: string, agentId: string): Promise<LegacyCopyPreview> =>
    ipcRenderer.invoke(IPC.LEGACY_DEFAULTS.PREVIEW_COPY, projectPath, agentId),
  copyIntoAgent: (projectPath: string, agentId: string): Promise<LegacyCopyPreview> =>
    ipcRenderer.invoke(IPC.LEGACY_DEFAULTS.COPY, projectPath, agentId),
  /** What the New agent page's copy would give a new agent named `name` on `orchestrator`. */
  previewCopyNew: (projectPath: string, name: string, orchestrator?: string): Promise<LegacyCopyPreview> =>
    ipcRenderer.invoke(IPC.LEGACY_DEFAULTS.PREVIEW_COPY_NEW, projectPath, name, orchestrator),
};

export const legacyDefaults = { legacyDefaults: legacy };
