import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule, AgentInfo } from '../../../../shared/plugin-types';
import { createLoungeStore, groupAgentsByCategory, disambiguateAgentName, isDefaultCircle, isReservedCircleName, isDuplicateCircleName, getPersistedState, DEFAULT_CUSTOM_EMOJI } from './state';
import type { LoungeCategory, LoungePersistedState } from './state';

const useLoungeStore = createLoungeStore();

const STORAGE_KEY = 'lounge-state';

export function activate(ctx: PluginContext, _api: PluginAPI): void {
  // No commands to register yet — reserved for future keybindings
  void ctx;
}

export function deactivate(): void {
  // subscriptions auto-disposed
}

// ── Status helpers ─────────────────────────────────────────────────────

function statusColor(status: AgentInfo['status']): string {
  switch (status) {
    case 'running': return 'bg-ctp-green';
    case 'sleeping': return 'bg-ctp-yellow';
    case 'error': return 'bg-ctp-red';
    case 'creating': return 'bg-ctp-blue';
    default: return 'bg-ctp-overlay0';
  }
}

function statusLabel(status: AgentInfo['status']): string {
  switch (status) {
    case 'running': return 'Running';
    case 'sleeping': return 'Sleeping';
    case 'error': return 'Error';
    case 'creating': return 'Creating';
    default: return status;
  }
}

// ── Agent Row ──────────────────────────────────────────────────────────

function AgentRow({ agent, displayName, isSelected, onClick, onContextMenu }: {
  agent: AgentInfo;
  displayName: string;
  isSelected: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-lounge-agent', agent.id);
    e.dataTransfer.effectAllowed = 'move';
  }, [agent.id]);

  return React.createElement('button', {
    key: agent.id,
    onClick,
    onContextMenu,
    draggable: true,
    onDragStart: handleDragStart,
    title: `${displayName} — ${statusLabel(agent.status)}`,
    'data-testid': `lounge-agent-${agent.id}`,
    className: `w-full text-left px-3 py-2 text-sm cursor-pointer transition-colors flex items-center gap-3 ${
      isSelected
        ? 'bg-surface-1 text-ctp-text'
        : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
    }`,
  },
    React.createElement('span', {
      className: `w-2 h-2 rounded-full flex-shrink-0 ${statusColor(agent.status)}`,
    }),
    React.createElement('span', { className: 'truncate flex-1' }, displayName),
    agent.status === 'running' && React.createElement('span', {
      className: 'text-[10px] text-ctp-green flex-shrink-0',
    }, '●'),
  );
}

// ── Category Context Menu ───────────────────────────────────────────────

