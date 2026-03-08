import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { fileState } from './state';
import type { Tab, ScrollState } from './state';
import { TabBar } from './TabBar';
import { MonacoEditor, disposeModel, updateSavedContent, getModelContent } from './MonacoEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { BINARY_EXTENSIONS, IMAGE_EXTENSIONS, EXT_TO_LANG } from './file-icons';

// ── Helpers ────────────────────────────────────────────────────────────

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function getLanguage(ext: string): string {
  return EXT_TO_LANG[ext] || 'plaintext';
}

const MAX_TEXT_SIZE = 1_000_000; // 1 MB
const MAX_IMAGE_SIZE = 10_000_000; // 10 MB

type FileType = 'text' | 'binary' | 'image' | 'svg' | 'markdown' | 'none' | 'too-large';

// Per-tab loaded file data (cached to avoid reloading on tab switch)
interface LoadedFile {
  filePath: string;
  content: string;
  binaryData: string;
  fileType: FileType;
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

// ── Open in Finder button ─────────────────────────────────────────────

function OpenInFinderButton({ api, relativePath }: { api: PluginAPI; relativePath: string }) {
  return React.createElement('button', {
    className: 'px-3 py-1.5 text-xs bg-ctp-surface0 text-ctp-text rounded hover:bg-ctp-surface1 transition-colors',
    onClick: () => api.files.showInFolder(relativePath),
  }, 'Open in Finder');
}

// ── FileViewer (MainPanel) ────────────────────────────────────────────

export function FileViewer({ api }: { api: PluginAPI }) {
  const [activeTab, setActiveTab] = useState<Tab | undefined>(fileState.getActiveTab());
  const [loadedFile, setLoadedFile] = useState<LoadedFile | null>(null);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>('preview');
  const [loading, setLoading] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<{ tabId: string; pendingAction: () => void } | null>(null);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);

  // Cache of loaded file data per path to avoid reloading on tab switch
  const fileCache = useRef<Map<string, LoadedFile>>(new Map());

  // ── Subscribe to tab state changes ────────────────────────────────

  useEffect(() => {
    return fileState.subscribe(() => {
      const newActiveTab = fileState.getActiveTab();
      setActiveTab(newActiveTab ? { ...newActiveTab } : undefined);

      // Handle scroll-to-line from search results
      const lineTarget = fileState.scrollToLine;
      if (lineTarget) {
        setTimeout(() => setScrollToLine(lineTarget), 100);
        fileState.clearScrollToLine();
      }
    });
  }, []);

  // ── Load file when active tab changes ─────────────────────────────

  const loadFile = useCallback(async (relativePath: string): Promise<LoadedFile> => {
    // Check cache first
    const cached = fileCache.current.get(relativePath);
    if (cached) return cached;

    const ext = getExtension(relativePath);
    const result: LoadedFile = {
      filePath: relativePath,
      content: '',
      binaryData: '',
      fileType: 'none',
    };

    try {
      if (BINARY_EXTENSIONS.has(ext)) {
        result.fileType = 'binary';
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        const stat = await api.files.stat(relativePath);
        if (stat.size > MAX_IMAGE_SIZE) {
          result.fileType = 'too-large';
        } else {
          result.binaryData = await api.files.readBinary(relativePath);
          result.fileType = 'image';
        }
      } else if (ext === 'svg') {
        const text = await api.files.readFile(relativePath);
        result.content = text;
        result.fileType = 'svg';
        const b64 = btoa(unescape(encodeURIComponent(text)));
        result.binaryData = `data:image/svg+xml;base64,${b64}`;
      } else if (ext === 'md' || ext === 'mdx') {
        result.content = await api.files.readFile(relativePath);
        result.fileType = 'markdown';
      } else {
        const stat = await api.files.stat(relativePath);
        if (stat.size > MAX_TEXT_SIZE) {
          result.fileType = 'too-large';
        } else {
          result.content = await api.files.readFile(relativePath);
          result.fileType = 'text';
        }
      }
    } catch {
      result.fileType = 'none';
    }

    fileCache.current.set(relativePath, result);
    return result;
  }, [api]);

