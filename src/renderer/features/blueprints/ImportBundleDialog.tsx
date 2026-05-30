import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { BlueprintBundle } from '../../../shared/blueprint-types';
import { importBundle, validateBundle, type BundleImportResult } from './blueprint-bundle';

export interface ImportBundleDialogProps {
  bundle: BlueprintBundle;
  onImport: (result: BundleImportResult) => void;
  onClose: () => void;
}

export function ImportBundleDialog({ bundle, onImport, onClose }: ImportBundleDialogProps) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  }, [onClose]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setError(null);

    const validation = validateBundle(bundle);
    if (!validation.valid) {
      setError(validation.errors.join(', '));
      setImporting(false);
      return;
    }

    const result = importBundle(bundle);

    if (result.errors.length > 0 && result.canvases.length === 0) {
      setError(result.errors.join(', '));
      setImporting(false);
      return;
    }

    onImport(result);
  }, [bundle, onImport]);

  const canvasCount = bundle.blueprints.length;
  const totalViews = bundle.metadata?.totalViews ?? bundle.blueprints.reduce((s, bp) => s + bp.canvas.views.length, 0);
  const totalAgents = bundle.metadata?.totalAgents ?? bundle.blueprints.reduce((s, bp) => s + (bp.agents?.length ?? 0), 0);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: "var(--z-index-top)" }}
      onClick={handleBackdropClick}
      data-testid="import-bundle-dialog"
    >
      <div className="bg-ctp-mantle border border-surface-2 rounded-lg shadow-2xl w-[400px] flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-0">
          <h3 className="text-sm font-medium text-ctp-text">Import Blueprint Bundle</h3>
          <p className="text-[11px] text-ctp-subtext0 mt-0.5">{bundle.name}</p>
        </div>

        <div className="px-4 py-3 space-y-2">
          <div className="text-[12px] text-ctp-text space-y-1">
            <div className="flex justify-between">
              <span className="text-ctp-subtext0">Canvases to import:</span>
              <span className="font-medium">{canvasCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ctp-subtext0">Total views:</span>
              <span>{totalViews}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ctp-subtext0">Agents to resolve:</span>
              <span>{totalAgents}</span>
            </div>
          </div>

          {bundle.blueprints.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] text-ctp-subtext0 mb-1">Canvases:</div>
              <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
                {bundle.blueprints.map((bp, i) => (
                  <div key={i} className="text-[11px] text-ctp-text px-2 py-1 bg-surface-0 rounded flex justify-between">
                    <span className="truncate">{bp.name}</span>
                    <span className="text-ctp-overlay0 ml-2 flex-shrink-0">{bp.canvas.views.length} views</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {bundle.description && (
            <p className="text-[11px] text-ctp-overlay0 italic">{bundle.description}</p>
          )}

          {error && (
            <div className="text-[11px] px-2 py-1.5 rounded bg-ctp-red/10 text-ctp-red">{error}</div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-surface-0 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-[11px] text-ctp-subtext0 hover:bg-surface-1 rounded transition-colors">Cancel</button>
          <button
            onClick={handleImport}
            disabled={importing}
            className="px-3 py-1.5 text-[11px] bg-ctp-accent text-ctp-base rounded hover:opacity-90 transition-opacity disabled:opacity-50"
            data-testid="import-bundle-submit"
          >
            {importing ? 'Importing...' : `Import ${canvasCount} Canvas${canvasCount !== 1 ? 'es' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
