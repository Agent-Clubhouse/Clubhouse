import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const window = {
  window: {
  createPopout: (params: { type: 'agent' | 'hub' | 'canvas'; agentId?: string; hubId?: string; canvasId?: string; projectId?: string; title?: string }) =>
    ipcRenderer.invoke(IPC.WINDOW.CREATE_POPOUT, params),
  closePopout: (windowId: number) =>
    ipcRenderer.invoke(IPC.WINDOW.CLOSE_POPOUT, windowId),
  listPopouts: () =>
    ipcRenderer.invoke(IPC.WINDOW.LIST_POPOUTS),
  isPopout: () => process.argv.some((a: string) => a.startsWith('--popout-type=')),
  getPopoutParams: (): { type: string; agentId?: string; hubId?: string; canvasId?: string; projectId?: string } | null => {
    const typeArg = process.argv.find((a: string) => a.startsWith('--popout-type='));
    if (!typeArg) return null;
    const type = typeArg.split('=')[1];
    const agentArg = process.argv.find((a: string) => a.startsWith('--popout-agent-id='));
    const hubArg = process.argv.find((a: string) => a.startsWith('--popout-hub-id='));
    const canvasArg = process.argv.find((a: string) => a.startsWith('--popout-canvas-id='));
    const projectArg = process.argv.find((a: string) => a.startsWith('--popout-project-id='));
    return {
      type,
      agentId: agentArg?.split('=')[1],
      hubId: hubArg?.split('=')[1],
      canvasId: canvasArg?.split('=')[1],
      projectId: projectArg?.split('=')[1],
    };
  },
  focusMain: (agentId?: string) =>
    ipcRenderer.invoke(IPC.WINDOW.FOCUS_MAIN, agentId),
  onNavigateToAgent: (callback: (agentId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string) => callback(agentId);
    ipcRenderer.on(IPC.WINDOW.NAVIGATE_TO_AGENT, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.NAVIGATE_TO_AGENT, listener); };
  },
  onNavigateToPluginSettings: (callback: (pluginId?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pluginId?: string) => callback(pluginId);
    ipcRenderer.on(IPC.WINDOW.NAVIGATE_TO_PLUGIN_SETTINGS, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.NAVIGATE_TO_PLUGIN_SETTINGS, listener); };
  },
  getAgentState: (): Promise<{
    agents: Record<string, unknown>;
    agentDetailedStatus: Record<string, unknown>;
    agentIcons: Record<string, string>;
  }> =>
    ipcRenderer.invoke(IPC.WINDOW.GET_AGENT_STATE),
  onRequestAgentState: (callback: (requestId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string) => callback(requestId);
    ipcRenderer.on(IPC.WINDOW.REQUEST_AGENT_STATE, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.REQUEST_AGENT_STATE, listener); };
  },
  respondAgentState: (requestId: string, state: {
    agents: Record<string, unknown>;
    agentDetailedStatus: Record<string, unknown>;
    agentIcons: Record<string, string>;
  }) =>
    ipcRenderer.send(IPC.WINDOW.AGENT_STATE_RESPONSE, requestId, state),
  broadcastAgentState: (state: {
    agents: Record<string, unknown>;
    agentDetailedStatus: Record<string, unknown>;
    agentIcons: Record<string, string>;
  }) =>
    ipcRenderer.send(IPC.WINDOW.AGENT_STATE_CHANGED, state),
  onAgentStateChanged: (callback: (state: {
    agents: Record<string, unknown>;
    agentDetailedStatus: Record<string, unknown>;
    agentIcons: Record<string, string>;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on(IPC.WINDOW.AGENT_STATE_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.AGENT_STATE_CHANGED, listener); };
  },

  // Hub state sync — leader/follower protocol
  getHubState: (hubId: string, scope: string, projectId?: string): Promise<{
    hubId: string;
    paneTree: unknown;
    focusedPaneId: string;
    zoomedPaneId: string | null;
  } | null> =>
    ipcRenderer.invoke(IPC.WINDOW.GET_HUB_STATE, hubId, scope, projectId),
  onRequestHubState: (callback: (requestId: string, hubId: string, scope: string, projectId?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string, hubId: string, scope: string, projectId?: string) =>
      callback(requestId, hubId, scope, projectId);
    ipcRenderer.on(IPC.WINDOW.REQUEST_HUB_STATE, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.REQUEST_HUB_STATE, listener); };
  },
  respondHubState: (requestId: string, state: {
    hubId: string;
    paneTree: unknown;
    focusedPaneId: string;
    zoomedPaneId: string | null;
  } | null) =>
    ipcRenderer.send(IPC.WINDOW.HUB_STATE_RESPONSE, requestId, state),
  onHubStateChanged: (callback: (state: {
    hubId: string;
    paneTree: unknown;
    focusedPaneId: string;
    zoomedPaneId: string | null;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on(IPC.WINDOW.HUB_STATE_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.HUB_STATE_CHANGED, listener); };
  },
  broadcastHubState: (state: {
    hubId: string;
    paneTree: unknown;
    focusedPaneId: string;
    zoomedPaneId: string | null;
  }) =>
    ipcRenderer.send(IPC.WINDOW.HUB_STATE_CHANGED, state),
  sendHubMutation: (hubId: string, scope: string, mutation: unknown, projectId?: string) =>
    ipcRenderer.send(IPC.WINDOW.HUB_MUTATION, hubId, scope, mutation, projectId),
  onHubMutation: (callback: (hubId: string, scope: string, mutation: unknown, projectId?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, hubId: string, scope: string, mutation: unknown, projectId?: string) =>
      callback(hubId, scope, mutation, projectId);
    ipcRenderer.on(IPC.WINDOW.HUB_MUTATION, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.HUB_MUTATION, listener); };
  },

  // Canvas state sync — leader/follower protocol
  getCanvasState: (canvasId: string, scope: string, projectId?: string): Promise<{
    canvasId: string;
    name: string;
    views: unknown[];
    viewport: { panX: number; panY: number; zoom: number };
    nextZIndex: number;
    zoomedViewId: string | null;
    wireDefinitions?: unknown[];
    zoneWireDefinitions?: unknown[];
  } | null> =>
    ipcRenderer.invoke(IPC.WINDOW.GET_CANVAS_STATE, canvasId, scope, projectId),
  onRequestCanvasState: (callback: (requestId: string, canvasId: string, scope: string, projectId?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string, canvasId: string, scope: string, projectId?: string) =>
      callback(requestId, canvasId, scope, projectId);
    ipcRenderer.on(IPC.WINDOW.REQUEST_CANVAS_STATE, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.REQUEST_CANVAS_STATE, listener); };
  },
  respondCanvasState: (requestId: string, state: {
    canvasId: string;
    name: string;
    views: unknown[];
    viewport: { panX: number; panY: number; zoom: number };
    nextZIndex: number;
    zoomedViewId: string | null;
  } | null) =>
    ipcRenderer.send(IPC.WINDOW.CANVAS_STATE_RESPONSE, requestId, state),
  onCanvasStateChanged: (callback: (state: {
    canvasId: string;
    name: string;
    views: unknown[];
    viewport: { panX: number; panY: number; zoom: number };
    nextZIndex: number;
    zoomedViewId: string | null;
    wireDefinitions?: unknown[];
    zoneWireDefinitions?: unknown[];
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on(IPC.WINDOW.CANVAS_STATE_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.CANVAS_STATE_CHANGED, listener); };
  },
  broadcastCanvasState: (state: {
    canvasId: string;
    name: string;
    views: unknown[];
    viewport: { panX: number; panY: number; zoom: number };
    nextZIndex: number;
    zoomedViewId: string | null;
  }) =>
    ipcRenderer.send(IPC.WINDOW.CANVAS_STATE_CHANGED, state),
  sendCanvasMutation: (canvasId: string, scope: string, mutation: unknown, projectId?: string) =>
    ipcRenderer.send(IPC.WINDOW.CANVAS_MUTATION, canvasId, scope, mutation, projectId),
  onCanvasMutation: (callback: (canvasId: string, scope: string, mutation: unknown, projectId?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, canvasId: string, scope: string, mutation: unknown, projectId?: string) =>
      callback(canvasId, scope, mutation, projectId);
    ipcRenderer.on(IPC.WINDOW.REQUEST_CANVAS_MUTATION, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.REQUEST_CANVAS_MUTATION, listener); };
  },
  requestDurableReload: (projectId: string) =>
    ipcRenderer.send(IPC.WINDOW.REQUEST_DURABLE_RELOAD, projectId),
  onRequestDurableReload: (callback: (projectId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId);
    ipcRenderer.on(IPC.WINDOW.REQUEST_DURABLE_RELOAD, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.REQUEST_DURABLE_RELOAD, listener); };
  },
  setTitle: (title: string) =>
    ipcRenderer.invoke(IPC.WINDOW.SET_TITLE, title),
  focusPopout: (windowId: number) =>
    ipcRenderer.invoke(IPC.WINDOW.FOCUS_POPOUT, windowId),
  onPopoutsChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.WINDOW.POPOUTS_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.WINDOW.POPOUTS_CHANGED, listener); };
  },
  },
};
