import React, { useRef, useEffect } from 'react';

export interface HubTabContextMenuProps {
  x: number;
  y: number;
  hubId: string;
  onUpgradeToCanvas?: (hubId: string) => void;
  onDuplicate: (hubId: string) => void;
  onClose: () => void;
}

export function HubTabContextMenu({
  x,
  y,
  hubId,
  onUpgradeToCanvas,
  onDuplicate,
  onClose,
}: HubTabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menuRef.current.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menuRef.current.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  }, []);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-ctp-mantle border border-surface-0 rounded-lg shadow-2xl py-1 min-w-[180px] text-[11px]"
      style={{ left: x, top: y }}
      data-testid="hub-tab-context-menu"
    >
      {onUpgradeToCanvas && (
        <>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-surface-1 text-ctp-text transition-colors flex items-center gap-2"
            onClick={() => { onUpgradeToCanvas(hubId); onClose(); }}
            data-testid="hub-ctx-upgrade-to-canvas"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="1" width="14" height="14" rx="2" />
              <line x1="5" y1="1" x2="5" y2="15" />
              <line x1="1" y1="5" x2="15" y2="5" />
            </svg>
            Upgrade to Canvas
          </button>
          <div className="border-t border-surface-0 my-1" />
        </>
      )}
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-surface-1 text-ctp-text transition-colors flex items-center gap-2"
        onClick={() => { onDuplicate(hubId); onClose(); }}
        data-testid="hub-ctx-duplicate"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="10" height="10" rx="1" />
          <path d="M3 11V2a1 1 0 011-1h9" />
        </svg>
        Duplicate
      </button>
    </div>
  );
}
