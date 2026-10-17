import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { fileState } from './state';
import type { Tab, ScrollState } from './state';
import { TabBar } from './TabBar';
import { MonacoEditor, disposeModel, disposeCleanModels, updateSavedContent, getModelContent } from './MonacoEditor';
import { useFilesScope } from './filesScope';
import { PopupMenu, type MenuItem } from '../../../chrome/sidebar/ProjectMenu';
import { MarkdownPreview } from './MarkdownPreview';
import { BINARY_EXTENSIONS, IMAGE_EXTENSIONS, EXT_TO_LANG } from './file-icons';
import { tel } from '../../../telemetry';

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

// Module-level cache shared across component mounts; cleared on plugin deactivation.
const _fileCache = new Map<string, LoadedFile>();

// Track the mtime of the last file we saved, so watch events from our own writes are ignored.
const _savedMtimes = new Map<string, number>();

// Scopes whose saved tabs were read back this activation (see the restore effect).
const _restoredScopes = new Set<string | null>();

export function clearFileCache(): void {
  _fileCache.clear();
  _savedMtimes.clear();
  _restoredScopes.clear();
}

/** Where a scope's open tabs are saved. The project root keeps the original key. */
export function tabStateKey(scopeKey: string | null): string {
  return scopeKey ? `files:tabState:${scopeKey}` : 'files:tabState';
}

function isMac(): boolean {
  return typeof window !== 'undefined' && window.clubhouse?.platform === 'darwin';
}

/** The platform's name for revealing a file in the system file manager. */
export function revealLabel(): string {
  return isMac() ? 'Open in Finder' : 'Show in folder';
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
    className: 'absolute inset-0 z-dropdown-backdrop flex items-center justify-center bg-black/60 backdrop-blur-sm',
  },
    React.createElement('div', {
      className: 'bg-ctp-mantle border border-surface-1 rounded-xl shadow-2xl w-[360px] flex flex-col',
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    },
      // Header
      React.createElement('div', { className: 'px-4 py-3 border-b border-surface-0' },
        React.createElement('h3', { className: 'text-sm font-semibold text-ctp-text' }, 'Unsaved Changes'),
        React.createElement('p', { className: 'text-xs text-ctp-subtext0 mt-1' },
          `"${fileName}" has unsaved changes.`,
        ),
      ),
      // Actions
      React.createElement('div', { className: 'flex items-center justify-end gap-2 px-4 py-3' },
        React.createElement('button', {
          className: 'px-3 py-1.5 text-xs rounded-lg text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 cursor-pointer transition-colors',
          onClick: onCancel,
        }, 'Cancel'),
        React.createElement('button', {
          className: 'px-3 py-1.5 text-xs rounded-lg text-ctp-red hover:bg-surface-0 cursor-pointer transition-colors',
          onClick: onDiscard,
        }, 'Discard'),
        React.createElement('button', {
          className: 'px-4 py-1.5 text-xs rounded-lg bg-ctp-accent text-ctp-base hover:opacity-90 cursor-pointer transition-colors font-medium',
          onClick: onSave,
        }, 'Save'),
      ),
    ),
  );
}

// ── Open in Finder button ─────────────────────────────────────────────

function OpenInFinderButton({ api, relativePath }: { api: PluginAPI; relativePath: string }) {
  return React.createElement('button', {
    type: 'button',
    className: 'h-7 px-2.5 text-xs bg-surface-0 text-ctp-text rounded-md hover:bg-surface-1 transition-colors focus-ring',
    onClick: () => api.files.showInFolder(relativePath),
  }, revealLabel());
}

// ── Strip menu ────────────────────────────────────────────────────────

const MoreIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor',
},
  React.createElement('circle', { cx: 5, cy: 12, r: 1.6 }),
  React.createElement('circle', { cx: 12, cy: 12, r: 1.6 }),
  React.createElement('circle', { cx: 19, cy: 12, r: 1.6 }),
);

