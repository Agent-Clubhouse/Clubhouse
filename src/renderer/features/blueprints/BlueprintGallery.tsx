import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useUIStore } from '../../stores/uiStore';
import type { BlueprintSummary } from '../../../shared/blueprint-summary';
import { importBlueprint as legacyImportBlueprint, validateBlueprint } from '../../plugins/builtin/canvas/canvas-blueprint';
import { importBlueprint as manifestImportBlueprint } from './blueprint-import';
import { parseAnyBlueprint, buildWireDefinitionsFromResult } from './parse-blueprint';
import { getProjectCanvasStore, useAppCanvasStore } from '../../plugins/builtin/canvas/main';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';

// ── Fuzzy search ─────────────────────────────────────────────────────

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  // Token-based: all query tokens must appear somewhere
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((tok) => t.includes(tok));
}

function matchesSearch(bp: BlueprintSummary, query: string): boolean {
  const searchable = [bp.name, bp.description || '', bp.source, ...bp.agentNames].join(' ');
  return fuzzyMatch(query, searchable);
}

// ── Sort ─────────────────────────────────────────────────────────────

type SortMode = 'name' | 'date' | 'views';

function sortBlueprints(items: BlueprintSummary[], mode: SortMode): BlueprintSummary[] {
  const sorted = [...items];
  switch (mode) {
    case 'name':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'date':
      return sorted.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    case 'views':
      return sorted.sort((a, b) => b.viewCount - a.viewCount);
  }
}

// ── Gallery ──────────────────────────────────────────────────────────

