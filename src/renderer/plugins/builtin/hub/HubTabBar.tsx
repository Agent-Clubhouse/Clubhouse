import React, { useCallback, useState, useRef, useEffect } from 'react';
import type { HubInstance } from './useHubStore';

interface HubTabBarProps {
  hubs: HubInstance[];
  activeHubId: string;
  onSelectHub: (hubId: string) => void;
  onAddHub: () => void;
  onRemoveHub: (hubId: string) => void;
  onRenameHub: (hubId: string, name: string) => void;
  onPopOutHub: (hubId: string, hubName: string) => void;
}

export function HubTabBar({
  hubs,
  activeHubId,
  onSelectHub,
  onAddHub,
  onRemoveHub,
  onRenameHub,
  onPopOutHub,
}: HubTabBarProps) {
  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1 bg-ctp-mantle border-b border-surface-0 min-h-[32px] overflow-x-auto flex-shrink-0" data-testid="hub-tab-bar">
      {hubs.map((hub) => (
        <HubTab
          key={hub.id}
          hub={hub}
          active={hub.id === activeHubId}
          canClose={hubs.length > 1}
          onSelect={() => onSelectHub(hub.id)}
          onRemove={() => onRemoveHub(hub.id)}
          onRename={(name) => onRenameHub(hub.id, name)}
          onPopOut={() => onPopOutHub(hub.id, hub.name)}
        />
      ))}
      <button
        onClick={onAddHub}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors text-sm"
        title="New hub"
        data-testid="hub-add-button"
      >
        +
      </button>
    </div>
  );
}

// ── Individual tab ─────────────────────────────────────────────────────

interface HubTabProps {
  hub: HubInstance;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  onPopOut: () => void;
}

function HubTab({ hub, active, canClose, onSelect, onRemove, onRename, onPopOut }: HubTabProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(hub.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(hub.name);
    setEditing(true);
  }, [hub.name]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== hub.name) {
      onRename(trimmed);
    }
    setEditing(false);
  }, [editValue, hub.name, onRename]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitRename();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  }, [commitRename]);

  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={`
        group relative flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] cursor-pointer select-none
        transition-colors duration-100 flex-shrink-0 max-w-[200px]
        ${active
          ? 'bg-surface-1 text-ctp-text shadow-sm'
          : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text'
        }
      `}
      onClick={onSelect}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid={`hub-tab-${hub.id}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
          className="bg-transparent border-none outline-none text-[11px] text-ctp-text w-full min-w-[40px] px-0"
          data-testid="hub-tab-rename-input"
        />
      ) : (
        <span className="truncate">{hub.name}</span>
      )}

      {/* Action buttons — visible on hover or when active */}
      {!editing && (active || hovered) && (
        <div className="flex items-center gap-0.5 ml-0.5 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onPopOut(); }}
            className="w-4 h-4 flex items-center justify-center rounded text-[9px] text-ctp-overlay0 hover:bg-surface-2 hover:text-ctp-text"
            title="Pop out hub"
            data-testid="hub-tab-popout"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 2 14 2 14 7" />
              <line x1="14" y1="2" x2="7" y2="9" />
              <path d="M12 9v5a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h5" />
            </svg>
          </button>
          {canClose && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="w-4 h-4 flex items-center justify-center rounded text-[9px] text-ctp-overlay0 hover:bg-red-500/20 hover:text-red-400"
              title="Close hub"
              data-testid="hub-tab-close"
            >
              &times;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