function CategoryContextMenu({ position, categoryId, onRename, onDelete, onClose }: {
  position: { x: number; y: number };
  categoryId: string;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isCustomCircle = categoryId.startsWith('circle:') && !isDefaultCircle(categoryId);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const style = useMemo(() => {
    const menuWidth = 160;
    const menuHeight = (isCustomCircle ? 64 : 32) + 8;
    const x = Math.min(position.x, window.innerWidth - menuWidth - 8);
    const y = Math.min(position.y, window.innerHeight - menuHeight - 8);
    return { left: x, top: y };
  }, [position, isCustomCircle]);

  return React.createElement('div', {
    ref: menuRef,
    className: 'fixed z-50 min-w-[160px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle',
    style,
    'data-testid': 'lounge-category-context-menu',
  },
    React.createElement('button', {
      className: 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors cursor-pointer',
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); onRename(); onClose(); },
      'data-testid': 'lounge-ctx-rename',
    },
      React.createElement('svg', {
        width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        React.createElement('path', { d: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' }),
      ),
      React.createElement('span', null, 'Rename'),
    ),
    // Delete option — only for custom circles (not project-derived)
    isCustomCircle && React.createElement('button', {
      className: 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ctp-red hover:bg-surface-1 transition-colors cursor-pointer',
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); onDelete(); onClose(); },
      'data-testid': 'lounge-ctx-delete',
    },
      React.createElement('svg', {
        width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        React.createElement('polyline', { points: '3 6 5 6 21 6' }),
        React.createElement('path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
      ),
      React.createElement('span', null, 'Delete'),
    ),
  );
}

// ── Agent Context Menu ──────────────────────────────────────────────────

function AgentContextMenu({ position, categories, currentCategoryId, onMoveTo, onCreateCircle, onClose }: {
  position: { x: number; y: number };
  categories: LoungeCategory[];
  currentCategoryId: string;
  onMoveTo: (categoryId: string) => void;
  onCreateCircle: (agentId?: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showSubmenu, setShowSubmenu] = useState(false);
  const moveToRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const style = useMemo(() => {
    const menuWidth = 160;
    const menuHeight = 32 + 8;
    const x = Math.min(position.x, window.innerWidth - menuWidth - 8);
    const y = Math.min(position.y, window.innerHeight - menuHeight - 8);
    return { left: x, top: y };
  }, [position]);

  // Position submenu relative to the "Move to" button
  const submenuStyle = useMemo(() => {
    if (!moveToRef.current) return { left: '100%', top: 0 };
    const rect = moveToRef.current.getBoundingClientRect();
    const submenuWidth = 180;
    const submenuHeight = categories.length * 28 + 8;
    // Flip left if not enough space on the right
    const goLeft = rect.right + submenuWidth > window.innerWidth - 8;
    const x = goLeft ? -submenuWidth : rect.width;
    const y = Math.min(0, window.innerHeight - rect.top - submenuHeight - 8);
    return { left: x, top: y };
  }, [showSubmenu, categories.length]);

  return React.createElement('div', {
    ref: menuRef,
    className: 'fixed z-50 min-w-[160px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle',
    style,
    'data-testid': 'lounge-agent-context-menu',
  },
    // "Move to" with submenu
    React.createElement('div', { className: 'relative' },
      React.createElement('button', {
        ref: moveToRef,
        className: 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors cursor-pointer',
        onMouseEnter: () => setShowSubmenu(true),
        onMouseLeave: () => setShowSubmenu(false),
        onClick: () => setShowSubmenu((v) => !v),
        'data-testid': 'lounge-ctx-move-to',
      },
        // Move icon
        React.createElement('svg', {
          width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          React.createElement('path', { d: 'M15 3h6v6' }),
          React.createElement('path', { d: 'M10 14L21 3' }),
          React.createElement('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }),
        ),
        React.createElement('span', { className: 'flex-1 text-left' }, 'Move to'),
        // Chevron right
        React.createElement('svg', {
          width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          React.createElement('polyline', { points: '9 18 15 12 9 6' }),
        ),
      ),
      // Submenu
      showSubmenu && React.createElement('div', {
        className: 'absolute z-50 min-w-[180px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle',
        style: submenuStyle,
        onMouseEnter: () => setShowSubmenu(true),
        onMouseLeave: () => setShowSubmenu(false),
        'data-testid': 'lounge-move-to-submenu',
      },
        categories.map((cat) =>
          React.createElement('button', {
            key: cat.id,
            className: `w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer ${
              cat.id === currentCategoryId
                ? 'text-ctp-overlay0 cursor-default'
                : 'text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text'
            }`,
            disabled: cat.id === currentCategoryId,
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              if (cat.id !== currentCategoryId) {
                onMoveTo(cat.id);
                onClose();
              }
            },
            'data-testid': `lounge-move-to-${cat.id}`,
          },
            React.createElement('span', null, cat.label),
            cat.id === currentCategoryId && React.createElement('span', {
              className: 'ml-2 text-[10px] text-ctp-overlay0',
            }, '(current)'),
          ),
        ),
        // Divider + Create new
        React.createElement('div', { className: 'mx-2 my-1 border-t border-surface-1' }),
        React.createElement('button', {
          className: 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ctp-accent hover:bg-surface-1 transition-colors cursor-pointer',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            onCreateCircle();
            onClose();
          },
          'data-testid': 'lounge-move-to-create-new',
        },
          React.createElement('svg', {
            width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          },
            React.createElement('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
            React.createElement('line', { x1: '5', y1: '12', x2: '19', y2: '12' }),
          ),
          React.createElement('span', null, 'Create new'),
        ),
      ),
    ),
  );
}

// ── Category Section ───────────────────────────────────────────────────

const CHEVRON_RIGHT = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '9 18 15 12 9 6' }));

const CHEVRON_DOWN = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '6 9 12 15 18 9' }));