export function BlueprintGallery() {
  const isOpen = useUIStore((s) => s.blueprintGalleryOpen);
  const close = useUIStore((s) => s.closeBlueprintGallery);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [blueprints, setBlueprints] = useState<BlueprintSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [importing, setImporting] = useState<string | null>(null);
  const [selected, setSelected] = useState<BlueprintSummary | null>(null);
  const [previewData, setPreviewData] = useState<Record<string, unknown> | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Fetch blueprints when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setSearch('');
    setSelected(null);
    setPreviewData(null);
    setDeleteConfirm(null);
    window.clubhouse.blueprint.list()
      .then(setBlueprints)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [isOpen]);

  // Fetch full data when a card is selected for preview
  useEffect(() => {
    if (!selected) { setPreviewData(null); return; }
    window.clubhouse.blueprint.read(selected.filePath)
      .then(setPreviewData)
      .catch(() => setPreviewData(null));
  }, [selected]);

  const filtered = useMemo(() => {
    const searched = search.trim()
      ? blueprints.filter((b) => matchesSearch(b, search))
      : blueprints;
    return sortBlueprints(searched, sortMode);
  }, [blueprints, search, sortMode]);

  const handleImport = useCallback(async (bp: BlueprintSummary) => {
    setImporting(bp.filePath);
    try {
      const data = await window.clubhouse.blueprint.read(bp.filePath);
      if (!data) throw new Error('Failed to read blueprint file');

      const store = activeProjectId
        ? getProjectCanvasStore(activeProjectId)
        : useAppCanvasStore;

      // Use manifest-aware import for BlueprintManifest files (preserves agent bindings/wires)
      if (data && typeof data === 'object' && 'schemaVersion' in data) {
        const agents = Object.values(useAgentStore.getState().agents);
        const projects = useProjectStore.getState().projects.map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
        }));
        const result = manifestImportBlueprint(data as any, agents, projects, activeProjectId ?? undefined);
        store.getState().insertCanvas(result.canvas);
        // Restore wire definitions from the import
        for (const wire of result.pendingWires) {
          const sourceViewId = result.refIdToViewId.get(wire.sourceRef);
          const targetViewId = result.refIdToViewId.get(wire.targetRef);
          if (sourceViewId && targetViewId) {
            const sourceView = result.canvas.views.find((v) => v.id === sourceViewId);
            const targetView = result.canvas.views.find((v) => v.id === targetViewId);
            if (sourceView && targetView && sourceView.type === 'agent') {
              const agentView = sourceView as any;
              if (agentView.agentId) {
                const targetKind: 'browser' | 'agent' | 'terminal' | 'group-project' | 'agent-queue' =
                  targetView.type === 'agent' ? 'agent' : 'browser';
                store.getState().addWireDefinition({
                  agentId: agentView.agentId,
                  targetId: targetViewId,
                  targetKind,
                  label: `${wire.sourceRef} → ${wire.targetRef}`,
                  agentName: wire.sourceRef,
                  targetName: wire.targetRef,
                });
              }
            }
          }
        }
      } else {
        // Legacy blueprint format (no agent bindings)
        const validationError = validateBlueprint(data);
        if (validationError) throw new Error(validationError);
        const canvas = legacyImportBlueprint(data as any);
        store.getState().insertCanvas(canvas);
      }

      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  }, [activeProjectId, close]);

  const handleOpenFromFile = useCallback(async () => {
    setError(null);
    setImporting('__open_from_file__');
    try {
      const result = await window.clubhouse.blueprint.openAndRead();
      if (result.canceled) return;
      if (result.error || !result.data) {
        throw new Error(result.error || 'Failed to read file');
      }

      const agents = Object.values(useAgentStore.getState().agents);
      const projects = useProjectStore.getState().projects.map((p) => ({
        id: p.id, name: p.name, path: p.path,
      }));
      const parsed = parseAnyBlueprint(result.data, {
        agents,
        projects,
        activeProjectId: activeProjectId ?? undefined,
      });

      const store = activeProjectId
        ? getProjectCanvasStore(activeProjectId)
        : useAppCanvasStore;
      store.getState().insertCanvas(parsed.canvas);
      for (const wire of buildWireDefinitionsFromResult(parsed)) {
        store.getState().addWireDefinition(wire);
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  }, [activeProjectId, close]);

  const handleDelete = useCallback(async (bp: BlueprintSummary) => {
    const deleted = await window.clubhouse.blueprint.delete(bp.filePath);
    if (deleted) {
      setBlueprints((prev) => prev.filter((b) => b.filePath !== bp.filePath));
      if (selected?.filePath === bp.filePath) {
        setSelected(null);
        setPreviewData(null);
      }
    }
    setDeleteConfirm(null);
  }, [selected]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (deleteConfirm) setDeleteConfirm(null);
        else close();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, close, deleteConfirm]);

  if (!isOpen) return null;

  const hasPreview = selected !== null;

  return (
    <div
      // eslint-disable-next-line no-restricted-syntax
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="blueprint-gallery-overlay"
    >
      <div
        className={`bg-ctp-base border border-surface-0 rounded-xl shadow-2xl ${hasPreview ? 'w-[780px]' : 'w-[560px]'} max-h-[520px] flex flex-col overflow-hidden transition-all`}
        data-testid="blueprint-gallery"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-0">
          <h2 className="text-sm font-semibold text-ctp-text">Import Blueprint</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenFromFile}
              disabled={importing === '__open_from_file__'}
              className="text-[10px] px-2 py-0.5 bg-ctp-mantle border border-surface-0 rounded text-ctp-subtext1 hover:text-ctp-text hover:border-ctp-accent disabled:opacity-50"
              data-testid="blueprint-gallery-open-from-file"
              title="Open a blueprint .json from anywhere on disk"
            >
              {importing === '__open_from_file__' ? 'Opening…' : 'Open from file…'}
            </button>
            {/* Sort dropdown */}
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="text-[10px] bg-ctp-mantle border border-surface-0 rounded px-1.5 py-0.5 text-ctp-subtext1 focus-ring"
              data-testid="blueprint-gallery-sort"
            >
              <option value="name">Sort: Name</option>
              <option value="date">Sort: Newest</option>
              <option value="views">Sort: Most Views</option>
            </select>
            <button
              onClick={close}
              className="w-6 h-6 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text"
              data-testid="blueprint-gallery-close"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-surface-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, description, or agent name..."
            className="w-full px-3 py-1.5 text-xs bg-ctp-mantle border border-surface-0 rounded-md text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
            autoFocus
            data-testid="blueprint-gallery-search"
          />
        </div>

        {/* Content */}
        <div className="flex-1 flex min-h-0">
          {/* Card grid */}
          <div className={`flex-1 overflow-y-auto px-4 py-3 ${hasPreview ? 'max-w-[380px]' : ''}`}>
            {loading && (
              <div className="flex items-center justify-center py-8 text-xs text-ctp-subtext0">
                Scanning for blueprints...
              </div>
            )}

            {error && (
              <div className="px-3 py-2 text-xs text-ctp-error bg-ctp-error/10 rounded-md mb-3" data-testid="blueprint-gallery-error">
                {error}
              </div>
            )}

            {!loading && filtered.length === 0 && !error && (
              <EmptyState hasSearch={search.trim().length > 0} />
            )}

            {!loading && filtered.length > 0 && (
              <div className="grid grid-cols-2 gap-2" data-testid="blueprint-gallery-grid">
                {filtered.map((bp) => (
                  <BlueprintCard
                    key={bp.filePath}
                    blueprint={bp}
                    isSelected={selected?.filePath === bp.filePath}
                    onSelect={() => setSelected(selected?.filePath === bp.filePath ? null : bp)}
                    onImport={() => handleImport(bp)}
                    onDelete={() => setDeleteConfirm(bp.filePath)}
                    importing={importing === bp.filePath}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Preview panel */}
          {hasPreview && (
            <PreviewPanel
              blueprint={selected}
              data={previewData}
              onImport={() => handleImport(selected)}
              importing={importing === selected.filePath}
            />
          )}
        </div>

        {/* Delete confirmation */}
        {deleteConfirm && (
          <DeleteConfirmBar
            onConfirm={() => {
              const bp = blueprints.find((b) => b.filePath === deleteConfirm);
              if (bp) handleDelete(bp);
            }}
            onCancel={() => setDeleteConfirm(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  if (hasSearch) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-xs text-ctp-subtext0 gap-1" data-testid="blueprint-gallery-empty">
        <span>No matching blueprints</span>
        <span className="text-ctp-overlay0">Try a different search term</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-8 text-xs text-ctp-subtext0 gap-2" data-testid="blueprint-gallery-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-overlay0 mb-1">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18" />
        <path d="M9 3v18" />
      </svg>
      <span className="font-medium text-ctp-subtext1">No blueprints yet</span>
      <div className="text-center text-ctp-overlay0 max-w-[240px] leading-relaxed">
        Export a canvas with right-click &rarr; "Export as Blueprint", or place .json files in <code className="text-ctp-accent">.clubhouse/blueprints/</code> in any project.
      </div>
    </div>
  );
}

// ── Blueprint card ───────────────────────────────────────────────────

function BlueprintCard({
  blueprint: bp,
  isSelected,
  onSelect,
  onImport,
  onDelete,
  importing,
}: {
  blueprint: BlueprintSummary;
  isSelected: boolean;
  onSelect: () => void;
  onImport: () => void;
  onDelete: () => void;
  importing: boolean;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  return (
    <div className="relative">
      <button
        onClick={onSelect}
        onDoubleClick={onImport}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
        disabled={importing}
        className={`w-full flex flex-col gap-1.5 p-3 rounded-lg border transition-colors text-left cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
          isSelected
            ? 'border-ctp-accent bg-ctp-accent/5'
            : 'border-surface-0 bg-ctp-mantle hover:border-ctp-accent/50 hover:bg-surface-0'
        }`}
        data-testid={`blueprint-card-${bp.name}`}
      >
        <div className="text-xs font-medium text-ctp-text truncate w-full">{bp.name}</div>
        {bp.description && (
          <div className="text-[10px] text-ctp-subtext0 line-clamp-2">{bp.description}</div>
        )}
        <div className="flex items-center gap-2 text-[10px] text-ctp-overlay0 mt-auto">
          <span>{bp.viewCount} view{bp.viewCount !== 1 ? 's' : ''}</span>
          {bp.agentCount > 0 && <span>{bp.agentCount} agent{bp.agentCount !== 1 ? 's' : ''}</span>}
          {bp.wireCount > 0 && <span>{bp.wireCount} wire{bp.wireCount !== 1 ? 's' : ''}</span>}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-ctp-overlay0 truncate w-full">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
            <path d="M2 4l6-2 6 2v8l-6 2-6-2z" />
            <path d="M8 2v12" />
          </svg>
          {bp.source}
        </div>
      </button>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-dropdown bg-ctp-mantle border border-surface-0 rounded-lg shadow-2xl py-1 min-w-[140px] text-[11px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          data-testid="blueprint-card-context-menu"
        >
          <button
            onClick={() => { setContextMenu(null); onImport(); }}
            className="w-full text-left px-3 py-1.5 hover:bg-surface-1 text-ctp-text"
          >
            Import
          </button>
          <div className="border-t border-surface-0 my-1" />
          <button
            onClick={() => { setContextMenu(null); onDelete(); }}
            className="w-full text-left px-3 py-1.5 hover:bg-ctp-error/10 text-ctp-error"
            data-testid="blueprint-card-delete"
          >
            Delete Blueprint
          </button>
        </div>
      )}
    </div>
  );
}

// ── Preview panel ────────────────────────────────────────────────────

function PreviewPanel({
  blueprint: bp,
  data,
  onImport,
  importing,
}: {
  blueprint: BlueprintSummary;
  data: Record<string, unknown> | null;
  onImport: () => void;
  importing: boolean;
}) {
  // Extract view positions for mini layout
  const viewRects = useMemo(() => {
    if (!data) return [];
    const canvas = typeof data.canvas === 'object' && data.canvas !== null ? data.canvas as Record<string, unknown> : null;
    const views: unknown[] = canvas && Array.isArray(canvas.views)
      ? canvas.views
      : Array.isArray(data.views) ? data.views : [];

    return views.map((v) => {
      if (typeof v !== 'object' || v === null) return null;
      const view = v as Record<string, unknown>;
      const pos = view.position as { x?: number; y?: number } | undefined;
      const size = view.size as { width?: number; height?: number } | undefined;
      const type = (view.type as string) || 'unknown';
      return {
        x: pos?.x ?? 0,
        y: pos?.y ?? 0,
        w: size?.width ?? 200,
        h: size?.height ?? 100,
        type,
        name: (view.title || view.displayName || type) as string,
      };
    }).filter(Boolean) as { x: number; y: number; w: number; h: number; type: string; name: string }[];
  }, [data]);

  // View type breakdown
  const typeBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of viewRects) {
      counts[r.type] = (counts[r.type] || 0) + 1;
    }
    return counts;
  }, [viewRects]);

  return (
    <div
      className="w-[360px] border-l border-surface-0 flex flex-col overflow-y-auto"
      data-testid="blueprint-preview-panel"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-surface-0">
        <div className="text-xs font-semibold text-ctp-text mb-1">{bp.name}</div>
        {bp.description && (
          <div className="text-[10px] text-ctp-subtext0 mb-2">{bp.description}</div>
        )}
        <button
          onClick={onImport}
          disabled={importing}
          className="w-full px-3 py-1.5 text-xs font-medium bg-ctp-accent text-ctp-base rounded-md hover:bg-ctp-accent/90 disabled:opacity-50 transition-colors"
          data-testid="blueprint-preview-import"
        >
          {importing ? 'Importing...' : 'Import Blueprint'}
        </button>
      </div>

      {/* Metadata */}
      <div className="px-4 py-2 border-b border-surface-0 text-[10px] text-ctp-subtext0 space-y-1">
        <div className="flex justify-between"><span>Source</span><span className="text-ctp-text">{bp.source}</span></div>
        <div className="flex justify-between"><span>Version</span><span className="text-ctp-text">{bp.version}</span></div>
        {bp.createdAt && (
          <div className="flex justify-between"><span>Created</span><span className="text-ctp-text">{new Date(bp.createdAt).toLocaleDateString()}</span></div>
        )}
      </div>

      {/* View breakdown */}
      <div className="px-4 py-2 border-b border-surface-0">
        <div className="text-[10px] font-medium text-ctp-subtext1 mb-1.5">Views ({bp.viewCount})</div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(typeBreakdown).map(([type, count]) => (
            <span key={type} className={`text-[10px] px-1.5 py-0.5 rounded ${typeColor(type)}`}>
              {count} {type}
            </span>
          ))}
          {bp.wireCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-0 text-ctp-subtext0">
              {bp.wireCount} wire{bp.wireCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Agent list */}
      {bp.agentNames.length > 0 && (
        <div className="px-4 py-2 border-b border-surface-0">
          <div className="text-[10px] font-medium text-ctp-subtext1 mb-1.5">Agents</div>
          <div className="space-y-1">
            {bp.agentNames.map((name, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px] text-ctp-text">
                <div className="w-1.5 h-1.5 rounded-full bg-ctp-accent flex-shrink-0" />
                {name}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mini layout preview */}
      {viewRects.length > 0 && (
        <div className="px-4 py-2">
          <div className="text-[10px] font-medium text-ctp-subtext1 mb-1.5">Layout Preview</div>
          <MiniLayoutPreview views={viewRects} />
        </div>
      )}
    </div>
  );
}

function typeColor(type: string): string {
  switch (type) {
    case 'agent': return 'bg-ctp-accent/15 text-ctp-accent';
    case 'anchor': return 'bg-ctp-warning/15 text-ctp-warning';
    case 'plugin': return 'bg-ctp-success/15 text-ctp-success';
    case 'sticky-note': return 'bg-status-warning/15 text-status-warning';
    case 'zone': return 'bg-purple-500/15 text-purple-400';
    default: return 'bg-surface-0 text-ctp-subtext0';
  }
}

// ── Mini layout preview ──────────────────────────────────────────────

function MiniLayoutPreview({ views }: { views: { x: number; y: number; w: number; h: number; type: string; name: string }[] }) {
  if (views.length === 0) return null;

  // Compute bounding box and scale to fit
  const minX = Math.min(...views.map((v) => v.x));
  const minY = Math.min(...views.map((v) => v.y));
  const maxX = Math.max(...views.map((v) => v.x + v.w));
  const maxY = Math.max(...views.map((v) => v.y + v.h));
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;

  const PREVIEW_W = 320;
  const PREVIEW_H = 160;
  const scale = Math.min(PREVIEW_W / bw, PREVIEW_H / bh) * 0.85;
  const offsetX = (PREVIEW_W - bw * scale) / 2;
  const offsetY = (PREVIEW_H - bh * scale) / 2;

  return (
    <div
      className="w-full bg-ctp-mantle rounded-md border border-surface-0 overflow-hidden"
      style={{ height: PREVIEW_H }}
      data-testid="blueprint-mini-layout"
    >
      <svg width={PREVIEW_W} height={PREVIEW_H}>
        {views.map((v, i) => {
          const rx = (v.x - minX) * scale + offsetX;
          const ry = (v.y - minY) * scale + offsetY;
          const rw = Math.max(v.w * scale, 4);
          const rh = Math.max(v.h * scale, 4);
          return (
            <rect
              key={i}
              x={rx}
              y={ry}
              width={rw}
              height={rh}
              rx={2}
              fill={rectFill(v.type)}
              stroke={rectStroke(v.type)}
              strokeWidth={0.5}
              opacity={0.8}
            />
          );
        })}
      </svg>
    </div>
  );
}

function rectFill(type: string): string {
  switch (type) {
    case 'agent': return 'rgb(var(--ctp-accent) / 0.12)';
    case 'anchor': return 'rgb(var(--ctp-warning) / 0.12)';
    case 'plugin': return 'rgb(var(--ctp-success) / 0.12)';
    case 'sticky-note': return 'rgb(var(--ctp-warning) / 0.19)';
    case 'zone': return 'rgb(var(--ctp-accent2) / 0.12)';
    default: return '#31324440';
  }
}

function rectStroke(type: string): string {
  switch (type) {
    case 'agent': return 'rgb(var(--ctp-accent))';
    case 'anchor': return 'rgb(var(--ctp-warning))';
    case 'plugin': return 'rgb(var(--ctp-success))';
    case 'sticky-note': return 'rgb(var(--ctp-warning))';
    case 'zone': return 'rgb(var(--ctp-accent2))';
    default: return '#45475a';
  }
}

// ── Delete confirmation bar ──────────────────────────────────────────

function DeleteConfirmBar({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-surface-0 bg-ctp-error/5" data-testid="blueprint-delete-confirm">
      <span className="text-xs text-ctp-error">Delete this blueprint permanently?</span>
      <div className="flex items-center gap-2">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-xs text-ctp-subtext1 hover:bg-surface-1 rounded"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-2.5 py-1 text-xs text-ctp-base bg-ctp-error rounded hover:bg-ctp-error/90"
          data-testid="blueprint-delete-confirm-yes"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
