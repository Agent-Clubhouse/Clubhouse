/**
 * Blueprint import through every entry point (#2055): gallery card, "Open
 * from file…", canvas drop and canvas paste, all fed one realistic manifest.
 * Each path's wire output is normalised (generated view ids → display names)
 * so the paths can be compared directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { BlueprintManifest } from '../../../shared/blueprint-types';
import type { CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';

// ── Machine state the import matches against ─────────────────────────

const AGENTS = {
  'agent-orch': { id: 'agent-orch', name: 'Orchestrator', projectId: 'p1', kind: 'durable', status: 'sleeping', color: 'blue' },
  'agent-rev': { id: 'agent-rev', name: 'Reviewer', projectId: 'p1', kind: 'durable', status: 'sleeping', color: 'green' },
};
const PROJECTS = [{ id: 'p1', name: 'Project', path: '/tmp/proj' }];

vi.mock('../../stores/agentStore', () => ({ useAgentStore: { getState: () => ({ agents: AGENTS }) } }));
vi.mock('../../stores/projectStore', () => ({
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ activeProjectId: 'p1', projects: PROJECTS }),
    { getState: () => ({ projects: PROJECTS }) },
  ),
}));
const ui = vi.hoisted(() => ({ open: true }));
vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ blueprintGalleryOpen: ui.open, blueprintGalleryScope: null, closeBlueprintGallery: vi.fn() }),
    { getState: () => ({ closeBlueprintGallery: vi.fn() }) },
  ),
}));

// The canvas store the gallery imports into: record what it receives.
const sink = vi.hoisted(() => ({ canvases: [] as unknown[], wires: [] as unknown[] }));
vi.mock('../../plugins/builtin/canvas/main', () => {
  const state = {
    loadAndInsertCanvas: async (canvas: unknown) => { sink.canvases.push(canvas); },
    addWireDefinition: (wire: unknown) => { sink.wires.push(wire); },
  };
  return {
    getProjectCanvasStore: () => ({ getState: () => state }),
    useAppCanvasStore: { getState: () => state },
  };
});
vi.mock('../../plugins/plugin-api-storage', () => ({ createScopedStorage: () => ({}) }));

import { BlueprintGallery } from './BlueprintGallery';
import { buildWireDefinitionsFromResult, type ParseResult } from './parse-blueprint';
import { useBlueprintDrop } from '../../plugins/builtin/canvas/useBlueprintDrop';

// ── The manifest ─────────────────────────────────────────────────────

const MANIFEST: BlueprintManifest = {
  id: 'bp-team',
  name: 'Review team',
  version: '1.0.0',
  schemaVersion: 1,
  createdAt: '2026-10-17T00:00:00.000Z',
  agents: [
    { refId: 'orch', name: 'Orchestrator', matchBy: { name: 'Orchestrator' } },
    { refId: 'rev', name: 'Reviewer', matchBy: { name: 'Reviewer' } },
    // No agent on this machine has this name: imported as an unbound stub.
    { refId: 'new', name: 'Newcomer', matchBy: { name: 'Newcomer' } },
  ],
  canvas: {
    views: [
      { refId: 'orch', type: 'agent', displayName: 'Orchestrator', agentRef: 'orch', position: { x: 0, y: 0 } },
      { refId: 'rev', type: 'agent', displayName: 'Reviewer', agentRef: 'rev', position: { x: 600, y: 0 } },
      { refId: 'new', type: 'agent', displayName: 'Newcomer', agentRef: 'new', position: { x: 1200, y: 0 } },
      { refId: 'web', type: 'plugin:browser:webview', displayName: 'Docs', position: { x: 0, y: 600 }, metadata: { pluginWidgetType: 'plugin:browser:webview', pluginId: 'browser' } },
      { refId: 'sh', type: 'plugin:terminal:shell', displayName: 'Shell', position: { x: 600, y: 600 }, metadata: { pluginWidgetType: 'plugin:terminal:shell', pluginId: 'terminal' } },
      { refId: 'gp', type: 'plugin:group-project:group-project', displayName: 'Board', position: { x: 1200, y: 600 }, metadata: { pluginWidgetType: 'plugin:group-project:group-project', pluginId: 'group-project', groupProjectId: 'gp-42' } },
    ],
    wires: [
      { sourceRef: 'orch', targetRef: 'rev', bidirectional: true, instructions: { forward: 'Ask for a review' }, disabledTools: ['delete_file'] },
      { sourceRef: 'orch', targetRef: 'web', instructions: { forward: 'Read the docs first' }, disabledTools: ['navigate'] },
      { sourceRef: 'orch', targetRef: 'sh' },
      { sourceRef: 'orch', targetRef: 'gp', instructions: { forward: 'Post status to the board' } },
      { sourceRef: 'rev', targetRef: 'new' },
      { sourceRef: 'new', targetRef: 'orch' },
    ],
  },
};
const MANIFEST_JSON = JSON.stringify(MANIFEST);

// ── Normalising output ───────────────────────────────────────────────

type Wire = Pick<McpBindingEntry, 'agentId' | 'targetId' | 'targetKind'> & Partial<McpBindingEntry>;

/** Replace generated view ids with `view:<displayName>` so runs can be compared. */
function normalise(canvas: CanvasInstance, wires: Wire[]): Record<string, unknown>[] {
  const names = new Map(canvas.views.map((v) => [v.id, `view:${v.displayName}`]));
  return wires.map((w) => ({
    agentId: w.agentId,
    targetId: names.get(w.targetId) ?? w.targetId,
    targetKind: w.targetKind,
    ...(w.instructions ? { instructions: w.instructions } : {}),
    ...(w.disabledTools ? { disabledTools: w.disabledTools } : {}),
  }));
}

