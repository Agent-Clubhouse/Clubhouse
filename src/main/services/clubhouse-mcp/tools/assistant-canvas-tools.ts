import { registerMcpCommand, toCommandId } from '../mcp-command-adapter';
import { appLog } from '../../log-service';
import { sendCanvasCommand } from '../canvas-command';
import { computeRelativePosition, layoutGrid, DEFAULT_CARD_SIZES } from '../canvas-layout';
import { layoutElk } from '../elk-layout';
import type { ElkAlgorithm, LayeredDirection } from '../elk-layout';
import type { RelativePosition } from '../canvas-layout';
import { requireString, optionalString, stringWithDefault } from './validation';

// Track card count per canvas for auto-staggering default positions.
// Note: counter only increments — does not account for card removal. This is
// acceptable because layout_canvas (which should always be called after adding
// cards) resets the counter and re-arranges all cards.
const canvasCardCounters = new Map<string, number>();

/**
 * Resolve canvas_id from view IDs.
 * When canvas_id is not provided, infers from view IDs.
 * When canvas_id IS provided, validates it against inference — if inference
 * disagrees, overrides with the inferred value and logs a warning.
 */
async function resolveCanvasId(args: Record<string, unknown>, ...viewIdKeys: string[]): Promise<string | null> {
  const providedCanvasId = optionalString(args, 'canvas_id');

  // Try to infer canvas_id from view IDs
  for (const key of viewIdKeys) {
    const viewId = optionalString(args, key);
    if (!viewId) continue;
    const result = await sendCanvasCommand('find_canvas_for_view', { view_id: viewId, project_id: args.project_id });
    if (result.success && result.data) {
      const data = result.data as { canvas_id: string; project_id: string | null };
      // If provided canvas_id disagrees with inference, override it
      if (providedCanvasId && providedCanvasId !== data.canvas_id) {
        appLog('core:assistant', 'warn', `canvas_id override: provided "${providedCanvasId}" but view belongs to "${data.canvas_id}" — using inferred value`);
      }
      return data.canvas_id;
    }
  }

  // No inference possible — use provided canvas_id or null
  return providedCanvasId || null;
}

