import { useEffect, useState, useCallback, useRef } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { MonacoCodeEditor } from './MonacoEditor';
import { MarkdownPreview } from './MarkdownPreview';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
const BINARY_EXTS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'gz', 'tar', 'pdf', 'exe', 'dmg', 'so', 'dylib', 'node']);
const MARKDOWN_EXTS = new Set(['md', 'mdx']);

function getExt(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

type ViewMode = 'preview' | 'source';

export function FileViewer() {
  const { selectedFilePath } = useUIStore();
  const [content, setContent] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [isDirty, setIsDirty] = useState(false);

  // Track the "active" file path to gate unsaved-changes prompts
  const activeFilePathRef = useRef<string | null>(null);

  const ext = selectedFilePath ? getExt(selectedFilePath) : '';
  const fileName = selectedFilePath?.split('/').pop() || '';
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);
  const isSvg = ext === 'svg';
  const _hasToggle = isMarkdown || isSvg;

  // Unsaved-changes guard when switching files
  useEffect(() => {
    const prev = activeFilePathRef.current;
    if (prev && prev !== selectedFilePath && isDirty) {
      const discard = window.confirm(
        'You have unsaved changes. Discard them and switch files?'
      );
      if (!discard) {
        // Restore the previous selection
        useUIStore.getState().setSelectedFilePath(prev);
        return;
      }
    }
    activeFilePathRef.current = selectedFilePath;
    setIsDirty(false);
    setViewMode('preview');
  }, [selectedFilePath]);

  // Load file content
  useEffect(() => {
    if (!selectedFilePath) return;
    setContent(null);
    setImageDataUrl(null);
    setError(null);

    if (BINARY_EXTS.has(ext)) {
      setError('Binary file — cannot display');
      return;
    }

    // For images (including SVG), load as base64 data URL
    if (isImage) {
      setLoading(true);
      window.clubhouse.file.readBinary(selectedFilePath)
        .then((dataUrl: string) => {
          setImageDataUrl(dataUrl);
          setLoading(false);
        })
        .catch((err: Error) => {
          setError(err.message);
          setLoading(false);
        });
      // For SVG, also load text content for source view
      if (isSvg) {
        window.clubhouse.file.read(selectedFilePath)
          .then((text: string) => setContent(text))
          .catch(() => { /* image view still works */ });
      }
      return;
    }

    setLoading(true);
    window.clubhouse.file.read(selectedFilePath)
      .then((text: string) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [selectedFilePath, ext, isImage, isSvg]);

  const handleSave = useCallback(
    async (newContent: string) => {
      if (!selectedFilePath) return;
      try {
        await window.clubhouse.file.write(selectedFilePath, newContent);
        setContent(newContent);
      } catch (err: any) {
        console.error('Failed to save file:', err);
      }
    },
    [selectedFilePath]
  );

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
  }, []);

  if (!selectedFilePath) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <div className="text-center text-ctp-subtext0">
          <p className="text-lg mb-2">No file selected</p>
          <p className="text-sm">Select a file from the tree to view it</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-sm">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-sm">Loading...</p>
      </div>
    );
  }

  // SVG file
  if (isSvg && imageDataUrl) {
    return (
      <div className="h-full bg-ctp-base flex flex-col">
        <FileHeader
          name={fileName}
          path={selectedFilePath}
          lang="svg"
          isDirty={isDirty}
          toggle={<ViewToggle mode={viewMode} onChange={setViewMode} />}
        />
        {viewMode === 'preview' ? (
          <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
            <img src={imageDataUrl} alt={fileName} className="max-w-full max-h-full object-contain rounded" />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            <MonacoCodeEditor
              key={selectedFilePath}
              filePath={selectedFilePath}
              initialContent={content || ''}
              onDirtyChange={handleDirtyChange}
              onSave={handleSave}
            />
          </div>
        )}
      </div>
    );
  }

  // Image viewer (non-SVG)
  if (isImage && imageDataUrl) {
    return (
      <div className="h-full bg-ctp-base flex flex-col">
        <FileHeader name={fileName} path={selectedFilePath} lang="" isDirty={false} />
        <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
          <img src={imageDataUrl} alt={fileName} className="max-w-full max-h-full object-contain rounded" />
        </div>
      </div>
    );
  }

  if (content === null) return null;

  // Markdown file with preview/source toggle
  if (isMarkdown) {
    return (
      <div className="h-full bg-ctp-base flex flex-col">
        <FileHeader
          name={fileName}
          path={selectedFilePath}
          lang="markdown"
          isDirty={isDirty}
          toggle={<ViewToggle mode={viewMode} onChange={setViewMode} />}
        />
        {viewMode === 'preview' ? (
          <div className="flex-1 overflow-auto p-6">
            <MarkdownPreview content={content} />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            <MonacoCodeEditor
              key={selectedFilePath}
              filePath={selectedFilePath}
              initialContent={content}
              onDirtyChange={handleDirtyChange}
              onSave={handleSave}
            />
          </div>
        )}
      </div>
    );
  }

  // Source code — Monaco editor
  const lang = getExt(selectedFilePath);

  return (
    <div className="h-full bg-ctp-base flex flex-col">
      <FileHeader name={fileName} path={selectedFilePath} lang={lang || ext} isDirty={isDirty} />
      <div className="flex-1 overflow-hidden">
        <MonacoCodeEditor
          key={selectedFilePath}
          filePath={selectedFilePath}
          initialContent={content}
          onDirtyChange={handleDirtyChange}
          onSave={handleSave}
        />
      </div>
    </div>
  );
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="flex rounded overflow-hidden border border-surface-0 text-xs">
      <button
        className={`px-2.5 py-0.5 transition-colors ${
          mode === 'preview'
            ? 'bg-ctp-surface0 text-ctp-text'
            : 'bg-transparent text-ctp-subtext0 hover:text-ctp-text'
        }`}
        onClick={() => onChange('preview')}
      >
        Preview
      </button>
      <button
        className={`px-2.5 py-0.5 transition-colors ${
          mode === 'source'
            ? 'bg-ctp-surface0 text-ctp-text'
            : 'bg-transparent text-ctp-subtext0 hover:text-ctp-text'
        }`}
        onClick={() => onChange('source')}
      >
        Source
      </button>
    </div>
  );
}

function FileHeader({
  name,
  path,
  lang,
  isDirty,
  toggle,
}: {
  name: string;
  path: string;
  lang: string;
  isDirty: boolean;
  toggle?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-0 bg-ctp-mantle flex-shrink-0">
      <span className="text-sm font-medium text-ctp-text">{name}</span>
      {isDirty && (
        <span
          className="w-2 h-2 rounded-full bg-ctp-peach flex-shrink-0"
          title="Unsaved changes"
        />
      )}
      {lang && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0">{lang}</span>
      )}
      {toggle}
      <span className="text-xs text-ctp-subtext0 truncate ml-auto">{path}</span>
      <button
        onClick={() => window.clubhouse.file.showInFolder(path)}
        className="flex-shrink-0 p-1 rounded hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
        title="Show in Finder"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <polyline points="9 14 12 11 15 14" />
        </svg>
      </button>
    </div>
  );
}
