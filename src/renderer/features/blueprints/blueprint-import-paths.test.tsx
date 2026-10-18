/**
 * Blueprint import through every entry point (#2055): gallery card, "Open
 * from file…", canvas drop and canvas paste, all fed one realistic manifest.
 * Each path's wire output is normalised (generated view ids → display names)
 * so the paths can be compared directly: they must all produce the wires the
 * contract in blueprint-wire-plan.ts describes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
import { applyParsedBlueprint, type ParseResult } from './parse-blueprint';
import { useBlueprintDrop } from '../../plugins/builtin/canvas/useBlueprintDrop';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { blueprintParseContext } from './blueprint-parse-context';

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
      { sourceRef: 'orch', targetRef: 'rev', bidirectional: true, instructions: { send_message: 'Ask for a review' }, disabledTools: ['delete_file'] },
      { sourceRef: 'orch', targetRef: 'web', instructions: { '*': 'Read the docs first' }, disabledTools: ['navigate'] },
      { sourceRef: 'orch', targetRef: 'sh' },
      { sourceRef: 'orch', targetRef: 'gp', instructions: { '*': 'Post status to the board' } },
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
  canvasResults.length = 0;
  // The group project the manifest's board shows exists on this machine.
  useGroupProjectStore.setState({ projects: [{ id: 'gp-42', name: 'Board' } as never], loaded: true, loadError: null });
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

/** What CanvasWorkspace does with the hook's result: apply it to the canvas store. */
const canvasResults: ParseResult[] = [];
async function applyAsCanvasWorkspace(result: ParseResult) {
  canvasResults.push(result);
  const wires: Wire[] = [];
  await applyParsedBlueprint(result, { insertCanvas: () => {}, addWireDefinition: (w) => { wires.push(w); } });
  return normalise(result.canvas, wires);
}

function canvasHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onImport = vi.fn();
  renderHook(() => useBlueprintDrop({
    containerRef: { current: container },
    onImport,
    onError: (message) => { throw new Error(message); },
    // What CanvasWorkspace passes.
    getParseContext: () => blueprintParseContext('p1'),
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

// ── The contract ─────────────────────────────────────────────────────

/** What every path must produce for MANIFEST (see blueprint-wire-plan.ts). */
const EXPECTED = [
  // Agent targets are addressed by agent id; bidirectional adds the reverse; metadata on both.
  { agentId: 'agent-orch', targetId: 'agent-rev', targetKind: 'agent', instructions: { send_message: 'Ask for a review' }, disabledTools: ['delete_file'] },
  { agentId: 'agent-rev', targetId: 'agent-orch', targetKind: 'agent', instructions: { send_message: 'Ask for a review' }, disabledTools: ['delete_file'] },
  // Browsers by view id.
  { agentId: 'agent-orch', targetId: 'view:Docs', targetKind: 'browser', instructions: { '*': 'Read the docs first' }, disabledTools: ['navigate'] },
  // Group projects by their group project id.
  { agentId: 'agent-orch', targetId: 'gp-42', targetKind: 'group-project', instructions: { '*': 'Post status to the board' } },
  // Not created: the terminal (not a wire target) and both wires touching the unbound Newcomer.
];

const PATHS = [
  ['gallery card', viaGalleryCard],
  ['open from file', viaOpenFromFile],
  ['canvas drop', viaCanvasDrop],
  ['canvas paste', viaCanvasPaste],
] as const;

describe('blueprint import paths', () => {
  it.each(PATHS)('%s produces the contract\'s wires', async (_name, run) => {
    expect(await run()).toEqual(EXPECTED);
  });

  it('every path produces the same wires', async () => {
    const outputs = [];
    for (const [, run] of PATHS) {
      outputs.push(await run());
      cleanup();
      sink.canvases = [];
      sink.wires = [];
    }
    for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]);
  });

  it.each(PATHS)('%s defers a wire to a group project that is not on this machine, and clears the id', async (_name, run) => {
    useGroupProjectStore.setState({ projects: [], loaded: true, loadError: null });
    expect(await run()).toEqual(EXPECTED.filter((w) => w.targetKind !== 'group-project'));
    const canvas = (sink.canvases[0] ?? canvasResults[0]?.canvas) as CanvasInstance;
    expect(canvas.views.find((v) => v.displayName === 'Board')?.metadata).not.toHaveProperty('groupProjectId');
  });

  it('reports the wires it defers and skips', async () => {
    await viaCanvasPaste();
    const { deferred, skipped } = canvasResults[0].wires;
    expect(deferred.map((d) => [d.wire.sourceRef, d.wire.targetRef, d.reason])).toEqual([
      ['rev', 'new', 'target_unbound'],
      ['new', 'orch', 'source_unbound'],
    ]);
    expect(skipped.map((d) => [d.wire.sourceRef, d.wire.targetRef, d.reason])).toEqual([['orch', 'sh', 'unsupported_target']]);
  });
});
