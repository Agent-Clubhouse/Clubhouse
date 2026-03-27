/**
 * Renderer-side handler for canvas commands from the assistant.
 *
 * Listens for CANVAS_CMD.REQUEST from the main process, executes
 * canvas-store operations, and sends results back via CANVAS_CMD.RESULT.
 */

import { useAppCanvasStore, getProjectCanvasStore } from '../../plugins/builtin/canvas/main';
import type { CanvasViewType, Position, Size, CanvasView, CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { CanvasState } from '../../plugins/builtin/canvas/canvas-store';
import { createScopedStorage } from '../../plugins/plugin-api-storage';
import type { ScopedStorage } from '../../../shared/plugin-types';

interface CanvasCommandRequest {
  callId: string;
  command: string;
  args: Record<string, unknown>;
}

interface CanvasCommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

function sendResult(callId: string, result: CanvasCommandResult): void {
  window.clubhouse.canvas?.sendCommandResult?.(callId, result);
}

/** Normalize project ID — treat 'app', '', null as app-level (no project). */
function normPid(pid: unknown): string | undefined {
  if (!pid || pid === 'app' || pid === '') return undefined;
  return pid as string;
}

function getStore(projectId?: string): CanvasState {
  const pid = normPid(projectId);
  if (pid) return getProjectCanvasStore(pid).getState();
  return useAppCanvasStore.getState();
}

function getStorage(projectId?: string): ScopedStorage {
  const pid = normPid(projectId);
  if (pid) return createScopedStorage('canvas', 'project-local', pid);
  return createScopedStorage('canvas', 'global');
}

function findCanvas(canvasId: string, projectId?: string): CanvasInstance | undefined {
  const store = getStore(projectId);
  const canvas = store.canvases.find((c: CanvasInstance) => c.id === canvasId);
  if (!canvas) {
    const allIds = store.canvases.map((c: CanvasInstance) => c.id);
    console.warn('[assistant] Canvas not found:', canvasId, 'available:', allIds, 'pid:', normPid(projectId) || 'app');
  }
  return canvas;
}

async function persistCanvas(projectId?: string): Promise<void> {
  try {
    const store = getStore(projectId);
    const storage = getStorage(projectId);
    await store.saveCanvas(storage);
    await store.saveWires(storage);
    console.log('[assistant] Canvas saved', { projectId: projectId || 'app' });
  } catch (err) {
    console.warn('[assistant] Canvas save failed:', err);
  }
}

const MUTATING_COMMANDS = new Set(['add_canvas', 'add_view', 'move_view', 'resize_view', 'remove_view', 'rename_view', 'connect_views']);

/** Execute a command on a specific canvas, temporarily switching active canvas if needed. */
function withCanvas<T>(canvasId: string, fn: (store: CanvasState) => T, projectId?: string): T | { error: string } {
  const store = getStore(projectId);
  const canvas = store.canvases.find((c: CanvasInstance) => c.id === canvasId);
  if (!canvas) return { error: `Canvas not found: ${canvasId}` };

  const prevActive = store.activeCanvasId;
  if (prevActive !== canvasId) store.setActiveCanvas(canvasId);
  const result = fn(store);
  if (prevActive && prevActive !== canvasId) store.setActiveCanvas(prevActive);
  return result;
}

const handlers: Record<string, (args: Record<string, unknown>) => CanvasCommandResult> = {
  add_canvas(args) {
    const pid = args.project_id as string | undefined;
    const store = getStore(pid);
    const id = store.addCanvas();
    if (args.name) {
      store.renameCanvas(id, args.name as string);
    }
    return { success: true, data: { canvas_id: id } };
  },

  list_canvases(args) {
    const pid = args.project_id as string | undefined;
    const store = getStore(pid);
    const canvases = store.canvases.map((c: CanvasInstance) => ({
      id: c.id,
      name: c.name,
      cardCount: c.views.length,
    }));
    return { success: true, data: canvases };
  },

  add_view(args) {
    const canvasId = args.canvas_id as string;
    const pid = args.project_id as string | undefined;
    const result = withCanvas(canvasId, (store) => {
      const type = args.type as CanvasViewType;
      const position: Position = args.position
        ? { x: (args.position as Record<string, number>).x || 0, y: (args.position as Record<string, number>).y || 0 }
        : { x: 100, y: 100 };

      const viewId = store.addView(type, position);

      if (args.display_name && viewId) {
        store.renameView(viewId, args.display_name as string);
      }

      if (args.size && viewId) {
        const sizeArg = args.size as Record<string, number>;
        const size: Size = {
          width: sizeArg.w || sizeArg.width || 300,
          height: sizeArg.h || sizeArg.height || 200,
        };
        store.resizeView(viewId, size);
      }

      // Bind agent ID and project ID if provided (makes the card a real agent card, not a placeholder)
      if (viewId && type === 'agent' && args.agent_id) {
        const agentId = args.agent_id as string;
        const projectId = args.project_id as string | undefined;
        const agentName = (args.display_name as string) || agentId;
        store.updateView(viewId, {
          agentId,
          projectId,
          title: agentName,
          displayName: agentName,
          metadata: {
            agentId,
            projectId: projectId ?? null,
            agentName,
            projectName: null, // could resolve from project store but not critical
          },
        } as any);
        console.log('[assistant] Agent card bound:', { viewId, agentId, projectId });
      }

      return { view_id: viewId, agent_bound: !!(args.agent_id) };
    }, pid);

    if ('error' in result) return { success: false, error: result.error };
    return { success: true, data: result };
  },

  move_view(args) {
    const pid = args.project_id as string | undefined;
    const result = withCanvas(args.canvas_id as string, (store) => {
      const pos = args.position as Record<string, number>;
      store.moveView(args.view_id as string, { x: pos?.x || 0, y: pos?.y || 0 });
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  resize_view(args) {
    const pid = args.project_id as string | undefined;
    const result = withCanvas(args.canvas_id as string, (store) => {
      const sizeArg = args.size as Record<string, number>;
      store.resizeView(args.view_id as string, {
        width: sizeArg?.w || sizeArg?.width || 300,
        height: sizeArg?.h || sizeArg?.height || 200,
      });
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  remove_view(args) {
    const pid = args.project_id as string | undefined;
    const result = withCanvas(args.canvas_id as string, (store) => {
      store.removeView(args.view_id as string);
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  rename_view(args) {
    const pid = args.project_id as string | undefined;
    const result = withCanvas(args.canvas_id as string, (store) => {
      store.renameView(args.view_id as string, args.name as string);
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  query_views(args) {
    const pid = args.project_id as string | undefined;
    const canvas = findCanvas(args.canvas_id as string, pid);
    if (!canvas) return { success: false, error: `Canvas not found: ${args.canvas_id}` };

    const views = canvas.views.map((v: CanvasView) => ({
      id: v.id,
      type: v.type,
      displayName: v.displayName,
      position: v.position,
      size: v.size,
    }));
    return { success: true, data: views };
  },

  connect_views(args) {
    const canvasId = args.canvas_id as string;
    const sourceViewId = args.source_view_id as string;
    const targetViewId = args.target_view_id as string;
    const pid = args.project_id as string | undefined;

    const canvas = findCanvas(canvasId, pid);
    if (!canvas) return { success: false, error: `Canvas not found: ${canvasId}` };

    const sourceView = canvas.views.find((v: CanvasView) => v.id === sourceViewId);
    const targetView = canvas.views.find((v: CanvasView) => v.id === targetViewId);
    if (!sourceView) return { success: false, error: `Source view not found: ${sourceViewId}` };
    if (!targetView) return { success: false, error: `Target view not found: ${targetViewId}` };

    if (sourceView.type !== 'agent' && sourceView.type !== 'zone') {
      return { success: false, error: 'Source must be an agent or zone card' };
    }

    // Determine target kind and ID
    let targetKind: string;
    let targetId: string;
    if (targetView.type === 'agent') {
      targetKind = 'agent';
      targetId = (targetView as any).agentId || targetView.id;
    } else if (targetView.type === 'plugin') {
      const widgetType = (targetView as any).pluginWidgetType || '';
      if (widgetType.includes('group-project')) {
        targetKind = 'group-project';
        targetId = String(targetView.metadata?.groupProjectId || targetView.id);
      } else if (widgetType.includes('agent-queue')) {
        targetKind = 'agent-queue';
        targetId = String(targetView.metadata?.queueId || targetView.id);
      } else {
        targetKind = 'browser';
        targetId = targetView.id;
      }
    } else if (targetView.type === 'zone') {
      targetKind = 'zone';
      targetId = targetView.id;
    } else {
      targetKind = 'browser';
      targetId = targetView.id;
    }

    const sourceAgentId = (sourceView as any).agentId;
    if (!sourceAgentId) {
      return { success: false, error: 'Source agent card has no agent assigned' };
    }

    const wireLabel = targetView.displayName || targetView.title;
    const wireSrcName = sourceView.displayName || sourceView.title;
    const wireTgtName = wireLabel;

    // Always persist wire definition — survives agent sleep/wake
    const store = getStore(pid);
    store.addWireDefinition({
      agentId: sourceAgentId,
      targetId,
      targetKind: targetKind as any,
      label: wireLabel,
      agentName: wireSrcName,
      targetName: wireTgtName,
    });

    // Try to create live MCP binding — may fail if agent is sleeping (that's OK,
    // the wire definition will activate the binding when the agent wakes up)
    let bindingCreated = false;
    try {
      window.clubhouse.mcpBinding.bind(sourceAgentId, {
        targetId,
        targetKind,
        label: wireLabel,
        agentName: wireSrcName,
        targetName: wireTgtName,
      });
      bindingCreated = true;
    } catch (err) {
      console.warn('[assistant] MCP binding failed (agent may be sleeping):', sourceAgentId, err);
    }

    return { success: true, data: { sourceAgentId, targetId, targetKind, bindingCreated } };
  },
};

/**
 * Initialize the canvas command handler.
 * Returns a cleanup function.
 */
export function initCanvasCommandHandler(): (() => void) | undefined {
  console.log('[assistant] Canvas command handler initializing');
  const cleanup = window.clubhouse.canvas?.onCommand?.((request: CanvasCommandRequest) => {
    console.log('[assistant] Canvas command received:', request.command, request.callId);
    const handler = handlers[request.command];
    if (!handler) {
      console.warn('[assistant] Unknown canvas command:', request.command);
      sendResult(request.callId, { success: false, error: `Unknown canvas command: ${request.command}` });
      return;
    }
    try {
      const result = handler(request.args);
      console.log('[assistant] Canvas command result:', request.command, result.success);
      sendResult(request.callId, result);

      // Auto-save after mutating commands
      if (MUTATING_COMMANDS.has(request.command) && result.success) {
        persistCanvas(request.args.project_id as string | undefined);
      }
    } catch (err) {
      console.error('[assistant] Canvas command error:', request.command, err);
      sendResult(request.callId, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  if (cleanup) {
    console.log('[assistant] Canvas command handler ready');
  } else {
    console.warn('[assistant] Canvas command handler: window.clubhouse.canvas.onCommand not available');
  }
  return cleanup;
}