/** Register all canvas tools (create, list, add/move/resize/remove cards, layout, blueprint). */
export function registerCanvasTools(): void {

// ══════════════════════════════════════════════════════════════════════════
// CANVAS TOOLS (Phase 5)
// ══════════════════════════════════════════════════════════════════════════

registerMcpCommand({
  id: toCommandId('assistant', 'create_canvas'),
  category: 'assistant',
  label: 'Create Canvas',
  description: 'Create a new canvas tab. Provide project_id to create in a specific project, otherwise creates at app level.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', description: 'Canvas name. Auto-generated if omitted.' },
    project_id: { type: 'string', description: 'Project ID to create canvas in. Omit for app-level.' },
  } },
  targetKind: 'assistant',
  nameSuffix: 'create_canvas',
  handler: async (_t, _a, args) => {
    const result = await sendCanvasCommand('add_canvas', { name: args.name, project_id: args.project_id });
    if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to create canvas' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'list_canvases'),
  category: 'assistant',
  label: 'List Canvases',
  description: 'List all canvases with their IDs, names, and card counts.',
  inputSchema: { type: 'object', properties: {
    project_id: { type: 'string', description: 'Project ID to list canvases for. Omit for app-level.' },
  } },
  targetKind: 'assistant',
  nameSuffix: 'list_canvases',
  handler: async (_t, _a, args) => {
    const result = await sendCanvasCommand('list_canvases', { project_id: args.project_id });
    if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to list canvases' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'add_card'),
  category: 'assistant',
  label: 'Add Card',
  description:
    'Add a card to a canvas. Types: "agent" (for durable agents), "zone" (visual grouping container), "anchor" (text-only label), "sticky-note" (note with text and color). ' +
    'For agent cards, ALWAYS provide agent_id and project_id to bind a real agent. ' +
    'For sticky notes, provide content (text) and optionally color (yellow/pink/blue/green/purple). ' +
    'Cards are auto-staggered when no position is specified. ALWAYS call layout_canvas after adding all cards. ' +
    'Anchors are just labels — they CANNOT be wired or used for coordination. Use group project cards for coordination. ' +
    'To place a card inside a zone, set zone_id to the zone\'s view ID — the card will be auto-positioned within that zone. ' +
    'To place a card relative to another card, use relative_to_card_id + relative_position (e.g., "right", "below") + optional relative_buffer.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      type: { type: 'string', description: 'Card type: "agent", "zone", "anchor", or "sticky-note".' },
      display_name: { type: 'string', description: 'Display name for the card.' },
      agent_id: { type: 'string', description: 'For agent cards: the durable agent ID (from list_agents) to bind to this card.' },
      project_id: { type: 'string', description: 'For agent cards: the project ID the agent belongs to (from list_projects).' },
      content: { type: 'string', description: 'For sticky-note cards: the text content (markdown supported).' },
      color: { type: 'string', description: 'For sticky-note cards: background color — "yellow", "pink", "blue", "green", or "purple". Defaults to "yellow".' },
      position_x: { type: 'number', description: 'X position (number). Auto-staggered if omitted.' },
      position_y: { type: 'number', description: 'Y position (number). Auto-staggered if omitted.' },
      width: { type: 'number', description: 'Width in pixels as a number (default: agent=300, zone=600, anchor=200, sticky-note=250).' },
      height: { type: 'number', description: 'Height in pixels as a number (default: agent=200, zone=400, anchor=100, sticky-note=250).' },
      zone_id: { type: 'string', description: 'Zone view ID to place this card inside. Card will be auto-positioned within the zone bounds.' },
      relative_to_card_id: { type: 'string', description: 'View ID of an existing card to position relative to. Use with relative_position.' },
      relative_position: { type: 'string', description: 'Where to place relative to the reference card: "right", "left", "below", or "above". Defaults to "right".' },
      relative_buffer: { type: 'number', description: 'Gap in pixels between the reference card and the new card. Defaults to 60.' },
    },
    required: ['canvas_id', 'type'],
  },
  targetKind: 'assistant',
  nameSuffix: 'add_card',
  handler: async (_t, _a, args) => {
  const canvasId = requireString(args, 'canvas_id');
  const cardType = stringWithDefault(args, 'type', 'agent');
  const cmdArgs: Record<string, unknown> = {
    canvas_id: canvasId, type: args.type, display_name: args.display_name,
    agent_id: args.agent_id, project_id: args.project_id,
    content: args.content, color: args.color,
  };

  // Coerce width/height to numbers in case LLM passes strings
  const width = args.width !== undefined ? Number(args.width) : undefined;
  const height = args.height !== undefined ? Number(args.height) : undefined;

  // Resolve the effective card size (explicit > default for type)
  const defaults = DEFAULT_CARD_SIZES[cardType] || DEFAULT_CARD_SIZES.agent;
  const effectiveWidth = width ?? defaults.width;
  const effectiveHeight = height ?? defaults.height;

  if (args.relative_to_card_id) {
    // Relative positioning: place card relative to an existing card
    const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId });
    const views = queryResult.success ? (queryResult.data as Array<{ id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number } }>) : [];
    const refCard = views.find(v => v.id === args.relative_to_card_id);
    if (refCard) {
      const relPos = (args.relative_position as RelativePosition) || 'right';
      const buffer = args.relative_buffer !== undefined ? Number(args.relative_buffer) : undefined;
      const pos = computeRelativePosition(
        { x: refCard.position.x, y: refCard.position.y, width: refCard.size.width, height: refCard.size.height },
        relPos,
        effectiveWidth,
        effectiveHeight,
        buffer,
      );
      cmdArgs.position = pos;
    } else {
      // Reference card not found — fall through to auto-stagger
      appLog('core:assistant', 'warn', `add_card relative_to: card ${args.relative_to_card_id} not found, using auto-stagger`);
      const idx = canvasCardCounters.get(canvasId) || 0;
      const col = idx % 4;
      const rw = Math.floor(idx / 4);
      cmdArgs.position = { x: 100 + col * 340, y: 100 + rw * 260 };
      canvasCardCounters.set(canvasId, idx + 1);
    }
  } else if (args.zone_id) {
    // Auto-position within zone bounds
    const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId });
    const views = queryResult.success ? (queryResult.data as Array<{ id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number } }>) : [];
    const zone = views.find(v => v.id === args.zone_id);
    if (zone) {
      const ZONE_CARD_HEIGHT = 32;
      const ZONE_PADDING = 20;
      const cardsInZone = views.filter(v => v.id !== zone.id && v.type !== 'zone' &&
        v.position.x >= zone.position.x && v.position.x < zone.position.x + zone.size.width &&
        v.position.y >= zone.position.y && v.position.y < zone.position.y + zone.size.height);
      const col = cardsInZone.length % 3;
      const row = Math.floor(cardsInZone.length / 3);
      cmdArgs.position = {
        x: zone.position.x + ZONE_PADDING + col * 340,
        y: zone.position.y + ZONE_CARD_HEIGHT + ZONE_PADDING + row * 260,
      };
    } else {
      // Zone not found — fall through to auto-stagger
      const idx = canvasCardCounters.get(canvasId) || 0;
      const col = idx % 4;
      const rw = Math.floor(idx / 4);
      cmdArgs.position = { x: 100 + col * 340, y: 100 + rw * 260 };
      canvasCardCounters.set(canvasId, idx + 1);
    }
  } else if (args.position_x !== undefined || args.position_y !== undefined) {
    cmdArgs.position = { x: args.position_x ?? 100, y: args.position_y ?? 100 };
  } else {
    // Auto-stagger: each card offset 340px horizontally, wrap to next row after 4
    const idx = canvasCardCounters.get(canvasId) || 0;
    const col = idx % 4;
    const row = Math.floor(idx / 4);
    cmdArgs.position = { x: 100 + col * 340, y: 100 + row * 260 };
    canvasCardCounters.set(canvasId, idx + 1);
  }
  if (width !== undefined || height !== undefined) {
    cmdArgs.size = { w: effectiveWidth, h: effectiveHeight };
  }
  // Retry with backoff if canvas not found — handles race after create_canvas
  let result: Awaited<ReturnType<typeof sendCanvasCommand>> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await sendCanvasCommand('add_view', cmdArgs);
    if (result.success || !result.error?.includes('Canvas not found')) break;
    appLog('core:assistant', 'warn', `add_card retry ${attempt + 1}/3 — canvas not found yet`, { meta: { canvas_id: args.canvas_id } });
    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }
  if (!result!.success) return { content: [{ type: 'text', text: result!.error || 'Failed to add card' }], isError: true };
  // Include canvas_id in response for LLM context reinforcement
  const responseData = { ...(result!.data as Record<string, unknown>), canvas_id: canvasId };
  return { content: [{ type: 'text', text: JSON.stringify(responseData) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'move_card'),
  category: 'assistant',
  label: 'Move Card',
  description: 'Move a card to a new position on the canvas. Parameters are x and y (numbers). ' +
    'canvas_id is optional — it will be inferred from the view_id. ' +
    'To place a card inside a zone, set zone_id — the card will be centered in the zone. ' +
    'To position relative to another card, use relative_to_card_id + relative_position. ' +
    'Zone containment is spatial: a card is "inside" a zone when >50% of it overlaps the zone bounds.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID (optional — inferred from view_id if omitted).' },
      view_id: { type: 'string', description: 'Card view ID.' },
      x: { type: 'number', description: 'New X position (number).' },
      y: { type: 'number', description: 'New Y position (number).' },
      position_x: { type: 'number', description: 'Alias for x.' },
      position_y: { type: 'number', description: 'Alias for y.' },
      zone_id: { type: 'string', description: 'Zone view ID — auto-position card inside this zone instead of using x/y.' },
      relative_to_card_id: { type: 'string', description: 'View ID of an existing card to position relative to.' },
      relative_position: { type: 'string', description: 'Where to place: "right", "left", "below", "above". Defaults to "right".' },
      relative_buffer: { type: 'number', description: 'Gap in pixels between cards. Defaults to 60.' },
    },
    required: ['view_id'],
  },
  targetKind: 'assistant',
  nameSuffix: 'move_card',
  handler: async (_t, _a, args) => {
  const canvasId = await resolveCanvasId(args, 'view_id');
  if (!canvasId) {
    return { content: [{ type: 'text', text: 'Could not determine canvas_id. Provide canvas_id or ensure the view_id exists on a canvas.' }], isError: true };
  }

  // Accept position_x/position_y as aliases for x/y
  const targetX = args.x ?? args.position_x;
  const targetY = args.y ?? args.position_y;

  let position: { x: number; y: number };
  if (args.relative_to_card_id) {
    // Relative positioning
    const queryResult = await sendCanvasCommand('query_views', { canvas_id: args.canvas_id });
    const views = queryResult.success ? (queryResult.data as Array<{ id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number } }>) : [];
    const refCard = views.find(v => v.id === args.relative_to_card_id);
    if (!refCard) return { content: [{ type: 'text', text: `Reference card ${args.relative_to_card_id} not found.` }], isError: true };
    const movingCard = views.find(v => v.id === args.view_id);
    const movingWidth = movingCard?.size.width ?? 300;
    const movingHeight = movingCard?.size.height ?? 200;
    const relPos = (args.relative_position as RelativePosition) || 'right';
    const buffer = args.relative_buffer !== undefined ? Number(args.relative_buffer) : undefined;
    position = computeRelativePosition(
      { x: refCard.position.x, y: refCard.position.y, width: refCard.size.width, height: refCard.size.height },
      relPos,
      movingWidth,
      movingHeight,
      buffer,
    );
  } else if (args.zone_id) {
    // Auto-position within zone bounds
    const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId });
    const views = queryResult.success ? (queryResult.data as Array<{ id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number } }>) : [];
    const zone = views.find(v => v.id === args.zone_id);
    if (!zone) return { content: [{ type: 'text', text: `Zone ${args.zone_id} not found.` }], isError: true };
    const ZONE_CARD_HEIGHT = 32;
    const ZONE_PADDING = 20;
    position = {
      x: zone.position.x + ZONE_PADDING + (zone.size.width / 2 - 150),
      y: zone.position.y + ZONE_CARD_HEIGHT + ZONE_PADDING,
    };
  } else if (targetX !== undefined && targetY !== undefined) {
    position = { x: Number(targetX), y: Number(targetY) };
  } else {
    return { content: [{ type: 'text', text: 'Either x/y coordinates, zone_id, or relative_to_card_id is required.' }], isError: true };
  }

  const result = await sendCanvasCommand('move_view', { canvas_id: canvasId, view_id: args.view_id, position, project_id: args.project_id });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to move card' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify({ message: 'Card moved.', canvas_id: canvasId, view_id: args.view_id }) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'resize_card'),
  category: 'assistant',
  label: 'Resize Card',
  description: 'Resize a card on the canvas. canvas_id is optional — inferred from view_id.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID (optional — inferred from view_id if omitted).' },
      view_id: { type: 'string', description: 'Card view ID.' },
      width: { type: 'number', description: 'New width.' },
      height: { type: 'number', description: 'New height.' },
    },
    required: ['view_id', 'width', 'height'],
  },
  targetKind: 'assistant',
  nameSuffix: 'resize_card',
  handler: async (_t, _a, args) => {
  const canvasId = await resolveCanvasId(args, 'view_id');
  if (!canvasId) {
    return { content: [{ type: 'text', text: 'Could not determine canvas_id. Provide canvas_id or ensure the view_id exists on a canvas.' }], isError: true };
  }
  const result = await sendCanvasCommand('resize_view', { canvas_id: canvasId, view_id: args.view_id, size: { w: args.width, h: args.height }, project_id: args.project_id });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to resize card' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify({ message: 'Card resized.', canvas_id: canvasId, view_id: args.view_id }) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'remove_card'),
  category: 'assistant',
  label: 'Remove Card',
  description: 'Remove a card from the canvas. canvas_id is optional — inferred from view_id.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID (optional — inferred from view_id if omitted).' },
      view_id: { type: 'string', description: 'Card view ID to remove.' },
    },
    required: ['view_id'],
  },
  targetKind: 'assistant',
  nameSuffix: 'remove_card',
  handler: async (_t, _a, args) => {
    const canvasId = await resolveCanvasId(args, 'view_id');
    if (!canvasId) {
      return { content: [{ type: 'text', text: 'Could not determine canvas_id. Provide canvas_id or ensure the view_id exists on a canvas.' }], isError: true };
    }
    const result = await sendCanvasCommand('remove_view', { canvas_id: canvasId, view_id: args.view_id, project_id: args.project_id });
    if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to remove card' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'Card removed.', canvas_id: canvasId, view_id: args.view_id }) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'rename_card'),
  category: 'assistant',
  label: 'Rename Card',
  description: 'Rename a card on the canvas. canvas_id is optional — inferred from view_id.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID (optional — inferred from view_id if omitted).' },
      view_id: { type: 'string', description: 'Card view ID.' },
      name: { type: 'string', description: 'New display name.' },
    },
    required: ['view_id', 'name'],
  },
  targetKind: 'assistant',
  nameSuffix: 'rename_card',
  handler: async (_t, _a, args) => {
    const canvasId = await resolveCanvasId(args, 'view_id');
    if (!canvasId) {
      return { content: [{ type: 'text', text: 'Could not determine canvas_id. Provide canvas_id or ensure the view_id exists on a canvas.' }], isError: true };
    }
    const result = await sendCanvasCommand('rename_view', { canvas_id: canvasId, view_id: args.view_id, name: args.name, project_id: args.project_id });
    if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to rename card' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'Card renamed.', canvas_id: canvasId, view_id: args.view_id }) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'connect_cards'),
  category: 'assistant',
  label: 'Connect Cards',
  description: 'Create a wire (MCP binding) between two cards. ' +
    'Source must be an agent card with agent_id set. Target must be another agent card (NOT an anchor). ' +
    'canvas_id is optional — it will be inferred from the card view IDs. ' +
    'Wire persists even if agents are sleeping. Cannot wire to anchors — they are text-only labels. ' +
    'By default, agent-to-agent wires are bidirectional (both agents can call each other). ' +
    'Set bidirectional=false for one-way communication.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID (optional — inferred from card IDs if omitted).' },
      source_view_id: { type: 'string', description: 'Source card view ID (must be an agent card).' },
      target_view_id: { type: 'string', description: 'Target card view ID.' },
      from_card_id: { type: 'string', description: 'Alias for source_view_id.' },
      to_card_id: { type: 'string', description: 'Alias for target_view_id.' },
      bidirectional: { type: 'boolean', description: 'Create wires in both directions. Defaults to true for agent-to-agent, false for agent-to-group-project.' },
    },
    required: [],
  },
  targetKind: 'assistant',
  nameSuffix: 'connect_cards',
  handler: async (_t, _a, args) => {
    // Accept from_card_id/to_card_id as aliases
    const sourceViewId = args.source_view_id ?? args.from_card_id;
    const targetViewId = args.target_view_id ?? args.to_card_id;
    if (!sourceViewId || !targetViewId) {
      return { content: [{ type: 'text', text: 'Missing required argument: source_view_id (or from_card_id) and target_view_id (or to_card_id)' }], isError: true };
    }
    const canvasId = await resolveCanvasId({ ...args, source_view_id: sourceViewId, target_view_id: targetViewId }, 'source_view_id', 'target_view_id');
    if (!canvasId) {
      return { content: [{ type: 'text', text: 'Could not determine canvas_id. Provide canvas_id or ensure the card view IDs exist on a canvas.' }], isError: true };
    }
    const result = await sendCanvasCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: sourceViewId,
      target_view_id: targetViewId,
      project_id: args.project_id,
      bidirectional: args.bidirectional,
    });
    if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to connect cards' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'layout_canvas'),
  category: 'assistant',
  label: 'Layout Canvas',
  description: 'Auto-arrange cards using ELK layout algorithms. Algorithms: "layered" (hierarchical with spline wire routing — best default), "radial" (concentric circles from a root node), "force" (physics-based spreading), "mrtree" (compact tree hierarchy). ' +
    'canvas_id is optional — auto-selects when only one canvas exists. ' +
    'Zone-aware: cards inside zones are grouped and arranged within their zone bounds. ' +
    'For layered/mrtree, set direction to control flow: "RIGHT" (default), "DOWN", "LEFT", "UP". ' +
    'For radial, set root_id to center the layout on a specific card (auto-picks most-connected if omitted). ' +
    'ALWAYS call this after adding all cards — it produces clean, readable layouts.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID (optional — auto-selects when only one canvas exists).' },
      algorithm: { type: 'string', description: 'Layout algorithm: "layered" (hierarchical with spline routing — best default), "radial" (concentric circles), "force" (physics-based), or "mrtree" (tree hierarchy).' },
      direction: { type: 'string', description: 'Flow direction for layered/mrtree: "RIGHT" (default), "DOWN", "LEFT", "UP".' },
      root_id: { type: 'string', description: 'Radial only: view ID of the center card. Auto-picks most-connected if omitted.' },
    },
    required: ['algorithm'],
  },
  targetKind: 'assistant',
  nameSuffix: 'layout_canvas',
  handler: async (_t, _a, args) => {
  let canvasId = optionalString(args, 'canvas_id');
  if (!canvasId) {
    const listResult = await sendCanvasCommand('list_canvases', { project_id: args.project_id });
    if (listResult.success) {
      const canvases = listResult.data as Array<{ id: string }>;
      if (canvases.length === 1) {
        canvasId = canvases[0].id;
      } else {
        return { content: [{ type: 'text', text: `Multiple canvases exist. Provide canvas_id. Available: ${canvases.map(c => c.id).join(', ')}` }], isError: true };
      }
    }
  }
  if (!canvasId) {
    return { content: [{ type: 'text', text: 'Could not determine canvas_id. Provide canvas_id.' }], isError: true };
  }

  const algorithm = (stringWithDefault(args, 'algorithm', 'layered')) as ElkAlgorithm;
  const direction = optionalString(args, 'direction') as LayeredDirection | undefined;
  const rootId = optionalString(args, 'root_id');

  // Reset auto-stagger counter — layout_canvas re-arranges all cards
  canvasCardCounters.delete(canvasId);

  const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId });
  if (!queryResult.success) return { content: [{ type: 'text', text: queryResult.error || 'Failed to query views' }], isError: true };

  type CanvasView = { id: string; type: string; position: { x: number; y: number }; size: { width: number; height: number }; containedViewIds?: string[]; agentId?: string };
  const views = queryResult.data as CanvasView[];
  if (!views || views.length === 0) return { content: [{ type: 'text', text: 'No cards to arrange.' }] };

  // Separate zones from non-zone views, identify contained cards
  const zones = views.filter(v => v.type === 'zone');
  const containedIds = new Set(zones.flatMap(z => z.containedViewIds || []));
  const outerViews = views.filter(v => v.type !== 'zone' && !containedIds.has(v.id));

  // Query wire definitions for edge routing
  const wireResult = await sendCanvasCommand('query_wires', { canvas_id: canvasId });
  const wires = wireResult.success && Array.isArray(wireResult.data)
    ? wireResult.data as Array<{ sourceViewId: string; targetViewId: string; agentId?: string; targetId?: string }>
    : [];

  const elkEdges = wires.map((w, i) => ({
    id: `e${i}`,
    source: w.sourceViewId,
    target: w.targetViewId,
  }));

  const elkZones = zones.map(z => ({
    id: z.id,
    width: z.size.width,
    height: z.size.height,
    childIds: z.containedViewIds || [],
  }));

  const elkCards = [...outerViews, ...views.filter(v => containedIds.has(v.id))].map(v => {
    const zoneId = zones.find(z => (z.containedViewIds || []).includes(v.id))?.id;
    return { id: v.id, width: v.size.width, height: v.size.height, zoneId };
  });

  try {
    const elkResult = await layoutElk({
      cards: elkCards,
      edges: elkEdges,
      zones: elkZones,
      options: { algorithm, direction, rootId },
    });

    for (const pos of elkResult.nodes) {
      await sendCanvasCommand('move_view', { canvas_id: canvasId, view_id: pos.id, position: { x: pos.x, y: pos.y } });
    }

    // Store routed edge paths on wire definitions
    for (const edge of elkResult.edges) {
      const wire = wires[parseInt(edge.id.slice(1))];
      if (wire?.agentId && wire?.targetId) {
        await sendCanvasCommand('update_wire', {
          canvas_id: canvasId,
          agent_id: wire.agentId,
          target_id: wire.targetId,
          updates: { routedPath: edge.path },
        });
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ message: `Arranged ${views.length} cards with ${algorithm} layout.`, canvas_id: canvasId }) }] };
  } catch (err: any) {
    // ELK failed — fall back to grid layout
    const fallbackCards = [...outerViews, ...zones].map(v => ({ id: v.id, width: v.size.width, height: v.size.height }));
    const fallbackPositions = layoutGrid(fallbackCards);
    for (const pos of fallbackPositions) {
      await sendCanvasCommand('move_view', { canvas_id: canvasId, view_id: pos.id, position: { x: pos.x, y: pos.y } });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ message: `Layout failed (${err.message}), fell back to grid.`, canvas_id: canvasId }) }] };
  }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'get_card_defaults'),
  category: 'assistant',
  label: 'Get Card Defaults',
  description: 'Get default card sizes, spacing values, and layout info. Use this to know card dimensions before positioning.',
  inputSchema: { type: 'object', properties: {} },
  targetKind: 'assistant',
  nameSuffix: 'get_card_defaults',
  handler: async () => {
  const data = {
    card_sizes: DEFAULT_CARD_SIZES,
    spacing: {
      standard: 60,
      stagger_horizontal: 340,
      stagger_vertical: 260,
      zone_padding: 20,
      zone_title_height: 32,
    },
    layout_patterns: ['horizontal', 'vertical', 'grid', 'hub_spoke', 'auto'],
    relative_positions: ['right', 'left', 'below', 'above'],
    tips: [
      'Cards are auto-staggered when position is omitted — no coordinate math needed.',
      'Use relative_to_card_id in add_card/move_card to place cards relative to existing ones.',
      'ALWAYS call layout_canvas after adding all cards for clean arrangement.',
      'Use "layered" algorithm (default) for DAGs, "radial" for hub-spoke, "force" for organic graphs, "mrtree" for strict trees.',
    ],
  };
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
});