// ── Emoji Picker ──────────────────────────────────────────────────────

const EMOJI_OPTIONS = [
  '⭐', '💬', '🔥', '🚀', '💡', '🎯', '🏠', '📁',
  '🛠️', '🧪', '📋', '🎨', '🔒', '🌐', '📊', '🤖',
  '💎', '🎵', '📸', '🏆', '❤️', '⚡', '🌟', '🎮',
];

function EmojiPicker({ currentEmoji, onSelect, onClose }: {
  currentEmoji: string;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return React.createElement('div', {
    ref,
    className: 'ml-8 mr-3 mb-1 p-2 rounded-lg bg-ctp-mantle border border-surface-1 shadow-lg grid grid-cols-8 gap-1',
    'data-testid': 'lounge-emoji-picker',
  },
    ...EMOJI_OPTIONS.map((emoji) =>
      React.createElement('button', {
        key: emoji,
        onClick: () => onSelect(emoji),
        className: `w-7 h-7 flex items-center justify-center rounded text-sm cursor-pointer transition-colors ${
          emoji === currentEmoji ? 'bg-surface-1 ring-1 ring-ctp-accent' : 'hover:bg-surface-0'
        }`,
        'data-testid': `lounge-emoji-option-${emoji}`,
      }, emoji),
    ),
  );
}

// ── Create Circle Dialog ──────────────────────────────────────────────

function CircleDialog({ mode, onConfirm, onCancel, existingCategories, initialName, initialEmoji, editCategoryId }: {
  mode: 'create' | 'edit';
  onConfirm: (name: string, emoji?: string) => void;
  onCancel: () => void;
  existingCategories: LoungeCategory[];
  initialName?: string;
  initialEmoji?: string;
  editCategoryId?: string;
}) {
  const [value, setValue] = useState(initialName ?? '');
  const [emoji, setEmoji] = useState(initialEmoji ?? DEFAULT_CUSTOM_EMOJI);
  const [showEmojis, setShowEmojis] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (mode === 'edit') inputRef.current?.select();
  }, [mode]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed && !isReservedCircleName(trimmed) && !isDuplicateCircleName(trimmed, existingCategories, editCategoryId)) {
      onConfirm(trimmed, emoji);
    }
  }, [value, emoji, onConfirm, existingCategories, editCategoryId]);

  const trimmed = value.trim();
  const isReserved = trimmed.length > 0 && isReservedCircleName(trimmed);
  const isDuplicate = trimmed.length > 0 && !isReserved && isDuplicateCircleName(trimmed, existingCategories, editCategoryId);
  const isValid = trimmed.length > 0 && !isReserved && !isDuplicate;
  const isCreate = mode === 'create';

  return React.createElement('div', {
    className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50',
    onClick: onCancel,
  },
    React.createElement('div', {
      className: 'bg-ctp-mantle border border-surface-1 rounded-xl p-4 w-72 shadow-2xl',
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    },
      React.createElement('h3', {
        className: 'text-sm font-semibold text-ctp-text mb-3',
      }, isCreate ? 'Create a new circle' : 'Rename circle'),
      // Emoji + input row
      React.createElement('div', { className: 'flex items-center gap-2' },
        // Emoji button
        React.createElement('button', {
          onClick: () => setShowEmojis(!showEmojis),
          className: 'w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg bg-ctp-base border border-surface-1 text-base hover:bg-surface-0 transition-colors cursor-pointer',
          title: 'Choose icon',
          'data-testid': 'lounge-circle-dialog-emoji-btn',
        }, emoji),
        React.createElement('input', {
          ref: inputRef,
          type: 'text',
          value,
          placeholder: 'Enter circle name',
          className: 'flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-ctp-base border border-surface-1 text-xs text-ctp-text placeholder-ctp-overlay0 outline-none focus:ring-1 focus:ring-ctp-accent',
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' && isValid) handleSubmit();
            if (e.key === 'Escape') onCancel();
          },
          'data-testid': 'lounge-circle-dialog-input',
        }),
      ),
      // Inline emoji picker
      showEmojis && React.createElement('div', {
        className: 'mt-2 p-2 rounded-lg bg-ctp-base border border-surface-1 grid grid-cols-8 gap-1',
        'data-testid': 'lounge-circle-dialog-emoji-picker',
      },
        ...EMOJI_OPTIONS.map((e) =>
          React.createElement('button', {
            key: e,
            onClick: () => { setEmoji(e); setShowEmojis(false); },
            className: `w-7 h-7 flex items-center justify-center rounded text-sm cursor-pointer transition-colors ${
              e === emoji ? 'bg-surface-1 ring-1 ring-ctp-accent' : 'hover:bg-surface-0'
            }`,
          }, e),
        ),
      ),
      isReserved && React.createElement('p', {
        className: 'text-[10px] text-ctp-red mt-1',
      }, 'This name is reserved'),
      isDuplicate && React.createElement('p', {
        className: 'text-[10px] text-ctp-red mt-1',
      }, 'A circle with this name already exists'),
      React.createElement('div', {
        className: 'flex justify-end gap-2 mt-3',
      },
        React.createElement('button', {
          onClick: onCancel,
          className: 'px-3 py-1 rounded-md text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 transition-colors cursor-pointer',
          'data-testid': 'lounge-circle-dialog-cancel',
        }, 'Cancel'),
        React.createElement('button', {
          onClick: handleSubmit,
          disabled: !isValid,
          className: `px-3 py-1 rounded-md text-xs transition-colors cursor-pointer ${
            isValid
              ? 'bg-ctp-accent text-ctp-base hover:opacity-90'
              : 'bg-surface-1 text-ctp-overlay0 cursor-not-allowed'
          }`,
          'data-testid': 'lounge-circle-dialog-confirm',
        }, isCreate ? 'Create' : 'Save'),
      ),
    ),
  );
}

