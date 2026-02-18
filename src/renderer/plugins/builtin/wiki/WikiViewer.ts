import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI, FilesAPI } from '../../../../shared/plugin-types';
import type { FileNode } from '../../../../shared/types';
import { wikiState } from './state';
import { MonacoEditor } from '../files/MonacoEditor';
import { WikiMarkdownPreview } from './WikiMarkdownPreview';
import { SendToAgentDialog } from './SendToAgentDialog';

// ── Helpers ────────────────────────────────────────────────────────────

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function prettifyName(name: string, wikiStyle: string = 'github'): string {
  let base = name.replace(/\.md$/i, '');
  if (wikiStyle === 'ado') {
    base = base.replace(/%2D/gi, '\x00').replace(/-/g, ' ').replace(/\x00/g, '-');
  } else {
    base = base.replace(/[-_]/g, ' ');
  }
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

function getBreadcrumb(path: string): string {
  return path.replace(/\//g, ' / ');
}

// ── Collect markdown files from a FileNode tree ────────────────────────

function collectMarkdownFiles(nodes: FileNode[], result: { name: string; path: string }[]): void {
  for (const node of nodes) {
    if (node.isDirectory) {
      if (node.children) {
        collectMarkdownFiles(node.children, result);
      }
    } else if (node.name.endsWith('.md')) {
      result.push({ name: node.name, path: node.path });
    }
  }
}

// ── Unsaved Changes Dialog ────────────────────────────────────────────

interface UnsavedDialogProps {
  fileName: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

function UnsavedDialog({ fileName, onSave, onDiscard, onCancel }: UnsavedDialogProps) {
  return React.createElement('div', {
    className: 'absolute inset-0 z-40 flex items-center justify-center bg-ctp-base/80',
  },
    React.createElement('div', {
      className: 'bg-ctp-mantle border border-ctp-surface0 rounded-lg shadow-lg p-4 max-w-sm mx-4',
    },
      React.createElement('p', { className: 'text-sm text-ctp-text mb-4' },
        `"${fileName}" has unsaved changes.`,
      ),
      React.createElement('div', { className: 'flex gap-2 justify-end' },
        React.createElement('button', {
          className: 'px-3 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: onCancel,
        }, 'Cancel'),
        React.createElement('button', {
          className: 'px-3 py-1 text-xs text-ctp-red hover:bg-ctp-surface0 rounded transition-colors',
          onClick: onDiscard,
        }, 'Discard'),
        React.createElement('button', {
          className: 'px-3 py-1 text-xs bg-ctp-accent text-ctp-base rounded hover:opacity-90 transition-colors',
          onClick: onSave,
        }, 'Save'),
      ),
    ),
  );
}

// ── WikiViewer (MainPanel) ────────────────────────────────────────────

export function WikiViewer({ api }: { api: PluginAPI }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(wikiState.selectedPath);
  const [content, setContent] = useState<string>('');
  const [viewMode, setViewMode] = useState<'view' | 'edit'>(wikiState.viewMode);
  const [isDirty, setIsDirty] = useState(wikiState.isDirty);
  const [loading, setLoading] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<{ pendingPath: string } | null>(null);
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [pageNames, setPageNames] = useState<string[]>([]);
  const [canGoBack, setCanGoBack] = useState(wikiState.canGoBack());

  const contentRef = useRef(content);
  contentRef.current = content;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  const wikiFilesRef = useRef<FilesAPI | null>(null);
  const pagePathMapRef = useRef<Map<string, string>>(new Map());
  const wikiStyle = api.settings.get<string>('wikiStyle') || 'github';

  // Obtain scoped files API
  const getScopedFiles = useCallback((): FilesAPI | null => {
    try {
      const scoped = api.files.forRoot('wiki');
      wikiFilesRef.current = scoped;
      return scoped;
    } catch {
      wikiFilesRef.current = null;
      return null;
    }
  }, [api]);

  // Load page names from the wiki root
  const loadPageNames = useCallback(async () => {
    const scoped = getScopedFiles();
    if (!scoped) {
      setPageNames([]);
      pagePathMapRef.current = new Map();
      return;
    }

    try {
      const tree = await scoped.readTree('.', { depth: 10 });
      const files: { name: string; path: string }[] = [];
      collectMarkdownFiles(tree, files);

      const names: string[] = [];
      const pathMap = new Map<string, string>();

      for (const file of files) {
        const baseName = file.name.replace(/\.md$/i, '');
        names.push(baseName);
        // Map by basename (for GitHub [[wiki links]])
        pathMap.set(baseName.toLowerCase(), file.path);
        // Also map by relative path without extension (for ADO path-based links)
        const pathWithoutExt = file.path.replace(/\.md$/i, '').toLowerCase();
        pathMap.set(pathWithoutExt, file.path);
      }

      setPageNames(names);
      pagePathMapRef.current = pathMap;
    } catch {
      setPageNames([]);
      pagePathMapRef.current = new Map();
    }
  }, [getScopedFiles]);

  // Handle wiki link navigation
  const handleWikiNavigate = useCallback((pageName: string) => {
    const key = pageName.toLowerCase();
    // Try direct match (works for both basename and path-based lookup)
    const match = pagePathMapRef.current.get(key);
    if (match) {
      wikiState.setSelectedPath(match);
      return;
    }
    // For ADO-style, also try with .md appended and path variations
    const withMd = pagePathMapRef.current.get(key.replace(/\.md$/i, ''));
    if (withMd) {
      wikiState.setSelectedPath(withMd);
      return;
    }
    // Try matching just the last segment (page name) for cross-directory links
    const lastSegment = key.split('/').pop() || key;
    const fallback = pagePathMapRef.current.get(lastSegment);
    if (fallback) {
      wikiState.setSelectedPath(fallback);
    }
  }, []);

  // Load file content
  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    const scoped = getScopedFiles();
    if (!scoped) {
      setContent('');
      setLoading(false);
      return;
    }

    try {
      const text = await scoped.readFile(path);
      setContent(text);
    } catch {
      setContent('');
    }
    setLoading(false);
  }, [getScopedFiles]);

  // Load page names on mount
  useEffect(() => {
    loadPageNames();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload page names on refreshCount changes
  useEffect(() => {
    return wikiState.subscribe(() => {
      loadPageNames();
    });
  }, [loadPageNames]);

  // Load initial file if selectedPath is already set on mount
  useEffect(() => {
    if (selectedPath) {
      loadFile(selectedPath);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle file selection with unsaved changes check
  const switchToFile = useCallback((newPath: string | null) => {
    if (!newPath) {
      setSelectedPath(null);
      setContent('');
      return;
    }

    if (isDirtyRef.current && selectedPathRef.current) {
      setUnsavedDialog({ pendingPath: newPath });
      return;
    }

    setSelectedPath(newPath);
    selectedPathRef.current = newPath;
    setIsDirty(false);
    wikiState.setDirty(false);
    loadFile(newPath);
  }, [loadFile]);

  // Subscribe to wikiState changes
  useEffect(() => {
    return wikiState.subscribe(() => {
      const newPath = wikiState.selectedPath;
      if (newPath !== selectedPathRef.current) {
        switchToFile(newPath);
      }
      setViewMode(wikiState.viewMode);
      setCanGoBack(wikiState.canGoBack());
    });
  }, [switchToFile]);

  // Save file
  const saveFile = useCallback(async () => {
    if (!selectedPath) return;
    const scoped = wikiFilesRef.current;
    if (!scoped) return;
    try {
      await scoped.writeFile(selectedPath, contentRef.current);
      setIsDirty(false);
      wikiState.setDirty(false);
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
    }
  }, [api, selectedPath]);

  // Handle dirty change from Monaco
  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
    wikiState.setDirty(dirty);
  }, []);

  // Handle save from Monaco (Cmd+S)
  const handleSave = useCallback(async (newContent: string) => {
    if (!selectedPath) return;
    const scoped = wikiFilesRef.current;
    if (!scoped) return;
    try {
      setContent(newContent);
      await scoped.writeFile(selectedPath, newContent);
      setIsDirty(false);
      wikiState.setDirty(false);
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
    }
  }, [api, selectedPath]);

  // View/Edit mode toggle
  const handleToggleMode = useCallback((mode: 'view' | 'edit') => {
    setViewMode(mode);
    wikiState.setViewMode(mode);
  }, []);

  // Back navigation
  const handleGoBack = useCallback(() => {
    wikiState.goBack();
  }, []);

  // Unsaved dialog handlers
  const handleDialogSave = useCallback(async () => {
    if (!unsavedDialog) return;
    await saveFile();
    const pendingPath = unsavedDialog.pendingPath;
    setUnsavedDialog(null);
    setSelectedPath(pendingPath);
    setIsDirty(false);
    wikiState.setDirty(false);
    loadFile(pendingPath);
  }, [unsavedDialog, saveFile, loadFile]);

  const handleDialogDiscard = useCallback(() => {
    if (!unsavedDialog) return;
    const pendingPath = unsavedDialog.pendingPath;
    setUnsavedDialog(null);
    setSelectedPath(pendingPath);
    setIsDirty(false);
    wikiState.setDirty(false);
    loadFile(pendingPath);
  }, [unsavedDialog, loadFile]);

  const handleDialogCancel = useCallback(() => {
    setUnsavedDialog(null);
  }, []);

  // ── Empty state ────────────────────────────────────────────────────

  if (!selectedPath) {
    return React.createElement('div', {
      className: 'flex flex-col items-center justify-center h-full text-ctp-subtext0',
    },
      React.createElement('svg', {
        width: 40, height: 40, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        className: 'mb-3 opacity-50',
      },
        React.createElement('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
        React.createElement('path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }),
      ),
      React.createElement('p', { className: 'text-xs' }, 'Select a page to view'),
      React.createElement('p', { className: 'text-[10px] mt-1 opacity-60' }, 'Click a page in the sidebar'),
    );
  }

  if (loading) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Loading...');
  }

  const fileName = getFileName(selectedPath);
  const displayName = viewMode === 'view' ? prettifyName(fileName, wikiStyle) : fileName;

  // Header
  const header = React.createElement('div', {
    className: 'flex items-center justify-between px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
  },
    React.createElement('div', { className: 'flex items-center gap-2 min-w-0' },
      // Back button
      React.createElement('button', {
        className: `p-0.5 rounded transition-colors flex-shrink-0 ${canGoBack ? 'text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0' : 'text-ctp-surface1 cursor-default'}`,
        onClick: canGoBack ? handleGoBack : undefined,
        disabled: !canGoBack,
        title: 'Go back',
      },
        React.createElement('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          React.createElement('polyline', { points: '15 18 9 12 15 6' }),
        ),
      ),
      React.createElement('span', { className: 'text-xs font-medium text-ctp-text truncate' }, displayName),
      isDirty
        ? React.createElement('span', {
            className: 'w-2 h-2 rounded-full bg-ctp-peach flex-shrink-0',
            title: 'Unsaved changes',
          })
        : null,
    ),
    React.createElement('div', { className: 'flex items-center gap-2 flex-shrink-0' },
      // View/Edit toggle
      React.createElement('div', { className: 'flex items-center bg-ctp-surface0 rounded text-[10px]' },
        React.createElement('button', {
          className: `px-2 py-0.5 rounded ${viewMode === 'view' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-subtext0'}`,
          onClick: () => handleToggleMode('view'),
        }, 'View'),
        React.createElement('button', {
          className: `px-2 py-0.5 rounded ${viewMode === 'edit' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-subtext0'}`,
          onClick: () => handleToggleMode('edit'),
        }, 'Edit'),
      ),
      // Send to Agent
      React.createElement('button', {
        className: 'px-2 py-0.5 text-[10px] text-ctp-accent hover:bg-ctp-accent/10 rounded transition-colors',
        onClick: () => setShowSendDialog(true),
      }, 'Send to Agent'),
      // Breadcrumb
      React.createElement('span', {
        className: 'text-[10px] text-ctp-subtext0 truncate max-w-[200px]',
        title: selectedPath,
      }, getBreadcrumb(selectedPath)),
    ),
  );

  // Body
  let body: React.ReactElement;

  if (viewMode === 'view') {
    body = React.createElement('div', { className: 'flex-1 min-h-0 overflow-auto' },
      React.createElement(WikiMarkdownPreview, { content, pageNames, onNavigate: handleWikiNavigate, wikiStyle }),
    );
  } else {
    body = React.createElement('div', { className: 'flex-1 min-h-0' },
      React.createElement(MonacoEditor, {
        value: content,
        language: 'markdown',
        onSave: handleSave,
        onDirtyChange: handleDirtyChange,
        filePath: selectedPath,
      }),
    );
  }

  return React.createElement('div', {
    className: 'flex flex-col h-full bg-ctp-base relative',
  },
    header,
    body,
    // Unsaved changes dialog
    unsavedDialog
      ? React.createElement(UnsavedDialog, {
          fileName: displayName,
          onSave: handleDialogSave,
          onDiscard: handleDialogDiscard,
          onCancel: handleDialogCancel,
        })
      : null,
    // Send to Agent dialog
    showSendDialog
      ? React.createElement(SendToAgentDialog, {
          api,
          filePath: selectedPath,
          content,
          onClose: () => setShowSendDialog(false),
        })
      : null,
  );
}