// ── create_canvas_from_blueprint ──────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'create_canvas_from_blueprint'),
  category: 'assistant',
  label: 'Create Canvas from Blueprint',
  targetKind: 'assistant',
  nameSuffix: 'create_canvas_from_blueprint',
  description:
    'Create a complete canvas from a JSON blueprint in one atomic call. ' +
    'Supports zones (named, colored), agent cards, group-project cards, sticky notes, anchors, and wires. ' +
    'Use this instead of multiple add_card/connect_cards calls for multi-card canvases. ' +
    'Returns canvas_id and a map of blueprint IDs to real view IDs. ' +
    'Wires are created with MCP bindings — source must reference an agent card with agent_id.',
  inputSchema: {
    type: 'object',
    properties: {
      blueprint: {
        type: 'object',
        description: 'Blueprint JSON with name, zones, cards, and wires.',
        properties: {
          name: { type: 'string', description: 'Canvas name.' },
          zones: {
            type: 'array',
            description: 'Zones to create. Each has id, name, and optional color.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                color: { type: 'string', description: 'Zone color/theme (e.g., cyan, rose, violet).' },
              },
              required: ['id', 'name'],
            },
          },
          cards: {
            type: 'array',
            description: 'Cards to create. Types: agent, group-project, sticky-note, anchor.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string', description: '"agent", "group-project", "sticky-note", or "anchor".' },
                display_name: { type: 'string' },
                agent_id: { type: 'string', description: 'For agent cards: durable agent ID.' },
                project_id: { type: 'string', description: 'For agent cards: project ID.' },
                zone: { type: 'string', description: 'Blueprint zone ID to place this card in.' },
                content: { type: 'string', description: 'For sticky notes: text content.' },
                color: { type: 'string', description: 'For sticky notes: color.' },
                group_project_id: { type: 'string', description: 'For group-project cards: the group project ID.' },
              },
              required: ['id', 'type'],
            },
          },
          wires: {
            type: 'array',
            description: 'Wires between cards. Source must be an agent card with agent_id.',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Blueprint ID of source card.' },
                to: { type: 'string', description: 'Blueprint ID of target card.' },
                bidirectional: { type: 'boolean', description: 'Default: true for agent-to-agent, false for agent-to-group-project.' },
              },
              required: ['from', 'to'],
            },
          },
        },
      },
      project_id: { type: 'string', description: 'Project ID for canvas scope. Omit for app-level.' },
      layout_pattern: { type: 'string', description: 'Layout algorithm to apply after creation: "layered" (default), "radial", "force", "mrtree".' },
    },
    required: ['blueprint'],
  },
  handler: async (_t, _a, args) => {
  const blueprint = args.blueprint as Record<string, unknown>;
  if (!blueprint) {
    return { content: [{ type: 'text', text: 'blueprint is required' }], isError: true };
  }

  // Step 1: Create canvas + zones + cards atomically in the renderer
  const createResult = await sendCanvasCommand('create_from_blueprint', {
    blueprint,
    project_id: args.project_id,
  });

  if (!createResult.success) {
    return { content: [{ type: 'text', text: createResult.error || 'Failed to create canvas from blueprint' }], isError: true };
  }

  const data = createResult.data as {
    canvas_id: string;
    name: string;
    id_map: Record<string, string>;
    zone_count: number;
    card_count: number;
    wire_count: number;
  };

  const canvasId = data.canvas_id;
  const idMap = data.id_map;

  // Step 2: Create wires using the ID map (main process handles MCP bindings)
  const wires = (blueprint.wires as Array<{ from: string; to: string; bidirectional?: boolean }>) || [];
  const wireResults: Array<{ from: string; to: string; success: boolean; error?: string }> = [];

  for (const wire of wires) {
    const sourceViewId = idMap[wire.from];
    const targetViewId = idMap[wire.to];
    if (!sourceViewId || !targetViewId) {
      wireResults.push({ from: wire.from, to: wire.to, success: false, error: `Blueprint ID not found: ${!sourceViewId ? wire.from : wire.to}` });
      continue;
    }
    const wireResult = await sendCanvasCommand('connect_views', {
      canvas_id: canvasId,
      source_view_id: sourceViewId,
      target_view_id: targetViewId,
      project_id: args.project_id,
      bidirectional: wire.bidirectional,
    });
    wireResults.push({ from: wire.from, to: wire.to, success: wireResult.success, error: wireResult.error });
  }

  // Step 3: Apply layout — skip for blueprints with zones (positions already
  // computed in renderer Phase 2 to respect zone containment)
  const hasZones = ((blueprint.zones as unknown[]) || []).length > 0;
  const layoutAlgorithm = (args.layout_pattern as ElkAlgorithm) || 'layered';
  if (!hasZones) {
    const queryResult = await sendCanvasCommand('query_views', { canvas_id: canvasId, project_id: args.project_id });
    if (queryResult.success) {
      const views = queryResult.data as Array<{ id: string; type: string; size: { width: number; height: number } }>;
      const elkCards = views.map(v => ({ id: v.id, width: v.size.width, height: v.size.height }));
      try {
        const elkResult = await layoutElk({ cards: elkCards, edges: [], zones: [], options: { algorithm: layoutAlgorithm } });
        for (const pos of elkResult.nodes) {
          await sendCanvasCommand('move_view', {
            canvas_id: canvasId,
            view_id: pos.id,
            position: { x: pos.x, y: pos.y },
            project_id: args.project_id,
          });
        }
      } catch {
        // Fallback to grid if ELK fails
        const gridPositions = layoutGrid(elkCards);
        for (const pos of gridPositions) {
          await sendCanvasCommand('move_view', {
            canvas_id: canvasId,
            view_id: pos.id,
            position: { x: pos.x, y: pos.y },
            project_id: args.project_id,
          });
        }
      }
    }
  }

  // Reset auto-stagger counter for this canvas
  canvasCardCounters.delete(canvasId);

  const failedWires = wireResults.filter(w => !w.success);
  const response: Record<string, unknown> = {
    canvas_id: canvasId,
    name: data.name,
    id_map: idMap,
    zones_created: data.zone_count,
    cards_created: data.card_count,
    wires_created: wireResults.filter(w => w.success).length,
    layout_applied: hasZones ? 'skipped (zone positions preserved)' : layoutAlgorithm,
  };
  if (failedWires.length > 0) {
    response.wire_errors = failedWires;
  }

  return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
  },
});

