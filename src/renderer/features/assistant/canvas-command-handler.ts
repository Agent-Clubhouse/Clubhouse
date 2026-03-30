/**
 * Renderer-side handler for canvas commands from the assistant.
 *
 * Listens for CANVAS_CMD.REQUEST from the main process, executes
 * canvas-store operations, and sends results back via CANVAS_CMD.RESULT.
 */

import { useAppCanvasStore, getProjectCanvasStore, getKnownProjectIds } from '../../plugins/builtin/canvas/main';
import type { CanvasViewType, Position, Size, CanvasView, CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { CanvasState } from '../../plugins/builtin/canvas/canvas-store';
import { exportBlueprint, importBlueprint, validateBlueprint } from '../../plugins/builtin/canvas/canvas-blueprint';
import type { CanvasBlueprint } from '../../plugins/builtin/canvas/canvas-blueprint';
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
  let canvas = store.canvases.find((c: CanvasInstance) => c.id === canvasId);
  // Fall back to app store if not found in project store
  if (!canvas && projectId) {
    const appStore = useAppCanvasStore.getState();
    canvas = appStore.canvases.find((c: CanvasInstance) => c.id === canvasId);
  }
  if (!canvas) {
    const allIds = [
      ...store.canvases.map((c: CanvasInstance) => c.id),
      ...(projectId ? useAppCanvasStore.getState().canvases.map((c: CanvasInstance) => c.id) : []),
    ];
    console.warn('[assistant] Canvas not found:', canvasId, 'available:', [...new Set(allIds)], 'pid:', normPid(projectId) || 'app');
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

/**
 * Search all canvases across all stores for a view with the given ID.
 * Returns { canvas_id, project_id } if found, or null.
 * Searches app store first, then all known project stores.
 */
function findCanvasForView(viewId: string, projectIdHint?: string): { canvas_id: string; project_id: string | null } | null {
  // Search app store first (most common case)
  const appStore = useAppCanvasStore.getState();
  for (const canvas of appStore.canvases) {
    if (canvas.views.some((v: CanvasView) => v.id === viewId)) {
      return { canvas_id: canvas.id, project_id: null };
    }
  }

  // Search hinted project store next
  if (projectIdHint) {
    const projectStore = getProjectCanvasStore(projectIdHint).getState();
    for (const canvas of projectStore.canvases) {
      if (canvas.views.some((v: CanvasView) => v.id === viewId)) {
        return { canvas_id: canvas.id, project_id: projectIdHint };
      }
    }
  }

  // Search all known project stores
  for (const pid of getKnownProjectIds()) {
    if (pid === projectIdHint) continue; // already searched
    const projectStore = getProjectCanvasStore(pid).getState();
    for (const canvas of projectStore.canvases) {
      if (canvas.views.some((v: CanvasView) => v.id === viewId)) {
        return { canvas_id: canvas.id, project_id: pid };
      }
    }
  }

  return null;
}

const MUTATING_COMMANDS = new Set(['add_canvas', 'add_view', 'move_view', 'resize_view', 'remove_view', 'rename_view', 'connect_views', 'import_blueprint']);

/**
 * Execute a command on a specific canvas, switching active canvas if needed.
 *
 * Canvas lookup searches the project store first (if projectId given), then
 * falls back to the app store. This handles the common case where create_canvas
 * is called without a project_id (app-level) but add_card passes project_id
 * for agent binding — the canvas lives in the app store, not the project store.
 */
function withCanvas<T>(canvasId: string, fn: (store: CanvasState) => T, projectId?: string): T | { error: string } {
  // Try the requested store first
  let store = getStore(projectId);
  let canvas = store.canvases.find((c: CanvasInstance) => c.id === canvasId);

  // If not found and we were looking in a project store, fall back to app store
  if (!canvas && projectId) {
    const appStore = useAppCanvasStore.getState();
    const appCanvas = appStore.canvases.find((c: CanvasInstance) => c.id === canvasId);
    if (appCanvas) {
      console.log('[assistant] Canvas found in app store (not project store), using app store for:', canvasId);
      store = appStore;
      canvas = appCanvas;
    }
  }

  // If still not found, re-read both stores (handles just-created canvases)
  if (!canvas) {
    store = getStore(projectId);
    canvas = store.canvases.find((c: CanvasInstance) => c.id === canvasId);
    if (!canvas && projectId) {
      const appStore = useAppCanvasStore.getState();
      canvas = appStore.canvases.find((c: CanvasInstance) => c.id === canvasId);
      if (canvas) {
        store = appStore;
      }
    }
    if (!canvas) {
      const allIds = [
        ...store.canvases.map((c: CanvasInstance) => c.id),
        ...(projectId ? useAppCanvasStore.getState().canvases.map((c: CanvasInstance) => c.id) : []),
      ];
      console.error('[assistant] Canvas not found in any store:', canvasId, 'available:', allIds);
      return { error: `Canvas not found: ${canvasId}. Available: ${[...new Set(allIds)].join(', ')}` };
    }
  }

  const prevActive = store.activeCanvasId;
  if (prevActive !== canvasId) store.setActiveCanvas(canvasId);
  const result = fn(store);
  if (prevActive && prevActive !== canvasId) store.setActiveCanvas(prevActive);
  return result;
}

const handlers: Record<string, (args: Record<string, unknown>) => CanvasCommandResult> = {
  find_canvas_for_view(args) {
    const viewId = args.view_id as string;
    const pid = args.project_id as string | undefined;
    if (!viewId) return { success: false, error: 'view_id is required' };
    const found = findCanvasForView(viewId, pid);
    if (!found) return { success: false, error: `No canvas contains view: ${viewId}` };
    return { success: true, data: found };
  },

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

      return { view_id: viewId, canvas_id: canvasId, agent_bound: !!(args.agent_id) };
    }, pid);

    if ('error' in result) return { success: false, error: result.error };
    return { success: true, data: result };
  },

  move_view(args) {
    const canvasId = args.canvas_id as string;
    const pid = args.project_id as string | undefined;
    const result = withCanvas(canvasId, (store) => {
      const pos = args.position as Record<string, number>;
      store.moveView(args.view_id as string, { x: pos?.x || 0, y: pos?.y || 0 });
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true, data: { canvas_id: canvasId, view_id: args.view_id } };
  },

  resize_view(args) {
    const canvasId = args.canvas_id as string;
    const pid = args.project_id as string | undefined;
    const result = withCanvas(canvasId, (store) => {
      const sizeArg = args.size as Record<string, number>;
      store.resizeView(args.view_id as string, {
        width: sizeArg?.w || sizeArg?.width || 300,
        height: sizeArg?.h || sizeArg?.height || 200,
      });
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true, data: { canvas_id: canvasId, view_id: args.view_id } };
  },

  remove_view(args) {
    const canvasId = args.canvas_id as string;
    const pid = args.project_id as string | undefined;
    const result = withCanvas(canvasId, (store) => {
      store.removeView(args.view_id as string);
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true, data: { canvas_id: canvasId, view_id: args.view_id } };
  },

  rename_view(args) {
    const canvasId = args.canvas_id as string;
    const pid = args.project_id as string | undefined;
    const result = withCanvas(canvasId, (store) => {
      store.renameView(args.view_id as string, args.name as string);
    }, pid);
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true, data: { canvas_id: canvasId, view_id: args.view_id } };
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

    // Bidirectional: default true for agent-to-agent, false otherwise
    const isAgentToAgent = targetKind === 'agent';
    const bidirectional = args.bidirectional !== undefined
      ? Boolean(args.bidirectional)
      : isAgentToAgent;

    let reverseBindingCreated = false;
    if (bidirectional && isAgentToAgent) {
      // Create reverse wire: target → source
      store.addWireDefinition({
        agentId: targetId,
        targetId: sourceAgentId,
        targetKind: 'agent' as any,
        label: wireSrcName,
        agentName: wireTgtName,
        targetName: wireSrcName,
      });

      try {
        window.clubhouse.mcpBinding.bind(targetId, {
          targetId: sourceAgentId,
          targetKind: 'agent',
          label: wireSrcName,
          agentName: wireTgtName,
          targetName: wireSrcName,
        });
        reverseBindingCreated = true;
      } catch (err) {
        console.warn('[assistant] Reverse MCP binding failed (agent may be sleeping):', targetId, err);
      }
    }

    return { success: true, data: { canvas_id: canvasId, sourceAgentId, targetId, targetKind, bindingCreated, bidirectional, reverseBindingCreated } };
  },

  export_blueprint(args) {
    const canvasId = args.canvas_id as string;
    const pid = args.project_id as string | undefined;
    const canvas = findCanvas(canvasId, pid);
    if (!canvas) return { success: false, error: `Canvas not found: ${canvasId}` };

    const blueprint = exportBlueprint(canvas);
    return { success: true, data: blueprint };
  },

  import_blueprint(args) {
    const pid = args.project_id as string | undefined;
    const blueprint = args.blueprint as CanvasBlueprint;

    const validationError = validateBlueprint(blueprint);
    if (validationError) {
      return { success: false, error: validationError };
    }

    try {
      const name = args.name as string | undefined;
      const canvas = importBlueprint(blueprint, { name });
      const store = getStore(pid);
      store.insertCanvas(canvas);
      return {
        success: true,
        data: {
          canvas_id: canvas.id,
          name: canvas.name,
          view_count: canvas.views.length,
          view_ids: canvas.views.map((v) => v.id),
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * Initialize the canvas command handler.
 * Returns a cleanup function.
 */
export function initCanvasCommandHandler(): (() => void) | undefined {
  console.log('[assistant] Canvas command handler initializing');
  const cleanup = window.clubhouse.canvas?.onCommand?.(async (request: CanvasCommandRequest) => {
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

      // For create operations, persist BEFORE returning the result so the
      // canvas is available by the time the next command (e.g. add_card) arrives.
      if (request.command === 'add_canvas' && result.success) {
        await persistCanvas(request.args.project_id as string | undefined);
      }

      sendResult(request.callId, result);

      // Auto-save after other mutating commands (fire-and-forget is fine here)
      if (MUTATING_COMMANDS.has(request.command) && result.success && request.command !== 'add_canvas') {
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
