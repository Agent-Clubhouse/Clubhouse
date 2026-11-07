import { ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type {
  ManagedAgentSetup,
  ManagedAgentStatus,
  ManagedConvertPreview,
  ManagedPart,
  ManagedPartConsumer,
  ManagedPartContent,
  ManagedPartKind,
  ManagedPartSummary,
  ManagedPreview,
  ManagedResult,
  ManagedTemplate,
  ManagedTemplateChange,
  ManagedTemplatePushTarget,
  ManagedTemplateSettings,
} from '../shared/managed-agents-types';
import type { DurableAgentConfig } from '../shared/types';

type SetupInput = Omit<ManagedAgentSetup, 'version'>;
const call = <T>(channel: string, ...args: unknown[]): Promise<ManagedResult<T>> => ipcRenderer.invoke(channel, ...args);

const managed = {
  listParts: (kind: ManagedPartKind) => call<ManagedPartSummary[]>(IPC.MANAGED.LIST_PARTS, kind),
  getPart: (id: string) => call<ManagedPart>(IPC.MANAGED.GET_PART, id),
  createPart: (input: { name: string; description?: string; content: ManagedPartContent }) => call<ManagedPartSummary>(IPC.MANAGED.CREATE_PART, input),
  updatePart: (input: { id: string; expectedRevision: number; expectedName?: string; expectedDescription?: string; name?: string; description?: string; content?: ManagedPartContent }) => call<ManagedPartSummary>(IPC.MANAGED.UPDATE_PART, input),
  forkPart: (id: string, agent?: { projectPath: string; agentId: string }, name?: string) => call<ManagedPartSummary>(IPC.MANAGED.FORK_PART, id, agent, name),
  backToShared: (projectPath: string, agentId: string, id: string) => call<void>(IPC.MANAGED.BACK_TO_SHARED, projectPath, agentId, id),
  deletePart: (id: string, expectedRevision: number, mode: 'copy' | 'remove') => call<void>(IPC.MANAGED.DELETE_PART, id, expectedRevision, mode),
  consumers: (id: string) => call<ManagedPartConsumer[]>(IPC.MANAGED.CONSUMERS, id),
  getSetup: (projectPath: string, agentId: string) => call<ManagedAgentSetup | null>(IPC.MANAGED.GET_SETUP, projectPath, agentId),
  saveSetup: (projectPath: string, agentId: string, setup: SetupInput) => call<ManagedAgentSetup>(IPC.MANAGED.SAVE_SETUP, projectPath, agentId, setup),
  unmanage: (projectPath: string, agentId: string) => call<void>(IPC.MANAGED.UNMANAGE, projectPath, agentId),
  preview: (projectPath: string, agentId: string, setup?: SetupInput) => call<ManagedPreview>(IPC.MANAGED.PREVIEW, projectPath, agentId, setup),
  /** What a New agent draft would get at its first start, rendered as delivery renders it. */
  previewDraft: (projectPath: string, input: { name: string; setup: SetupInput; settings?: ManagedTemplateSettings }) => call<ManagedPreview>(IPC.MANAGED.PREVIEW_DRAFT, projectPath, input),
  /** Effort levels by model id for a CLI; `default` is its default model's. */
  modelEfforts: (cli: string, projectPath?: string) => call<Record<string, string[]>>(IPC.MANAGED.MODEL_EFFORTS, cli, projectPath),
  listTemplates: () => call<Array<ManagedTemplate & { usedBy: number }>>(IPC.MANAGED.LIST_TEMPLATES),
  getTemplate: (id: string) => call<ManagedTemplate>(IPC.MANAGED.GET_TEMPLATE, id),
  saveTemplate: (input: Omit<ManagedTemplate, 'builtin' | 'updatedAt' | 'id'> & { id?: string }) => call<ManagedTemplate>(IPC.MANAGED.SAVE_TEMPLATE, input),
  deleteTemplate: (id: string) => call<void>(IPC.MANAGED.DELETE_TEMPLATE, id),
  templateFromAgent: (projectPath: string, agentId: string, name: string, description?: string) => call<ManagedTemplate>(IPC.MANAGED.TEMPLATE_FROM_AGENT, projectPath, agentId, name, description),
  previewTemplatePush: (id: string, next: Pick<ManagedTemplate, 'setup' | 'settings'>) =>
    call<{ changes: ManagedTemplateChange[]; targets: ManagedTemplatePushTarget[] }>(IPC.MANAGED.PREVIEW_TEMPLATE_PUSH, id, next),
  pushTemplate: (id: string, next: Pick<ManagedTemplate, 'setup' | 'settings'>, targets: Array<{ projectPath: string; agentId: string }>) => call<{ failed: Array<{ agentId: string; message: string }> }>(IPC.MANAGED.PUSH_TEMPLATE, id, next, targets),
  getDefaultHelperTemplate: () => call<string>(IPC.MANAGED.GET_DEFAULT_HELPER_TEMPLATE),
  setDefaultHelperTemplate: (id: string) => call<void>(IPC.MANAGED.SET_DEFAULT_HELPER_TEMPLATE, id),
  /** Whether orchestrators may name a template, or add and remove parts, for their helpers. */
  getHelperTemplateChoice: () => call<boolean>(IPC.MANAGED.GET_HELPER_TEMPLATE_CHOICE),
  setHelperTemplateChoice: (on: boolean) => call<void>(IPC.MANAGED.SET_HELPER_TEMPLATE_CHOICE, on),
  createAgent: (projectPath: string, input: { name: string; color: string; templateId?: string; setup?: SetupInput; settings?: ManagedTemplateSettings }) =>
    call<DurableAgentConfig>(IPC.MANAGED.CREATE_AGENT, projectPath, input),
  convertAgent: (projectPath: string, agentId: string, keep: boolean, templateId?: string) => call<ManagedAgentSetup>(IPC.MANAGED.CONVERT_AGENT, projectPath, agentId, keep, templateId),
  /** What "Keep what it has now" would make of the agent's files. Writes nothing. */
  previewConvert: (projectPath: string, agentId: string) => call<ManagedConvertPreview>(IPC.MANAGED.PREVIEW_CONVERT, projectPath, agentId),
  applySettings: (projectPath: string, agentId: string, settings: ManagedTemplateSettings) => call<void>(IPC.MANAGED.APPLY_SETTINGS, projectPath, agentId, settings),
  status: (projectPath: string, agentId: string) => call<ManagedAgentStatus>(IPC.MANAGED.STATUS, projectPath, agentId),
  /** Hide "Switched to managed when Clubhouse updated" for this agent (D59). */
  dismissMigrationNotice: (projectPath: string, agentId: string) => call<void>(IPC.MANAGED.DISMISS_MIGRATION_NOTICE, projectPath, agentId),
  isWorking: (agentId: string) => call<boolean>(IPC.MANAGED.IS_WORKING, agentId),
  restart: (projectPath: string, agentId: string, options?: { fresh?: boolean; whenTurnEnds?: boolean }) => call<{ resumed: boolean; noSession?: boolean }>(IPC.MANAGED.RESTART, projectPath, agentId, options),
  setClubhouseFeatures: (projectPath: string, agentId: string, on: boolean) => call<void>(IPC.MANAGED.SET_CLUBHOUSE_FEATURES, projectPath, agentId, on),
  /**
   * Skill import (#2894): each file's real executable bit, or null when it
   * can't be told (Windows, or a file that isn't on disk). The paths never
   * reach page code: they are resolved here from the File objects.
   */
  executableBits: (files: File[]) => {
    const paths = files.map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } });
    return call<Array<boolean | null>>(IPC.MANAGED.EXECUTABLE_BITS, paths);
  },
  /** Parts, templates or setups changed somewhere. Returns an unsubscribe function. */
  onChanged: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.MANAGED.CHANGED, handler);
    return () => { ipcRenderer.removeListener(IPC.MANAGED.CHANGED, handler); };
  },
};

export const managedAgents = { managed };
