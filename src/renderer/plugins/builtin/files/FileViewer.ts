import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { fileState } from './state';
import { MonacoEditor } from './MonacoEditor';
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
  const [selectedPath, setSelectedPath] = useState<string | null>(fileState.selectedPath);
  const [content, setContent] = useState<string>('');
  const [binaryData, setBinaryData] = useState<string>('');
  const [fileType, setFileType] = useState<'text' | 'binary' | 'image' | 'svg' | 'markdown' | 'none' | 'too-large'>('none');
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>('preview');
  const [isDirty, setIsDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<{ pendingPath: string } | null>(null);

  const contentRef = useRef(content);
  contentRef.current = content;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  // Load file content
  const loadFile = useCallback(async (relativePath: string) => {
    setLoading(true);
    const ext = getExtension(relativePath);
    const fileName = getFileName(relativePath);

    try {
      // Binary check
      if (BINARY_EXTENSIONS.has(ext)) {
        setFileType('binary');
        setContent('');
        setBinaryData('');
        setLoading(false);
        return;
      }

      // Image check
      if (IMAGE_EXTENSIONS.has(ext)) {
        const stat = await api.files.stat(relativePath);
        if (stat.size > MAX_IMAGE_SIZE) {
          setFileType('too-large');
          setContent('');
          setBinaryData('');
          setLoading(false);
          return;
        }
        const data = await api.files.readBinary(relativePath);
        setBinaryData(data);
        setContent('');
        setFileType('image');
        setLoading(false);
        return;
      }

      // SVG
      if (ext === 'svg') {
        const text = await api.files.readFile(relativePath);
        setContent(text);
        setFileType('svg');
        // Generate base64 for preview
        const b64 = btoa(unescape(encodeURIComponent(text)));
        setBinaryData(`data:image/svg+xml;base64,${b64}`);
        setPreviewMode('preview');
        setLoading(false);
        return;
      }

      // Markdown
      if (ext === 'md' || ext === 'mdx') {
        const text = await api.files.readFile(relativePath);
        setContent(text);
        setFileType('markdown');
        setBinaryData('');
        setPreviewMode('preview');
        setLoading(false);
        return;
      }

      // Text file — size check
      const stat = await api.files.stat(relativePath);
      if (stat.size > MAX_TEXT_SIZE) {
        setFileType('too-large');
        setContent('');
        setBinaryData('');
        setLoading(false);
        return;
      }

      const text = await api.files.readFile(relativePath);
      setContent(text);
      setBinaryData('');
      setFileType('text');
    } catch {
      setContent('');
      setFileType('none');
    }

    setLoading(false);
  }, [api]);

  // Handle file selection with unsaved changes check
  const switchToFile = useCallback((newPath: string | null) => {
    if (!newPath) {
      setSelectedPath(null);
      setFileType('none');
      return;
    }

    if (isDirtyRef.current && selectedPathRef.current) {
      setUnsavedDialog({ pendingPath: newPath });
      return;
    }

    setSelectedPath(newPath);
    selectedPathRef.current = newPath;
    setIsDirty(false);
    fileState.setDirty(false);
    loadFile(newPath);
  }, [loadFile]);

  // Subscribe to fileState changes
  useEffect(() => {
    return fileState.subscribe(() => {
      const newPath = fileState.selectedPath;
      if (newPath !== selectedPathRef.current) {
        switchToFile(newPath);
      }
    });
  }, [switchToFile]);

  // Save file
  const saveFile = useCallback(async () => {
    if (!selectedPath) return;
    try {
      await api.files.writeFile(selectedPath, contentRef.current);
      setIsDirty(false);
      fileState.setDirty(false);
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
    }
  }, [api, selectedPath]);

  // Handle dirty change from Monaco
  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
    fileState.setDirty(dirty);
  }, []);

  // Handle save from Monaco (Cmd+S)
  const handleSave = useCallback(async (newContent: string) => {
    if (!selectedPath) return;
    try {
      setContent(newContent);
      await api.files.writeFile(selectedPath, newContent);
      setIsDirty(false);
      fileState.setDirty(false);
    } catch (err) {
      api.ui.showError(`Failed to save: ${err}`);
    }
  }, [api, selectedPath]);

  // Unsaved dialog handlers
  const handleDialogSave = useCallback(async () => {
    if (!unsavedDialog) return;
    await saveFile();
    const pendingPath = unsavedDialog.pendingPath;
    setUnsavedDialog(null);
    setSelectedPath(pendingPath);
    setIsDirty(false);
    fileState.setDirty(false);
    loadFile(pendingPath);
  }, [unsavedDialog, saveFile, loadFile]);

  const handleDialogDiscard = useCallback(() => {
    if (!unsavedDialog) return;
    const pendingPath = unsavedDialog.pendingPath;
    setUnsavedDialog(null);
    setSelectedPath(pendingPath);
    setIsDirty(false);
    fileState.setDirty(false);
    loadFile(pendingPath);
  }, [unsavedDialog, loadFile]);

  const handleDialogCancel = useCallback(() => {
    setUnsavedDialog(null);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────

  if (!selectedPath || fileType === 'none') {
    return React.createElement('div', {
      className: 'flex flex-col items-center justify-center h-full text-ctp-subtext0',
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
    );
  }

  if (loading) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Loading...');
  }

  const fileName = getFileName(selectedPath);
  const ext = getExtension(selectedPath);
  const lang = getLanguage(ext);

  // File header
  const header = React.createElement('div', {
    className: 'flex items-center justify-between px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
  },
    React.createElement('div', { className: 'flex items-center gap-2 min-w-0' },
      React.createElement('span', { className: 'text-xs font-medium text-ctp-text truncate' }, fileName),
      isDirty
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
      (fileType === 'markdown' || fileType === 'svg')
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
        title: selectedPath,
      }, selectedPath),
      React.createElement(OpenInFinderButton, { api, relativePath: selectedPath }),
    ),
  );

  let body: React.ReactElement;

  switch (fileType) {
    case 'binary':
      body = React.createElement('div', {
        className: 'flex flex-col items-center justify-center h-full text-ctp-subtext0 gap-3',
      },
        React.createElement('p', { className: 'text-xs' }, 'Cannot display binary file'),
        React.createElement(OpenInFinderButton, { api, relativePath: selectedPath }),
      );
      break;

    case 'too-large':
      body = React.createElement('div', {
        className: 'flex flex-col items-center justify-center h-full text-ctp-subtext0 gap-3',
      },
        React.createElement('p', { className: 'text-xs' }, 'File too large to display'),
        React.createElement(OpenInFinderButton, { api, relativePath: selectedPath }),
      );
      break;

    case 'image':
      body = React.createElement('div', {
        className: 'flex items-center justify-center h-full p-4 overflow-auto',
      },
        React.createElement('img', {
          src: binaryData,
          alt: fileName,
          className: 'max-w-full max-h-full object-contain',
        }),
      );
      break;

    case 'svg':
      if (previewMode === 'preview') {
        body = React.createElement('div', {
          className: 'flex items-center justify-center h-full p-4 overflow-auto',
        },
          React.createElement('img', {
            src: binaryData,
            alt: fileName,
            className: 'max-w-full max-h-full object-contain',
          }),
        );
      } else {
        body = React.createElement('div', { className: 'flex-1 min-h-0' },
          React.createElement(MonacoEditor, {
            value: content,
            language: 'xml',
            onSave: handleSave,
            onDirtyChange: handleDirtyChange,
            filePath: selectedPath,
          }),
        );
      }
      break;

    case 'markdown':
      if (previewMode === 'preview') {
        body = React.createElement('div', { className: 'flex-1 min-h-0 overflow-auto' },
          React.createElement(MarkdownPreview, { content }),
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
      break;

    default: // text
      body = React.createElement('div', { className: 'flex-1 min-h-0' },
        React.createElement(MonacoEditor, {
          value: content,
          language: lang,
          onSave: handleSave,
          onDirtyChange: handleDirtyChange,
          filePath: selectedPath,
        }),
      );
      break;
  }

  return React.createElement('div', {
    className: 'flex flex-col h-full bg-ctp-base relative',
  },
    header,
    body,
    // Unsaved changes dialog
    unsavedDialog
      ? React.createElement(UnsavedDialog, {
          fileName,
          onSave: handleDialogSave,
          onDiscard: handleDialogDiscard,
          onCancel: handleDialogCancel,
        })
      : null,
  );
}