  // Load file when active tab changes
  useEffect(() => {
    if (!activeTab) {
      setLoadedFile(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    loadFile(activeTab.filePath).then((result) => {
      if (!cancelled) {
        setLoadedFile(result);
        // Reset preview mode for markdown/svg
        if (result.fileType === 'markdown' || result.fileType === 'svg') {
          setPreviewMode('preview');
        }
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [activeTab?.filePath, loadFile]);

  // ── Persist tab state ─────────────────────────────────────────────

  useEffect(() => {
    const persist = () => {
      const data = fileState.serialize();
      api.storage.project.write('files:tabState', JSON.stringify(data)).catch(() => {});
    };

    return fileState.subscribe(persist);
  }, [api]);

  // Restore tabs on mount
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const raw = await api.storage.project.read('files:tabState');
        if (cancelled || !raw || typeof raw !== 'string') return;
        const data = JSON.parse(raw);
        if (data && data.tabs && Array.isArray(data.tabs)) {
          fileState.restore(data);
        }
      } catch {
        // Fresh start — no persisted tabs
      }
    }
    restore();
    return () => { cancelled = true; };
  }, [api]);

  // ── Tab close handler (with dirty check) ──────────────────────────

  const handleCloseTab = useCallback(async (tabId: string) => {
    const tab = fileState.getTab(tabId);
    if (!tab) return;

    // If pinned, unpin first (don't close)
    if (tab.isPinned) {
      fileState.unpinTab(tabId);
      return;
    }

    if (tab.isDirty) {
      setUnsavedDialog({
        tabId,
        pendingAction: () => {
          // Dispose the Monaco model for this file
          disposeModel(tab.filePath);
          fileCache.current.delete(tab.filePath);
          fileState.closeTab(tabId);
        },
      });
      return;
    }

    disposeModel(tab.filePath);
    fileCache.current.delete(tab.filePath);
    fileState.closeTab(tabId);
  }, []);

  // ── Save file ─────────────────────────────────────────────────────

  const saveFile = useCallback(async (filePath: string) => {
    const content = getModelContent(filePath);
    if (content === null) return;
    try {
      await api.files.writeFile(filePath, content);
      updateSavedContent(filePath, content);
      const tab = fileState.getTabByPath(filePath);
      if (tab) {
        fileState.setTabDirty(tab.id, false);
      }
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
    }
  }, [api]);

  // ── Dirty change handler ──────────────────────────────────────────

  const handleDirtyChange = useCallback((dirty: boolean) => {
    if (!activeTab) return;
    fileState.setTabDirty(activeTab.id, dirty);
  }, [activeTab?.id]);

  // ── Save from Monaco (Cmd+S) ─────────────────────────────────────

  const handleSave = useCallback(async (newContent: string) => {
    if (!activeTab) return;
    try {
      await api.files.writeFile(activeTab.filePath, newContent);
      updateSavedContent(activeTab.filePath, newContent);
      fileState.setTabDirty(activeTab.id, false);
      // Update cache
      const cached = fileCache.current.get(activeTab.filePath);
      if (cached) {
        cached.content = newContent;
      }
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
    }
  }, [api, activeTab?.id, activeTab?.filePath]);

  // ── Scroll state handler ──────────────────────────────────────────

  const handleScrollStateChange = useCallback((scrollState: ScrollState) => {
    if (!activeTab) return;
    fileState.setTabScrollState(activeTab.id, scrollState);
  }, [activeTab?.id]);

  // ── Reveal in tree ────────────────────────────────────────────────

  const handleRevealInTree = useCallback((filePath: string) => {
    // The FileTree listens to selectedPath changes
    fileState.selectedPath = filePath;
    fileState.notify();
  }, []);

  // ── Unsaved dialog handlers ───────────────────────────────────────

  const handleDialogSave = useCallback(async () => {
    if (!unsavedDialog) return;
    const tab = fileState.getTab(unsavedDialog.tabId);
    if (tab) {
      await saveFile(tab.filePath);
    }
    const action = unsavedDialog.pendingAction;
    setUnsavedDialog(null);
    action();
  }, [unsavedDialog, saveFile]);

  const handleDialogDiscard = useCallback(() => {
    if (!unsavedDialog) return;
    const tab = fileState.getTab(unsavedDialog.tabId);
    if (tab) {
      fileState.setTabDirty(unsavedDialog.tabId, false);
    }
    const action = unsavedDialog.pendingAction;
    setUnsavedDialog(null);
    action();
  }, [unsavedDialog]);

  const handleDialogCancel = useCallback(() => {
    setUnsavedDialog(null);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────

  // No tabs open — empty state
  if (!activeTab || !loadedFile) {
    return React.createElement('div', {
      className: 'flex flex-col h-full bg-ctp-base',
    },
      // Still show tab bar if there are tabs (loading state)
      fileState.openTabs.length > 0
        ? React.createElement(TabBar, { api, onCloseTab: handleCloseTab, onRevealInTree: handleRevealInTree })
        : null,
      React.createElement('div', {
        className: 'flex flex-col items-center justify-center flex-1 text-ctp-subtext0',
      },
        React.createElement('svg', {
          width: 40, height: 40, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
          className: 'mb-3 opacity-50',
        },
          React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
          React.createElement('polyline', { points: '14 2 14 8 20 8' }),
        ),
        React.createElement('p', { className: 'text-xs' }, 'Select a file to view'),
        React.createElement('p', { className: 'text-[10px] mt-1 opacity-60' }, 'Click a file in the sidebar'),
      ),
    );
  }

  if (loading) {
    return React.createElement('div', {
      className: 'flex flex-col h-full bg-ctp-base',
    },
      React.createElement(TabBar, { api, onCloseTab: handleCloseTab, onRevealInTree: handleRevealInTree }),
      React.createElement('div', {
        className: 'flex items-center justify-center flex-1 text-ctp-subtext0 text-xs',
      }, 'Loading...'),
    );
  }

  const fileName = getFileName(activeTab.filePath);
  const ext = getExtension(activeTab.filePath);
  const lang = getLanguage(ext);

  // File header (below tab bar)
  const header = React.createElement('div', {
    className: 'flex items-center justify-between px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
  },
    React.createElement('div', { className: 'flex items-center gap-2 min-w-0' },
      React.createElement('span', { className: 'text-xs font-medium text-ctp-text truncate' }, fileName),
      activeTab.isDirty
        ? React.createElement('span', {
            className: 'w-2 h-2 rounded-full bg-ctp-peach flex-shrink-0',
            title: 'Unsaved changes',
          })
        : null,
      lang !== 'plaintext'
        ? React.createElement('span', {
            className: 'text-[10px] px-1.5 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext0 flex-shrink-0',
          }, lang)
        : null,
    ),
    React.createElement('div', { className: 'flex items-center gap-2 flex-shrink-0' },
      // Preview/Source toggle for markdown and SVG
      (loadedFile.fileType === 'markdown' || loadedFile.fileType === 'svg')
        ? React.createElement('div', { className: 'flex items-center bg-ctp-surface0 rounded text-[10px]' },
            React.createElement('button', {
              className: `px-2 py-0.5 rounded ${previewMode === 'preview' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-subtext0'}`,
              onClick: () => setPreviewMode('preview'),
            }, 'Preview'),
            React.createElement('button', {
              className: `px-2 py-0.5 rounded ${previewMode === 'source' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-subtext0'}`,
              onClick: () => setPreviewMode('source'),
            }, 'Source'),
          )
        : null,
      React.createElement('span', {
        className: 'text-[10px] text-ctp-subtext0 truncate max-w-[200px]',
        title: activeTab.filePath,
      }, activeTab.filePath),
      React.createElement(OpenInFinderButton, { api, relativePath: activeTab.filePath }),
    ),
  );

  let body: React.ReactElement;

  switch (loadedFile.fileType) {
    case 'binary':
      body = React.createElement('div', {
        className: 'flex flex-col items-center justify-center flex-1 text-ctp-subtext0 gap-3',
      },
        React.createElement('p', { className: 'text-xs' }, 'Cannot display binary file'),
        React.createElement(OpenInFinderButton, { api, relativePath: activeTab.filePath }),
      );
      break;

    case 'too-large':
      body = React.createElement('div', {
        className: 'flex flex-col items-center justify-center flex-1 text-ctp-subtext0 gap-3',
      },
        React.createElement('p', { className: 'text-xs' }, 'File too large to display'),
        React.createElement(OpenInFinderButton, { api, relativePath: activeTab.filePath }),
      );
      break;

    case 'image':
      body = React.createElement('div', {
        className: 'flex items-center justify-center flex-1 p-4 overflow-auto',
      },
        React.createElement('img', {
          src: loadedFile.binaryData,
          alt: fileName,
          className: 'max-w-full max-h-full object-contain',
        }),
      );
      break;

    case 'svg':
      if (previewMode === 'preview') {
        body = React.createElement('div', {
          className: 'flex items-center justify-center flex-1 p-4 overflow-auto',
        },
          React.createElement('img', {
            src: loadedFile.binaryData,
            alt: fileName,
            className: 'max-w-full max-h-full object-contain',
          }),
        );
      } else {
        body = React.createElement('div', { className: 'flex-1 min-h-0' },
          React.createElement(MonacoEditor, {
            key: activeTab.filePath,
            value: loadedFile.content,
            language: 'xml',
            onSave: handleSave,
            onDirtyChange: handleDirtyChange,
            filePath: activeTab.filePath,
            initialScrollState: activeTab.scrollState,
            onScrollStateChange: handleScrollStateChange,
            scrollToLine,
          }),
        );
      }
      break;

    case 'markdown':
      if (previewMode === 'preview') {
        body = React.createElement('div', { className: 'flex-1 min-h-0 overflow-auto' },
          React.createElement(MarkdownPreview, { content: loadedFile.content }),
        );
      } else {
        body = React.createElement('div', { className: 'flex-1 min-h-0' },
          React.createElement(MonacoEditor, {
            key: activeTab.filePath,
            value: loadedFile.content,
            language: 'markdown',
            onSave: handleSave,
            onDirtyChange: handleDirtyChange,
            filePath: activeTab.filePath,
            initialScrollState: activeTab.scrollState,
            onScrollStateChange: handleScrollStateChange,
            scrollToLine,
          }),
        );
      }
      break;

    default: // text
      body = React.createElement('div', { className: 'flex-1 min-h-0' },
        React.createElement(MonacoEditor, {
          key: activeTab.filePath,
          value: loadedFile.content,
          language: lang,
          onSave: handleSave,
          onDirtyChange: handleDirtyChange,
          filePath: activeTab.filePath,
          initialScrollState: activeTab.scrollState,
          onScrollStateChange: handleScrollStateChange,
          scrollToLine,
        }),
      );
      break;
  }

  const dialogFileName = unsavedDialog
    ? getFileName(fileState.getTab(unsavedDialog.tabId)?.filePath || '')
    : '';

  return React.createElement('div', {
    className: 'flex flex-col h-full bg-ctp-base relative',
  },
    React.createElement(TabBar, { api, onCloseTab: handleCloseTab, onRevealInTree: handleRevealInTree }),
    header,
    body,
    // Unsaved changes dialog
    unsavedDialog
      ? React.createElement(UnsavedDialog, {
          fileName: dialogFileName,
          onSave: handleDialogSave,
          onDiscard: handleDialogDiscard,
          onCancel: handleDialogCancel,
        })
      : null,
  );
}
