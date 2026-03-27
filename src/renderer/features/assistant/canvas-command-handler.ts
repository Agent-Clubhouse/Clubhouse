/**
 * Renderer-side handler for canvas commands from the assistant.
 *
 * Listens for CANVAS_CMD.REQUEST from the main process, executes
 * canvas-store operations, and sends results back via CANVAS_CMD.RESULT.
 */

import { useAppCanvasStore } from '../../plugins/builtin/canvas/main';
import type { CanvasViewType, Position, Size, CanvasView, CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { CanvasState } from '../../plugins/builtin/canvas/canvas-store';

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

function getStore(): CanvasState {
  return useAppCanvasStore.getState();
}

function findCanvas(canvasId: string): CanvasInstance | undefined {
  return getStore().canvases.find((c: CanvasInstance) => c.id === canvasId);
}

/** Execute a command on a specific canvas, temporarily switching active canvas if needed. */
function withCanvas<T>(canvasId: string, fn: (store: CanvasState) => T): T | { error: string } {
  const store = getStore();
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
    const store = getStore();
    const id = store.addCanvas();
    if (args.name) {
      store.renameCanvas(id, args.name as string);
    }
    return { success: true, data: { canvas_id: id } };
  },

  list_canvases() {
    const store = getStore();
    const canvases = store.canvases.map((c: CanvasInstance) => ({
      id: c.id,
      name: c.name,
      cardCount: c.views.length,
    }));
    return { success: true, data: canvases };
  },

  add_view(args) {
    const canvasId = args.canvas_id as string;
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

      return { view_id: viewId };
    });

    if ('error' in result) return { success: false, error: result.error };
    return { success: true, data: result };
  },

  move_view(args) {
    const result = withCanvas(args.canvas_id as string, (store) => {
      const pos = args.position as Record<string, number>;
      store.moveView(args.view_id as string, { x: pos?.x || 0, y: pos?.y || 0 });
    });
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  resize_view(args) {
    const result = withCanvas(args.canvas_id as string, (store) => {
      const sizeArg = args.size as Record<string, number>;
      store.resizeView(args.view_id as string, {
        width: sizeArg?.w || sizeArg?.width || 300,
        height: sizeArg?.h || sizeArg?.height || 200,
      });
    });
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  remove_view(args) {
    const result = withCanvas(args.canvas_id as string, (store) => {
      store.removeView(args.view_id as string);
    });
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  rename_view(args) {
    const result = withCanvas(args.canvas_id as string, (store) => {
      store.renameView(args.view_id as string, args.name as string);
    });
    if (result && 'error' in result) return { success: false, error: result.error };
    return { success: true };
  },

  query_views(args) {
    const canvas = findCanvas(args.canvas_id as string);
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

    const canvas = findCanvas(canvasId);
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

    // Create MCP binding
    window.clubhouse.mcpBinding.bind(sourceAgentId, {
      targetId,
      targetKind,
      label: targetView.displayName || targetView.title,
      agentName: sourceView.displayName || sourceView.title,
      targetName: targetView.displayName || targetView.title,
    });

    // Persist wire definition
    const store = getStore();
    store.addWireDefinition({
      agentId: sourceAgentId,
      targetId,
      targetKind: targetKind as any,
      label: targetView.displayName || targetView.title,
      agentName: sourceView.displayName || sourceView.title,
      targetName: targetView.displayName || targetView.title,
    });

    return { success: true, data: { sourceAgentId, targetId, targetKind } };
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
