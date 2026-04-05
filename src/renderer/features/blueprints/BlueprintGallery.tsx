import { useState, useEffect, useMemo, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';
import type { BlueprintSummary } from '../../../shared/blueprint-summary';
import { importBlueprint, validateBlueprint } from '../../plugins/builtin/canvas/canvas-blueprint';
import { getProjectCanvasStore, useAppCanvasStore } from '../../plugins/builtin/canvas/main';
import { useProjectStore } from '../../stores/projectStore';

export function BlueprintGallery() {
  const isOpen = useUIStore((s) => s.blueprintGalleryOpen);
  const close = useUIStore((s) => s.closeBlueprintGallery);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [blueprints, setBlueprints] = useState<BlueprintSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState<string | null>(null);

  // Fetch blueprints when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setSearch('');
    window.clubhouse.blueprint.list()
      .then(setBlueprints)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!search.trim()) return blueprints;
    const q = search.toLowerCase();
    return blueprints.filter(
      (b) => b.name.toLowerCase().includes(q) || b.description?.toLowerCase().includes(q) || b.source.toLowerCase().includes(q),
    );
  }, [blueprints, search]);

  const handleImport = useCallback(async (bp: BlueprintSummary) => {
    setImporting(bp.filePath);
    try {
      const data = await window.clubhouse.blueprint.read(bp.filePath);
      if (!data) throw new Error('Failed to read blueprint file');

      const validationError = validateBlueprint(data);
      if (validationError) throw new Error(validationError);

      const canvas = importBlueprint(data as any);

      // Add the imported canvas to the appropriate store
      const store = activeProjectId
        ? getProjectCanvasStore(activeProjectId)
        : useAppCanvasStore;

      store.getState().insertCanvas(canvas);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  }, [activeProjectId, close]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="blueprint-gallery-overlay"
    >
      <div
        className="bg-ctp-base border border-surface-0 rounded-xl shadow-2xl w-[560px] max-h-[480px] flex flex-col overflow-hidden"
        data-testid="blueprint-gallery"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-0">
          <h2 className="text-sm font-semibold text-ctp-text">Import Blueprint</h2>
          <button
            onClick={close}
            className="w-6 h-6 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text"
            data-testid="blueprint-gallery-close"
          >
            &times;
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-surface-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search blueprints..."
            className="w-full px-3 py-1.5 text-xs bg-ctp-mantle border border-surface-0 rounded-md text-ctp-text placeholder:text-ctp-overlay0 outline-none focus:border-ctp-accent"
            autoFocus
            data-testid="blueprint-gallery-search"
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
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
            <div className="flex flex-col items-center justify-center py-8 text-xs text-ctp-subtext0 gap-1">
              <span>No blueprints found</span>
              <span className="text-ctp-overlay0">
                Place .json files in .clubhouse/blueprints/ in any project
              </span>
            </div>
          )}

          {!loading && filtered.length > 0 && (
            <div className="grid grid-cols-2 gap-2" data-testid="blueprint-gallery-grid">
              {filtered.map((bp) => (
                <BlueprintCard
                  key={bp.filePath}
                  blueprint={bp}
                  onImport={() => handleImport(bp)}
                  importing={importing === bp.filePath}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BlueprintCard({
  blueprint: bp,
  onImport,
  importing,
}: {
  blueprint: BlueprintSummary;
  onImport: () => void;
  importing: boolean;
}) {
  return (
    <button
      onClick={onImport}
      disabled={importing}
      className="flex flex-col gap-1.5 p-3 rounded-lg border border-surface-0 bg-ctp-mantle hover:border-ctp-accent/50 hover:bg-surface-0 transition-colors text-left cursor-pointer disabled:opacity-50 disabled:cursor-wait"
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
      <div className="text-[10px] text-ctp-overlay0 truncate w-full">{bp.source}</div>
    </button>
  );
}