function CategorySection({ category, agents, allAgents, allCategories, projects, isCollapsed, selectedAgentId, onToggle, onSelectAgent, onEditCircle, onDelete, onMoveAgent, onCreateCircle, onReorderCategory }: {
  category: LoungeCategory;
  agents: AgentInfo[];
  allAgents: AgentInfo[];
  allCategories: LoungeCategory[];
  projects: { id: string; name: string; path: string }[];
  isCollapsed: boolean;
  selectedAgentId: string | null;
  onToggle: () => void;
  onSelectAgent: (agentId: string, projectId: string) => void;
  onEditCircle: (categoryId: string) => void;
  onDelete: (categoryId: string) => void;
  onMoveAgent: (agentId: string, targetCategoryId: string) => void;
  onCreateCircle: (agentId?: string) => void;
  onReorderCategory: (fromId: string, toId: string) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [agentContextMenu, setAgentContextMenu] = useState<{ agentId: string; x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isDefaultCircle(category.id)) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [category.id]);

  // ── Drag-and-drop handlers ──

  const isGeneralCircle = isDefaultCircle(category.id);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (isGeneralCircle) { e.preventDefault(); return; }
    e.dataTransfer.setData('application/x-lounge-category', category.id);
    e.dataTransfer.effectAllowed = 'move';
  }, [category.id, isGeneralCircle]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const hasAgent = e.dataTransfer.types.includes('application/x-lounge-agent');
    const hasCategory = e.dataTransfer.types.includes('application/x-lounge-category');
    if (!hasAgent && !hasCategory) return;
    // Cannot drop a category onto General
    if (hasCategory && isGeneralCircle) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  }, [isGeneralCircle]);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const agentId = e.dataTransfer.getData('application/x-lounge-agent');
    if (agentId) {
      onMoveAgent(agentId, category.id);
      return;
    }
    const fromCategoryId = e.dataTransfer.getData('application/x-lounge-category');
    if (fromCategoryId && fromCategoryId !== category.id && !isGeneralCircle) {
      onReorderCategory(fromCategoryId, category.id);
    }
  }, [category.id, onMoveAgent, onReorderCategory, isGeneralCircle]);

  return React.createElement('div', {
    'data-testid': `lounge-category-${category.id}`,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  },
    // Category header
    React.createElement('button', {
      onClick: onToggle,
      onContextMenu: handleContextMenu,
      draggable: !isGeneralCircle,
      onDragStart: handleDragStart,
      className: `w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider hover:bg-surface-0 cursor-pointer transition-colors ${
        dragOver ? 'bg-surface-1 ring-1 ring-ctp-accent ring-inset' : ''
      }`,
      'data-testid': `lounge-category-toggle-${category.id}`,
    },
      isCollapsed ? CHEVRON_RIGHT : CHEVRON_DOWN,
      React.createElement('span', { className: 'text-sm flex-shrink-0' }, category.emoji || '📁'),
      React.createElement('span', { className: 'flex-1 text-left truncate' }, category.label),
      React.createElement('span', { className: 'text-[10px] text-ctp-overlay0 tabular-nums' }, String(agents.length)),
    ),
    // Context menu
    contextMenu && React.createElement(CategoryContextMenu, {
      position: contextMenu,
      categoryId: category.id,
      onRename: () => { setContextMenu(null); onEditCircle(category.id); },
      onDelete: () => onDelete(category.id),
      onClose: () => setContextMenu(null),
    }),
    // Agent rows (hidden when collapsed)
    !isCollapsed && agents.length > 0 && agents.map((agent) => {
      const displayName = disambiguateAgentName(agent, allAgents, projects);
      return React.createElement(AgentRow, {
        key: agent.id,
        agent,
        displayName,
        isSelected: selectedAgentId === agent.id,
        onClick: () => onSelectAgent(agent.id, agent.projectId),
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          setAgentContextMenu({ agentId: agent.id, x: e.clientX, y: e.clientY });
        },
      });
    }),
    // Empty custom circle hint
    !isCollapsed && agents.length === 0 && React.createElement('div', {
      className: 'px-8 py-2 text-[11px] text-ctp-overlay0 italic',
    }, 'Move agents here via right-click'),
    // Agent context menu
    agentContextMenu && React.createElement(AgentContextMenu, {
      position: agentContextMenu,
      categories: allCategories,
      currentCategoryId: category.id,
      onMoveTo: (targetCategoryId: string) => onMoveAgent(agentContextMenu.agentId, targetCategoryId),
      onCreateCircle: () => onCreateCircle(agentContextMenu.agentId),
      onClose: () => setAgentContextMenu(null),
    }),
  );
}