function FileMenuButton({ items }: { items: MenuItem[] }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      ref,
      type: 'button',
      className: 'w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-md text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0 transition-colors focus-ring',
      title: 'File actions',
      'aria-label': 'File actions',
      'aria-haspopup': 'menu',
      'aria-expanded': position !== null,
      'data-testid': 'files-file-menu-btn',
      onClick: () => {
        const r = ref.current?.getBoundingClientRect();
        setPosition(position ? null : { x: (r?.right ?? 0) - 180, y: (r?.bottom ?? 0) + 4 });
      },
    }, MoreIcon),
    position
      ? React.createElement(PopupMenu, {
          items,
          position,
          label: 'File actions',
          testId: 'files-file-menu',
          onClose: () => { setPosition(null); ref.current?.focus(); },
        })
      : null,
  );
}

// ── FileViewer (MainPanel) ────────────────────────────────────────────

export function FileViewer({ api: rawApi }: { api: PluginAPI }) {
  // New chrome: files and saved tabs follow the sidebar selection (spec §4.5).
  const { api, key: scopeKey, root: scopeRoot } = useFilesScope(rawApi);
  const [activeTab, setActiveTab] = useState<Tab | undefined>(fileState.getActiveTab());
  const [loadedFile, setLoadedFile] = useState<LoadedFile | null>(null);
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>('preview');
  const [loading, setLoading] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<{ tabId: string; pendingAction: () => void } | null>(null);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorColumn, setCursorColumn] = useState(1);

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
    const cached = _fileCache.get(relativePath);
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

    _fileCache.set(relativePath, result);
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

  // ── Tabs per scope ────────────────────────────────────────────────

  // Switch to this scope's tabs, reading its saved ones back the first time.
  // Saving waits until the read is done so an empty set never overwrites them.
  useEffect(() => {
    if (fileState.scopeKey !== scopeKey) {
      // A worktree outside the project reuses the root's relative paths: drop
      // cached content so nothing from the other checkout is shown.
      _fileCache.clear();
      disposeCleanModels();
    }
    fileState.setScope(scopeKey);
    if (_restoredScopes.has(scopeKey)) return;
    let cancelled = false;
    async function restore() {
      try {
        const raw = await api.storage.project.read(tabStateKey(scopeKey));
        if (cancelled || fileState.scopeKey !== scopeKey) return;
        if (raw && typeof raw === 'string') {
          const data = JSON.parse(raw);
          if (data && data.tabs && Array.isArray(data.tabs)) {
            _restoredScopes.add(scopeKey);
            fileState.restore(data);
            return;
          }
        }
      } catch {
        // Fresh start — no persisted tabs
      }
      if (!cancelled) _restoredScopes.add(scopeKey);
    }
    restore();
    return () => { cancelled = true; };
  }, [api, scopeKey]);

  useEffect(() => {
    const persist = () => {
      const key = fileState.scopeKey;
      if (!_restoredScopes.has(key)) return;
      const data = fileState.serialize();
      api.storage.project.write(tabStateKey(key), JSON.stringify(data)).catch(() => {});
    };

    return fileState.subscribe(persist);
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
          _fileCache.delete(tab.filePath);
          fileState.closeTab(tabId);
        },
      });
      return;
    }

    disposeModel(tab.filePath);
    _fileCache.delete(tab.filePath);
    fileState.closeTab(tabId);
  }, []);

  // ── Save file ─────────────────────────────────────────────────────

  // Record mtime so the file watcher can distinguish our write from external changes.
  // Best-effort: a failed stat after a successful write must not fail the save.
  const recordSavedMtime = useCallback(async (filePath: string) => {
    try {
      const stat = await api.files.stat(filePath);
      _savedMtimes.set(filePath, stat.modifiedAt);
    } catch {
      _savedMtimes.delete(filePath);
    }
  }, [api]);

  /** Write the editor content to disk. Returns false (and surfaces the error) on failure. */
  const saveFile = useCallback(async (filePath: string): Promise<boolean> => {
    const content = getModelContent(filePath);
    if (content === null) {
      api.ui.showError('Failed to save: editor content is unavailable');
      return false;
    }
    try {
      await api.files.writeFile(filePath, content);
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
      return false;
    }
    await recordSavedMtime(filePath);
    updateSavedContent(filePath, content);
    const tab = fileState.getTabByPath(filePath);
    if (tab) {
      fileState.setTabDirty(tab.id, false);
    }
    fileState.triggerRefresh();
    return true;
  }, [api, recordSavedMtime]);

  // ── Dirty change handler ──────────────────────────────────────────

  const handleDirtyChange = useCallback((dirty: boolean) => {
    if (!activeTab) return;
    fileState.setTabDirty(activeTab.id, dirty);
  }, [activeTab?.id]);

  // ── Save from Monaco (Cmd+S) ─────────────────────────────────────

  // Resolves false on failure so MonacoEditor keeps the draft dirty.
  const handleSave = useCallback(async (newContent: string): Promise<boolean> => {
    if (!activeTab) return false;
    try {
      await api.files.writeFile(activeTab.filePath, newContent);
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
      return false;
    }
    await recordSavedMtime(activeTab.filePath);
    updateSavedContent(activeTab.filePath, newContent);
    fileState.setTabDirty(activeTab.id, false);
    fileState.triggerRefresh();
    // Update cache
    const cached = _fileCache.get(activeTab.filePath);
    if (cached) {
      cached.content = newContent;
    }
    return true;
  }, [api, recordSavedMtime, activeTab?.id, activeTab?.filePath]);

  // ── Scroll state handler ──────────────────────────────────────────

  const handleScrollStateChange = useCallback((scrollState: ScrollState) => {
    if (!activeTab) return;
    fileState.setTabScrollState(activeTab.id, scrollState);
  }, [activeTab?.id]);

  // ── Cursor change handler (status bar) ────────────────────────────

  const handleCursorChange = useCallback((line: number, column: number) => {
    setCursorLine(line);
    setCursorColumn(column);
  }, []);

  // ── External change detection ─────────────────────────────────────
  // Watch open tabs for changes made by agents or collaborators after a save.
  // When a change originates externally, update Monaco's saved baseline so the
  // dirty indicator reflects whether the editor content matches the new disk state.

  useEffect(() => {
    const disposable = api.files.watch('**/*', async (events) => {
      for (const evt of events) {
        if (evt.type !== 'modified') continue;
        const tab = fileState.getTabByPath(evt.path);
        if (!tab) continue;

        try {
          const stat = await api.files.stat(evt.path);
          const knownMtime = _savedMtimes.get(evt.path);
          // If mtime matches our last save, this is our own write — skip
          if (knownMtime !== undefined && stat.modifiedAt === knownMtime) continue;

          // External change: reload content and update Monaco's saved baseline
          const cached = _fileCache.get(evt.path);
          if (!cached || (cached.fileType !== 'text' && cached.fileType !== 'markdown')) continue;

          // Unsaved edits now sit on top of a file that changed on disk.
          if (tab.isDirty) tel.event('clubhouse.editor.save_conflict');

          const newContent = await api.files.readFile(evt.path);
          cached.content = newContent;
          _savedMtimes.set(evt.path, stat.modifiedAt);
          updateSavedContent(evt.path, newContent);
          // Monaco now shows dirty only when editor content differs from newContent
        } catch {
          // File may have been deleted or be temporarily unreadable
        }
      }
    });
    return () => disposable.dispose();
  }, [api]);

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
    const saved = tab ? await saveFile(tab.filePath) : true;
    const action = unsavedDialog.pendingAction;
    setUnsavedDialog(null);
    // A failed save keeps the tab open and dirty — closing would discard the draft
    if (saved) action();
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
        className: 'flex flex-col items-center justify-center flex-1 text-ctp-overlay1',
      },
        React.createElement('svg', {
          width: 40, height: 40, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
          className: 'mb-3 opacity-50',
        },
          React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
          React.createElement('polyline', { points: '14 2 14 8 20 8' }),
        ),
        React.createElement('p', { className: 'text-[13px] text-ctp-text' }, 'Select a file to view'),
        React.createElement('p', { className: 'text-xs mt-1' }, 'Click a file in the sidebar'),
      ),
    );
  }

  if (loading) {
    return React.createElement('div', {
      className: 'flex flex-col h-full bg-ctp-base',
    },
      React.createElement(TabBar, { api, onCloseTab: handleCloseTab, onRevealInTree: handleRevealInTree }),
      React.createElement('div', {
        className: 'flex items-center justify-center flex-1 text-ctp-overlay1 text-xs',
      }, 'Loading'),
    );
  }

  const fileName = getFileName(activeTab.filePath);
  const ext = getExtension(activeTab.filePath);
  const lang = getLanguage(ext);

  // True when the Monaco editor is the active view (drives the cursor position)
  const isEditorVisible = loadedFile.fileType === 'text' ||
    ((loadedFile.fileType === 'markdown' || loadedFile.fileType === 'svg') && previewMode === 'source');

  // The path below the tree's root: a worktree's files without its folder prefix.
  const displayPath = scopeRoot && scopeRoot !== '.' && activeTab.filePath.startsWith(`${scopeRoot}/`)
    ? activeTab.filePath.slice(scopeRoot.length + 1)
    : activeTab.filePath;

  const segment = (mode: 'preview' | 'source', label: string) => React.createElement('button', {
    type: 'button',
    className: `h-6 px-2 rounded text-xs transition-colors ${previewMode === mode ? 'bg-surface-1 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'}`,
    'aria-pressed': previewMode === mode,
    onClick: () => setPreviewMode(mode),
  }, label);

  const divider = React.createElement('span', { className: 'w-px h-3.5 bg-surface-1 flex-shrink-0', 'aria-hidden': true });

  // Right side of the tab strip: what the breadcrumb can't show
  const trailing = React.createElement(React.Fragment, null,
    (loadedFile.fileType === 'markdown' || loadedFile.fileType === 'svg')
      ? React.createElement('div', { className: 'flex items-center gap-0.5 p-0.5 rounded-md bg-surface-0 flex-shrink-0' },
          segment('preview', 'Preview'),
          segment('source', 'Source'),
        )
      : null,
    React.createElement('span', {
      className: 'font-mono text-[11.5px] truncate min-w-0',
      title: activeTab.filePath,
      'data-testid': 'files-active-path',
    }, displayPath),
    isEditorVisible ? divider : null,
    isEditorVisible
      ? React.createElement('span', { className: 'flex-shrink-0 whitespace-nowrap', 'data-testid': 'files-cursor' }, `Ln ${cursorLine}, Col ${cursorColumn}`)
      : null,
    React.createElement(FileMenuButton, {
      items: [
        { id: 'reveal-os', label: revealLabel(), onSelect: () => { api.files.showInFolder(activeTab.filePath).catch(() => {}); } },
        { id: 'copy-path', label: 'Copy path', onSelect: () => { navigator.clipboard.writeText(activeTab.filePath).catch(() => {}); } },
        { id: 'reveal-tree', label: 'Reveal in file tree', onSelect: () => handleRevealInTree(activeTab.filePath) },
      ],
    }),
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
            onCursorChange: handleCursorChange,
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
            onCursorChange: handleCursorChange,
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
          onCursorChange: handleCursorChange,
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
    React.createElement(TabBar, { api, onCloseTab: handleCloseTab, onRevealInTree: handleRevealInTree, trailing }),
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
