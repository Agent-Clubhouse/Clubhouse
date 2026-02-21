import { useCallback, useRef, useState } from 'react';

interface ResizeDividerProps {
  onResize: (delta: number) => void;
  onToggleCollapse: () => void;
  collapsed: boolean;
  collapseDirection: 'left' | 'right';
}

export function ResizeDivider({ onResize, onToggleCollapse, collapsed, collapseDirection }: ResizeDividerProps) {
  const [hovered, setHovered] = useState(false);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startXRef.current;
      if (delta !== 0) {
        onResize(delta);
        startXRef.current = ev.clientX;
      }
    };

    const handleMouseUp = () => {
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onResize]);

  const handleDoubleClick = useCallback(() => {
    onToggleCollapse();
  }, [onToggleCollapse]);

  const chevron = collapseDirection === 'left'
    ? (collapsed ? '\u25B6' : '\u25C0')
    : (collapsed ? '\u25C0' : '\u25B6');

  return (
    <div
      className="relative flex-shrink-0 group"
      style={{ width: 5, cursor: 'col-resize' }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid="resize-divider"
    >
      {/* Visible line */}
      <div
        className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 transition-colors duration-100"
        style={{
          width: 1,
          backgroundColor: hovered ? 'rgb(var(--ctp-accent) / 0.6)' : 'rgb(var(--ctp-surface2) / 1)',
        }}
      />
      {/* Collapse chevron button */}
      {hovered && (
        <button
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10
            w-4 h-4 rounded-full bg-ctp-mantle border border-surface-2
            flex items-center justify-center text-[8px] text-ctp-subtext0
            hover:bg-surface-1 hover:text-ctp-text transition-colors"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          data-testid="collapse-button"
        >
          {chevron}
        </button>
      )}
    </div>
  );
}