// ── Empty State ────────────────────────────────────────────────────────

function EmptyState() {
  return React.createElement('div', {
    className: 'flex items-center justify-center h-full text-center px-6',
  },
    React.createElement('div', null,
      React.createElement('p', { className: 'text-ctp-subtext0 text-sm mb-1' }, 'No agents yet'),
      React.createElement('p', { className: 'text-ctp-overlay0 text-xs' }, 'Agents will appear here grouped by project.'),
    ),
  );
}

// ── Agent Content ──────────────────────────────────────────────────────

function AgentContent({ api, agentId }: { api: PluginAPI; agentId: string }) {
  const agents = api.agents.list();
  const agent = agents.find((a) => a.id === agentId);

  if (!agent) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-sm',
    }, 'Agent not found');
  }

  const { AgentTerminal, SleepingAgent } = api.widgets;

  if (agent.status === 'sleeping' || agent.status === 'error') {
    return React.createElement(SleepingAgent, { agentId: agent.id });
  }

  return React.createElement(AgentTerminal, { agentId: agent.id, focused: true });
}

// ── No Selection Placeholder ───────────────────────────────────────────

function NoSelection() {
  return React.createElement('div', {
    className: 'flex items-center justify-center h-full text-center px-6',
    'data-testid': 'lounge-no-selection',
  },
    React.createElement('div', null,
      React.createElement('p', { className: 'text-ctp-subtext0 text-sm mb-1' }, 'Select an agent'),
      React.createElement('p', { className: 'text-ctp-overlay0 text-xs' }, 'Click an agent from the list to view it here.'),
    ),
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const categories = useLoungeStore((s) => s.categories);
  const collapsed = useLoungeStore((s) => s.collapsed);
  const selectedAgentId = useLoungeStore((s) => s.selectedAgentId);
  const deriveCategories = useLoungeStore((s) => s.deriveCategories);
  const toggleCollapsed = useLoungeStore((s) => s.toggleCollapsed);
  const selectAgent = useLoungeStore((s) => s.selectAgent);
  const renameCategory = useLoungeStore((s) => s.renameCategory);
  const moveAgent = useLoungeStore((s) => s.moveAgent);
  const agentCategoryOverrides = useLoungeStore((s) => s.agentCategoryOverrides);
  const addCircle = useLoungeStore((s) => s.addCircle);
  const deleteCircle = useLoungeStore((s) => s.deleteCircle);
  const reorderCategory = useLoungeStore((s) => s.reorderCategory);
  const setCategoryEmoji = useLoungeStore((s) => s.setCategoryEmoji);
  const loadPersistedState = useLoungeStore((s) => s.loadPersistedState);

  // Load persisted state on mount
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api.storage.global.read(STORAGE_KEY).then((data) => {
      if (data) loadPersistedState(data as LoungePersistedState);
      else useLoungeStore.setState({ hydrated: true });
      setLoaded(true);
    }).catch(() => {
      useLoungeStore.setState({ hydrated: true });
      setLoaded(true);
    });
  }, [api, loadPersistedState]);

  // Debounced auto-save (500ms after any persistable state change)
  const renamedLabels = useLoungeStore((s) => s.renamedLabels);
  const customCircles = useLoungeStore((s) => s.customCircles);
  const nextCircleId = useLoungeStore((s) => s.nextCircleId);
  const categoryOrder = useLoungeStore((s) => s.categoryOrder);
  const categoryEmojis = useLoungeStore((s) => s.categoryEmojis);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loaded) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const state = useLoungeStore.getState();
      api.storage.global.write(STORAGE_KEY, getPersistedState(state)).catch(() => {});
    }, 500);
    return () => {
      // Flush pending save synchronously on unmount to prevent data loss
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const state = useLoungeStore.getState();
        api.storage.global.write(STORAGE_KEY, getPersistedState(state)).catch(() => {});
      }
    };
  }, [api, loaded, renamedLabels, agentCategoryOverrides, customCircles, nextCircleId, categoryOrder, categoryEmojis, collapsed]);

  // Force re-render when agents change
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);

  // Derive categories from projects
  const projects = useMemo(() => api.projects.list(), [api, agentTick]);
  useEffect(() => {
    deriveCategories(projects);
  }, [projects, deriveCategories]);

  // Get all agents across projects
  const agents = useMemo(() => api.agents.list(), [api, agentTick]);

  // Group agents by category (respecting overrides)
  const grouped = useMemo(
    () => groupAgentsByCategory(agents, categories, agentCategoryOverrides),
    [agents, categories, agentCategoryOverrides],
  );

  const handleSelectAgent = useCallback((agentId: string, projectId: string) => {
    selectAgent(agentId, projectId);
  }, [selectAgent]);

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [pendingMoveAgentId, setPendingMoveAgentId] = useState<string | null>(null);
  const [editingCircle, setEditingCircle] = useState<{ id: string; label: string; emoji?: string } | null>(null);

  const handleCreateCircle = useCallback((agentId?: string) => {
    setPendingMoveAgentId(agentId ?? null);
    setShowCreateDialog(true);
  }, []);

  const handleConfirmCreate = useCallback((name: string, emoji?: string) => {
    const newId = addCircle(name);
    if (newId) {
      if (emoji && emoji !== DEFAULT_CUSTOM_EMOJI) {
        setCategoryEmoji(newId, emoji);
      }
      if (pendingMoveAgentId) {
        moveAgent(pendingMoveAgentId, newId);
      }
    }
    setShowCreateDialog(false);
    setPendingMoveAgentId(null);
  }, [addCircle, moveAgent, setCategoryEmoji, pendingMoveAgentId]);

  const handleEditCircle = useCallback((categoryId: string) => {
    const cat = categories.find((c) => c.id === categoryId);
    if (cat) {
      setEditingCircle({ id: cat.id, label: cat.label, emoji: cat.emoji });
    }
  }, [categories]);

  const handleConfirmEdit = useCallback((name: string, emoji?: string) => {
    if (editingCircle) {
      if (name !== editingCircle.label) {
        renameCategory(editingCircle.id, name);
      }
      if (emoji) {
        setCategoryEmoji(editingCircle.id, emoji);
      }
    }
    setEditingCircle(null);
  }, [editingCircle, renameCategory, setCategoryEmoji]);

  // Clear selection when agent disappears
  useEffect(() => {
    if (selectedAgentId && !agents.find((a) => a.id === selectedAgentId)) {
      selectAgent(null);
    }
  }, [agents, selectedAgentId, selectAgent]);

  // Auto-delete empty custom circles (not project-derived, not General)
  // Only runs after hydration + agents loaded to avoid premature cleanup
  useEffect(() => {
    if (!loaded || agents.length === 0) return;
    for (const cat of categories) {
      if (cat.projectId || isDefaultCircle(cat.id)) continue;
      const catAgents = grouped.get(cat.id) ?? [];
      if (catAgents.length === 0) {
        deleteCircle(cat.id);
      }
    }
  }, [grouped, categories, deleteCircle, loaded, agents.length]);

  const hasAgents = agents.length > 0;

  // All categories are visible — project categories persist even when empty,
  // custom circles are auto-deleted when empty (see effect above)
  const visibleCategories = categories;

  return React.createElement('div', {
    className: 'flex h-full w-full bg-ctp-base',
    'data-testid': 'lounge-main-panel',
  },
    // Left sidebar — agent list
    React.createElement('div', {
      className: 'w-64 flex-shrink-0 flex flex-col bg-ctp-mantle border-r border-surface-0 h-full min-h-0',
    },
      // Header
      React.createElement('div', {
        className: 'px-3 py-3 border-b border-surface-0 flex items-center justify-between',
      },
        React.createElement('h2', {
          className: 'text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider',
        }, 'Lounge'),
        React.createElement('button', {
          onClick: handleCreateCircle,
          title: 'New circle',
          className: 'w-5 h-5 flex items-center justify-center rounded text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 transition-colors cursor-pointer',
          'data-testid': 'lounge-add-circle',
        },
          React.createElement('svg', {
            width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          },
            React.createElement('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
            React.createElement('line', { x1: '5', y1: '12', x2: '19', y2: '12' }),
          ),
        ),
      ),
      // Scrollable category list
      React.createElement('div', {
        className: 'flex-1 overflow-y-auto py-1',
        'data-testid': 'lounge-category-list',
      },
        hasAgents || categories.some((c) => !c.projectId)
          ? visibleCategories.map((cat) => {
              const catAgents = grouped.get(cat.id) ?? [];
              return React.createElement(CategorySection, {
                key: cat.id,
                category: cat,
                agents: catAgents,
                allAgents: agents,
                allCategories: visibleCategories,
                projects,
                isCollapsed: collapsed.has(cat.id),
                selectedAgentId,
                onToggle: () => toggleCollapsed(cat.id),
                onSelectAgent: handleSelectAgent,
                onEditCircle: handleEditCircle,
                onDelete: deleteCircle,
                onMoveAgent: moveAgent,
                onCreateCircle: handleCreateCircle,
                onReorderCategory: reorderCategory,
              });
            })
          : React.createElement(EmptyState),
      ),
    ),
    // Right content — selected agent view
    React.createElement('div', {
      className: 'flex-1 min-w-0 h-full',
    },
      selectedAgentId
        ? React.createElement(AgentContent, { api, agentId: selectedAgentId })
        : React.createElement(NoSelection),
    ),
    // Circle dialog (create or edit mode)
    showCreateDialog && React.createElement(CircleDialog, {
      mode: 'create',
      onConfirm: handleConfirmCreate,
      onCancel: () => setShowCreateDialog(false),
      existingCategories: categories,
    }),
    editingCircle && React.createElement(CircleDialog, {
      mode: 'edit',
      onConfirm: handleConfirmEdit,
      onCancel: () => setEditingCircle(null),
      existingCategories: categories,
      initialName: editingCircle.label,
      initialEmoji: editingCircle.emoji,
      editCategoryId: editingCircle.id,
    }),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