// ── disconnect_cards ──────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'disconnect_cards'),
  category: 'assistant',
  label: 'Disconnect Cards',
  description: 'Remove a wire (MCP binding) between two cards. ' +
    'Parameters: canvas_id, source_view_id, target_view_id. ' +
    'If the wire was bidirectional, both directions are removed automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'Canvas ID.' },
      source_view_id: { type: 'string', description: 'Source card view ID.' },
      target_view_id: { type: 'string', description: 'Target card view ID.' },
      from_card_id: { type: 'string', description: 'Alias for source_view_id.' },
      to_card_id: { type: 'string', description: 'Alias for target_view_id.' },
    },
    required: ['canvas_id'],
  },
  targetKind: 'assistant',
  nameSuffix: 'disconnect_cards',
  handler: async (_t, _a, args) => {
  const sourceViewId = args.source_view_id ?? args.from_card_id;
  const targetViewId = args.target_view_id ?? args.to_card_id;
  if (!sourceViewId || !targetViewId) {
    return { content: [{ type: 'text', text: 'Missing required argument: source_view_id (or from_card_id) and target_view_id (or to_card_id)' }], isError: true };
  }
  const result = await sendCanvasCommand('disconnect_views', {
    canvas_id: args.canvas_id,
    source_view_id: sourceViewId,
    target_view_id: targetViewId,
    project_id: args.project_id,
  });
  if (!result.success) return { content: [{ type: 'text', text: result.error || 'Failed to disconnect cards' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  },
});

// ── list_card_types ──────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'list_card_types'),
  category: 'assistant',
  label: 'List Card Types',
  description: 'List all available canvas card types with descriptions and default sizes.',
  inputSchema: { type: 'object', properties: {} },
  targetKind: 'assistant',
  nameSuffix: 'list_card_types',
  handler: async () => {
  const cardTypes = [
    { type: 'agent', description: 'Durable agent card. Bind to a real agent with agent_id + project_id.', defaultSize: { width: 300, height: 200 } },
    { type: 'zone', description: 'Visual container that groups other cards. Containment is spatial (>50% overlap).', defaultSize: { width: 600, height: 400 } },
    { type: 'anchor', description: 'Text-only label. Cannot be wired or used for coordination.', defaultSize: { width: 200, height: 100 } },
    { type: 'sticky-note', description: 'Sticky note with text content and color. For quick notes, ideas, or annotations.', defaultSize: { width: 250, height: 250 } },
    { type: 'plugin', description: 'Plugin-provided widget (browser, terminal, file viewer, group project, etc.). Created by plugins, not directly via add_card.', defaultSize: { width: 480, height: 480 } },
  ];
  return { content: [{ type: 'text', text: JSON.stringify(cardTypes, null, 2) }] };
  },
});

}
