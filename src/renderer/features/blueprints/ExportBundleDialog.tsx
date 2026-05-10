import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { Agent, Project } from '../../../shared/types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import {
  exportProjectBundle,
  saveBundleToBlueprintsDir,
  saveBundleToClipboard,
  saveBundleToFile,
  type BundleExportContext,
  type BundleExportDestination,
  type BundleExportResult,
} from './blueprint-bundle';

export interface ExportBundleDialogProps {
  canvases: CanvasInstance[];
  agents: Record<string, Agent>;
  projects: Record<string, Project>;
  wireDefinitions: McpBindingEntry[];
  projectId: string;
  projectPath: string;
  projectName: string;
  appVersion?: string;
  onClose: () => void;
}

export function ExportBundleDialog({
  canvases,
  agents,
  projects,
  wireDefinitions,
  projectId,
  projectPath,
  projectName,
  appVersion,
  onClose,
}: ExportBundleDialogProps) {
  const [name, setName] = useState(projectName);
  const [description, setDescription] = useState('');
  const [destination, setDestination] = useState<BundleExportDestination>('blueprints-dir');
  const [result, setResult] = useState<BundleExportResult | null>(null);
  const [exporting, setExporting] = useState(false);

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

  const handleExport = useCallback(async () => {
    setExporting(true);
    setResult(null);

    const ctx: BundleExportContext = {
      agents,
      projects,
      wireDefinitions,
      projectId,
      exportProjectPath: projectPath,
      projectName: name.trim() || projectName,
      appVersion,
    };

    const bundle = exportProjectBundle(canvases, ctx);
    bundle.name = name.trim() || projectName;
    bundle.description = description.trim() || undefined;

    let exportResult: BundleExportResult;
    switch (destination) {
      case 'blueprints-dir':
        exportResult = await saveBundleToBlueprintsDir(bundle, projectPath);
        break;
      case 'clipboard':
        exportResult = await saveBundleToClipboard(bundle);
        break;
      case 'file':
        exportResult = await saveBundleToFile(bundle);
        break;
    }

    setResult(exportResult);
    setExporting(false);
    if (exportResult.success) setTimeout(onClose, 1200);
  }, [name, description, destination, canvases, agents, projects, wireDefinitions, projectId, projectPath, projectName, appVersion, onClose]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: "var(--z-top)" }}
      onClick={handleBackdropClick}
      data-testid="export-bundle-dialog"
    >
      <div className="bg-ctp-mantle border border-surface-2 rounded-lg shadow-2xl w-[420px] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-0 flex items-center justify-between">
          <h3 className="text-sm font-medium text-ctp-text">Export Project as Blueprint Bundle</h3>
          <button onClick={onClose} className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text">&times;</button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="block text-[11px] text-ctp-subtext0 mb-1">Bundle Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2 py-1.5 text-[12px] bg-surface-0 border border-surface-1 rounded text-ctp-text outline-none focus:border-ctp-accent"
              placeholder={projectName}
              data-testid="export-bundle-name"
            />
          </div>

          <div>
            <label className="block text-[11px] text-ctp-subtext0 mb-1">Description (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-2 py-1.5 text-[12px] bg-surface-0 border border-surface-1 rounded text-ctp-text outline-none focus:border-ctp-accent"
              placeholder="Brief description of this bundle"
            />
          </div>

          <div>
            <label className="block text-[11px] text-ctp-subtext0 mb-1">Destination</label>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-[12px] text-ctp-text cursor-pointer">
                <input type="radio" name="dest" checked={destination === 'blueprints-dir'} onChange={() => setDestination('blueprints-dir')} className="accent-ctp-accent" />
                .clubhouse/blueprints/
              </label>
              <label className="flex items-center gap-2 text-[12px] text-ctp-text cursor-pointer">
                <input type="radio" name="dest" checked={destination === 'clipboard'} onChange={() => setDestination('clipboard')} className="accent-ctp-accent" />
                Copy to clipboard
              </label>
              <label className="flex items-center gap-2 text-[12px] text-ctp-text cursor-pointer">
                <input type="radio" name="dest" checked={destination === 'file'} onChange={() => setDestination('file')} className="accent-ctp-accent" />
                Save to file...
              </label>
            </div>
          </div>

          <div className="text-[11px] text-ctp-overlay0">
            {canvases.length} canvas{canvases.length !== 1 ? 'es' : ''}
            {' '}with {canvases.reduce((s, c) => s + c.views.length, 0)} total views
          </div>

          {result && (
            <div className={`text-[11px] px-2 py-1.5 rounded ${result.success ? 'bg-ctp-green/10 text-ctp-green' : 'bg-ctp-red/10 text-ctp-red'}`}>
              {result.success
                ? result.filePath ? `Saved to ${result.filePath}` : 'Copied to clipboard'
                : `Export failed: ${result.error}`}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-surface-0 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-[11px] text-ctp-subtext0 hover:bg-surface-1 rounded transition-colors">Cancel</button>
          <button
            onClick={handleExport}
            disabled={exporting || !name.trim()}
            className="px-3 py-1.5 text-[11px] bg-ctp-accent text-ctp-base rounded hover:opacity-90 transition-opacity disabled:opacity-50"
            data-testid="export-bundle-submit"
          >
            {exporting ? 'Exporting...' : `Export ${canvases.length} Canvas${canvases.length !== 1 ? 'es' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
