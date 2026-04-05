import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { CanvasInstance } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import type { Agent, Project } from '../../../shared/types';
import { exportCanvasToBlueprint, type ExportContext } from './blueprint-export';
import { saveToBlueprintsDir, saveToClipboard, saveToFile, type ExportDestination, type ExportResult } from './blueprint-destinations';

export interface ExportBlueprintDialogProps {
  canvas: CanvasInstance;
  agents: Record<string, Agent>;
  projects: Record<string, Project>;
  wireDefinitions: McpBindingEntry[];
  projectId?: string;
  projectPath?: string;
  appVersion?: string;
  onClose: () => void;
}

export function ExportBlueprintDialog({
  canvas,
  agents,
  projects,
  wireDefinitions,
  projectId,
  projectPath,
  appVersion,
  onClose,
}: ExportBlueprintDialogProps) {
  const [name, setName] = useState(canvas.name);
  const [description, setDescription] = useState('');
  const [destination, setDestination] = useState<ExportDestination>(
    projectPath ? 'blueprints-dir' : 'clipboard',
  );
  const [result, setResult] = useState<ExportResult | null>(null);
  const [exporting, setExporting] = useState(false);

  const backdropRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

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

    const ctx: ExportContext = {
      agents,
      projects,
      wireDefinitions,
      projectId,
      appVersion,
    };

    const manifest = exportCanvasToBlueprint(canvas, ctx);
    manifest.name = name.trim() || canvas.name;
    manifest.description = description.trim() || undefined;

    let exportResult: ExportResult;
    switch (destination) {
      case 'blueprints-dir':
        exportResult = await saveToBlueprintsDir(manifest, projectPath!);
        break;
      case 'clipboard':
        exportResult = await saveToClipboard(manifest);
        break;
      case 'file':
        exportResult = await saveToFile(manifest);
        break;
    }

    setResult(exportResult);
    setExporting(false);

    if (exportResult.success) {
      setTimeout(onClose, 1200);
    }
  }, [name, description, destination, canvas, agents, projects, wireDefinitions, projectId, projectPath, appVersion, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !exporting) {
      e.preventDefault();
      handleExport();
    }
  }, [exporting, handleExport]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: 100000 }}
      onClick={handleBackdropClick}
      data-testid="export-blueprint-dialog"
    >
      <div className="bg-ctp-mantle border border-surface-2 rounded-lg shadow-2xl w-[420px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-surface-0 flex items-center justify-between">
          <h3 className="text-sm font-medium text-ctp-text">Export as Blueprint</h3>
          <button
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          {/* Name */}
          <div>
            <label className="block text-[11px] text-ctp-subtext0 mb-1">Name</label>
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full px-2 py-1.5 text-[12px] bg-surface-0 border border-surface-1 rounded text-ctp-text outline-none focus:border-ctp-accent"
              placeholder={canvas.name}
              data-testid="export-blueprint-name"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-[11px] text-ctp-subtext0 mb-1">Description (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full px-2 py-1.5 text-[12px] bg-surface-0 border border-surface-1 rounded text-ctp-text outline-none focus:border-ctp-accent"
              placeholder="Brief description of this blueprint"
              data-testid="export-blueprint-description"
            />
          </div>

          {/* Destination */}
          <div>
            <label className="block text-[11px] text-ctp-subtext0 mb-1">Destination</label>
            <div className="space-y-1.5">
              {projectPath && (
                <label className="flex items-center gap-2 text-[12px] text-ctp-text cursor-pointer">
                  <input
                    type="radio"
                    name="destination"
                    checked={destination === 'blueprints-dir'}
                    onChange={() => setDestination('blueprints-dir')}
                    className="accent-ctp-accent"
                  />
                  .clubhouse/blueprints/
                </label>
              )}
              <label className="flex items-center gap-2 text-[12px] text-ctp-text cursor-pointer">
                <input
                  type="radio"
                  name="destination"
                  checked={destination === 'clipboard'}
                  onChange={() => setDestination('clipboard')}
                  className="accent-ctp-accent"
                />
                Copy to clipboard
              </label>
              <label className="flex items-center gap-2 text-[12px] text-ctp-text cursor-pointer">
                <input
                  type="radio"
                  name="destination"
                  checked={destination === 'file'}
                  onChange={() => setDestination('file')}
                  className="accent-ctp-accent"
                />
                Save to file...
              </label>
            </div>
          </div>

          {/* Summary */}
          <div className="text-[11px] text-ctp-overlay0">
            {canvas.views.length} view{canvas.views.length !== 1 ? 's' : ''}
            {wireDefinitions.length > 0 && `, ${wireDefinitions.length} wire${wireDefinitions.length !== 1 ? 's' : ''}`}
          </div>

          {/* Result feedback */}
          {result && (
            <div className={`text-[11px] px-2 py-1.5 rounded ${result.success ? 'bg-ctp-green/10 text-ctp-green' : 'bg-ctp-red/10 text-ctp-red'}`}>
              {result.success
                ? result.filePath
                  ? `Saved to ${result.filePath}`
                  : 'Copied to clipboard'
                : `Export failed: ${result.error}`
              }
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-surface-0 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[11px] text-ctp-subtext0 hover:bg-surface-1 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || !name.trim()}
            className="px-3 py-1.5 text-[11px] bg-ctp-accent text-ctp-base rounded hover:opacity-90 transition-opacity disabled:opacity-50"
            data-testid="export-blueprint-submit"
          >
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