// ── Running each entry point ─────────────────────────────────────────

beforeEach(() => {
  sink.canvases = [];
  sink.wires = [];
  ui.open = true;
  window.clubhouse.blueprint = {
    ...window.clubhouse.blueprint,
    list: vi.fn(async () => [{ filePath: '/tmp/team.json', name: 'Review team', viewCount: 6, agentCount: 3, wireCount: 6, version: 1 }]),
    read: vi.fn(async () => JSON.parse(MANIFEST_JSON)),
    openAndRead: vi.fn(async () => ({ canceled: false, data: JSON.parse(MANIFEST_JSON) })),
  } as typeof window.clubhouse.blueprint;
});

async function viaGalleryCard() {
  render(<BlueprintGallery />);
  fireEvent.dblClick(await screen.findByTestId('blueprint-card-Review team'));
  await waitFor(() => expect(sink.canvases).toHaveLength(1));
  return normalise(sink.canvases[0] as CanvasInstance, sink.wires as Wire[]);
}

async function viaOpenFromFile() {
  render(<BlueprintGallery />);
  fireEvent.click(await screen.findByTestId('blueprint-gallery-open-from-file'));
  await waitFor(() => expect(sink.canvases).toHaveLength(1));
  return normalise(sink.canvases[0] as CanvasInstance, sink.wires as Wire[]);
}

/** What CanvasWorkspace does with the hook's result: insert the canvas, add the wires. */
function applyAsCanvasWorkspace(result: ParseResult) {
  return normalise(result.canvas, buildWireDefinitionsFromResult(result));
}

function canvasHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onImport = vi.fn();
  renderHook(() => useBlueprintDrop({
    containerRef: { current: container },
    onImport,
    onError: (message) => { throw new Error(message); },
    getParseContext: () => ({ agents: Object.values(AGENTS) as never, projects: PROJECTS, activeProjectId: 'p1' }),
  }));
  return { container, onImport };
}

async function viaCanvasDrop() {
  const { container, onImport } = canvasHook();
  const file = new File([MANIFEST_JSON], 'team.json', { type: 'application/json' });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file], items: [{ kind: 'file', type: 'application/json' }] } });
  await act(async () => { container.dispatchEvent(event); });
  await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
  return applyAsCanvasWorkspace(onImport.mock.calls[0][0] as ParseResult);
}

async function viaCanvasPaste() {
  const { container, onImport } = canvasHook();
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => MANIFEST_JSON } });
  await act(async () => { container.dispatchEvent(event); });
  expect(onImport).toHaveBeenCalledTimes(1);
  return applyAsCanvasWorkspace(onImport.mock.calls[0][0] as ParseResult);
}

// ── Today's behaviour (before #2055) ─────────────────────────────────

describe('blueprint import paths: behaviour before #2055', () => {
  it('gallery card: every non-agent target becomes browser, instructions and disabledTools are dropped', async () => {
    expect(await viaGalleryCard()).toEqual([
      { agentId: 'agent-orch', targetId: 'view:Reviewer', targetKind: 'agent' },
      { agentId: 'agent-orch', targetId: 'view:Docs', targetKind: 'browser' },
      { agentId: 'agent-orch', targetId: 'view:Shell', targetKind: 'browser' },
      { agentId: 'agent-orch', targetId: 'view:Board', targetKind: 'browser' },
      { agentId: 'agent-rev', targetId: 'view:Newcomer', targetKind: 'agent' },
    ]);
  });

  it.each([
    ['open from file', viaOpenFromFile],
    ['canvas drop', viaCanvasDrop],
    ['canvas paste', viaCanvasPaste],
  ])('%s: keeps group-project and metadata, but targets view ids, turns terminals into browsers and ignores bidirectional', async (_name, run) => {
    expect(await run()).toEqual([
      { agentId: 'agent-orch', targetId: 'view:Reviewer', targetKind: 'agent', instructions: { forward: 'Ask for a review' }, disabledTools: ['delete_file'] },
      { agentId: 'agent-orch', targetId: 'view:Docs', targetKind: 'browser', instructions: { forward: 'Read the docs first' }, disabledTools: ['navigate'] },
      { agentId: 'agent-orch', targetId: 'view:Shell', targetKind: 'browser' },
      { agentId: 'agent-orch', targetId: 'view:Board', targetKind: 'group-project', instructions: { forward: 'Post status to the board' } },
      { agentId: 'agent-rev', targetId: 'view:Newcomer', targetKind: 'agent' },
    ]);
  });
});
