import React, { useState, useCallback, useEffect } from 'react';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';
import type { Board, BoardState, Swimlane } from './types';
import { BOARDS_KEY, generateId, ACCENT_COLORS } from './types';
import { kanBossState } from './state';

interface BoardConfigDialogProps {
  api: PluginAPI;
  board: Board;
}

// ── Tab types ───────────────────────────────────────────────────────────

type ConfigTab = 'states' | 'swimlanes' | 'settings';

// ── BoardConfigDialog ───────────────────────────────────────────────────

export function BoardConfigDialog({ api, board }: BoardConfigDialogProps) {
  const storage = api.storage.projectLocal;
  const [tab, setTab] = useState<ConfigTab>('states');

  // Local copies for editing
  const [states, setStates] = useState<BoardState[]>([...board.states]);
  const [swimlanes, setSwimlanes] = useState<Swimlane[]>([...board.swimlanes]);
  const [maxRetries, setMaxRetries] = useState(board.config.maxRetries);
  const [durableAgents, setDurableAgents] = useState<AgentInfo[]>([]);

  // Load durable agents for swimlane assignment
  useEffect(() => {
    const agents = api.agents.list().filter((a) => a.kind === 'durable');
    setDurableAgents(agents);
  }, [api]);

  // ── State management ────────────────────────────────────────────────
  const addState = useCallback(() => {
    const order = states.length;
    const colorIdx = order % ACCENT_COLORS.length;
    setStates([...states, {
      id: generateId('state'),
      name: `State ${order + 1}`,
      order,
      isAutomatic: false,
      automationPrompt: '',
      accentColor: ACCENT_COLORS[colorIdx],
    }]);
  }, [states]);

  const removeState = useCallback((stateId: string) => {
    if (states.length <= 1) return;
    const filtered = states.filter((s) => s.id !== stateId);
    setStates(filtered.map((s, i) => ({ ...s, order: i })));
  }, [states]);

  const updateState = useCallback((stateId: string, updates: Partial<BoardState>) => {
    setStates(states.map((s) => s.id === stateId ? { ...s, ...updates } : s));
  }, [states]);

  // ── Swimlane management ─────────────────────────────────────────────
  const addSwimlane = useCallback(() => {
    const order = swimlanes.length;
    setSwimlanes([...swimlanes, {
      id: generateId('lane'),
      name: `Swimlane ${order + 1}`,
      order,
      managerAgentId: null,
    }]);
  }, [swimlanes]);

  const removeSwimlane = useCallback((laneId: string) => {
    if (swimlanes.length <= 1) return;
    const filtered = swimlanes.filter((l) => l.id !== laneId);
    setSwimlanes(filtered.map((l, i) => ({ ...l, order: i })));
  }, [swimlanes]);

  const updateSwimlane = useCallback((laneId: string, updates: Partial<Swimlane>) => {
    setSwimlanes(swimlanes.map((l) => l.id === laneId ? { ...l, ...updates } : l));
  }, [swimlanes]);

  // ── Save ────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const raw = await storage.read(BOARDS_KEY);
    const boards: Board[] = Array.isArray(raw) ? raw : [];
    const idx = boards.findIndex((b) => b.id === board.id);
    if (idx !== -1) {
      boards[idx] = {
        ...boards[idx],
        states,
        swimlanes,
        config: { ...boards[idx].config, maxRetries },
        updatedAt: Date.now(),
      };
      await storage.write(BOARDS_KEY, boards);
      kanBossState.setBoards(boards);
    }
    kanBossState.closeBoardConfig();
    kanBossState.triggerRefresh();
  }, [storage, board.id, states, swimlanes, maxRetries]);

  // ── Cancel ──────────────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    kanBossState.closeBoardConfig();
  }, []);

  // ── Tab button helper ───────────────────────────────────────────────
  const tabBtn = (id: ConfigTab, label: string) =>
    React.createElement('button', {
      key: id,
      className: `px-3 py-1.5 text-xs rounded-t transition-colors ${
        tab === id
          ? 'bg-ctp-base text-ctp-text border border-ctp-surface0 border-b-0'
          : 'text-ctp-subtext0 hover:text-ctp-text'
      }`,
      onClick: () => setTab(id),
    }, label);

  // ── Render ──────────────────────────────────────────────────────────
  return React.createElement('div', {
    className: 'fixed inset-0 bg-black/50 flex items-center justify-center z-50',
    onClick: handleCancel,
  },
    React.createElement('div', {
      className: 'bg-ctp-base border border-ctp-surface0 rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col',
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    },
      // Header
      React.createElement('div', {
        className: 'flex items-center justify-between px-4 py-3 border-b border-ctp-surface0',
      },
        React.createElement('span', { className: 'text-sm font-medium text-ctp-text' }, `Board Settings: ${board.name}`),
        React.createElement('button', {
          className: 'text-ctp-subtext0 hover:text-ctp-text text-lg',
          onClick: handleCancel,
        }, '\u00D7'),
      ),

      // Tabs
      React.createElement('div', { className: 'flex gap-1 px-4 pt-2 bg-ctp-mantle' },
        tabBtn('states', 'States'),
        tabBtn('swimlanes', 'Swimlanes'),
        tabBtn('settings', 'Settings'),
      ),

      // Tab content
      React.createElement('div', { className: 'flex-1 overflow-y-auto p-4' },
        // ── States tab ────────────────────────────────────────────────
        tab === 'states' && React.createElement('div', { className: 'space-y-3' },
          states.map((state, idx) =>
            React.createElement('div', {
              key: state.id,
              className: 'p-3 bg-ctp-mantle border border-ctp-surface0 rounded-lg space-y-2',
            },
              // Name + color + remove
              React.createElement('div', { className: 'flex items-center gap-2' },
                React.createElement('div', {
                  className: 'w-3 h-3 rounded-full flex-shrink-0',
                  style: { backgroundColor: state.accentColor },
                }),
                React.createElement('input', {
                  type: 'text',
                  className: 'flex-1 px-2 py-1 text-xs rounded bg-ctp-base border border-ctp-surface2 text-ctp-text focus:outline-none focus:border-ctp-accent/50',
                  value: state.name,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => updateState(state.id, { name: e.target.value }),
                }),
                // Color picker (cycle through accent colors)
                React.createElement('select', {
                  className: 'px-1 py-1 text-[10px] rounded bg-ctp-base border border-ctp-surface2 text-ctp-text',
                  value: state.accentColor,
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => updateState(state.id, { accentColor: e.target.value }),
                },
                  ACCENT_COLORS.map((color, ci) =>
                    React.createElement('option', { key: ci, value: color },
                      ['Blue', 'Yellow', 'Green', 'Mauve', 'Peach', 'Teal'][ci],
                    ),
                  ),
                ),
                states.length > 1 && React.createElement('button', {
                  className: 'text-ctp-subtext0 hover:text-ctp-red text-xs px-1',
                  onClick: () => removeState(state.id),
                  title: 'Remove state',
                }, '\u00D7'),
              ),

              // Automatic toggle + automation prompt
              React.createElement('div', { className: 'flex items-center gap-2' },
                React.createElement('label', { className: 'flex items-center gap-1.5 cursor-pointer' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: state.isAutomatic,
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) => updateState(state.id, { isAutomatic: e.target.checked }),
                    className: 'rounded',
                  }),
                  React.createElement('span', { className: 'text-[10px] text-ctp-subtext1' }, 'Automatic'),
                ),
              ),

              state.isAutomatic && React.createElement('div', null,
                React.createElement('label', { className: 'block text-[10px] text-ctp-subtext1 mb-0.5' }, 'Automation Prompt'),
                React.createElement('textarea', {
                  className: 'w-full px-2 py-1 text-[11px] rounded bg-ctp-base border border-ctp-surface2 text-ctp-text font-mono placeholder:text-ctp-subtext0/40 focus:outline-none focus:border-ctp-accent/50 resize-y',
                  rows: 2,
                  value: state.automationPrompt,
                  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => updateState(state.id, { automationPrompt: e.target.value }),
                  placeholder: 'Describe the outcome the agent should achieve...',
                }),
              ),
            ),
          ),
          React.createElement('button', {
            className: 'w-full py-1.5 text-xs text-ctp-subtext0 hover:text-ctp-text border border-dashed border-ctp-surface0 rounded-lg hover:border-ctp-surface2 transition-colors',
            onClick: addState,
          }, '+ Add State'),
        ),

        // ── Swimlanes tab ─────────────────────────────────────────────
        tab === 'swimlanes' && React.createElement('div', { className: 'space-y-3' },
          swimlanes.map((lane) =>
            React.createElement('div', {
              key: lane.id,
              className: 'p-3 bg-ctp-mantle border border-ctp-surface0 rounded-lg space-y-2',
            },
              // Name + remove
              React.createElement('div', { className: 'flex items-center gap-2' },
                React.createElement('input', {
                  type: 'text',
                  className: 'flex-1 px-2 py-1 text-xs rounded bg-ctp-base border border-ctp-surface2 text-ctp-text focus:outline-none focus:border-ctp-accent/50',
                  value: lane.name,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => updateSwimlane(lane.id, { name: e.target.value }),
                }),
                swimlanes.length > 1 && React.createElement('button', {
                  className: 'text-ctp-subtext0 hover:text-ctp-red text-xs px-1',
                  onClick: () => removeSwimlane(lane.id),
                  title: 'Remove swimlane',
                }, '\u00D7'),
              ),

              // Agent assignment
              React.createElement('div', null,
                React.createElement('label', { className: 'block text-[10px] text-ctp-subtext1 mb-0.5' }, 'Manager Agent'),
                React.createElement('select', {
                  className: 'w-full px-2 py-1 text-xs rounded bg-ctp-base border border-ctp-surface2 text-ctp-text focus:outline-none focus:border-ctp-accent/50',
                  value: lane.managerAgentId ?? '',
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                    updateSwimlane(lane.id, { managerAgentId: e.target.value || null }),
                },
                  React.createElement('option', { value: '' }, 'None (manual only)'),
                  durableAgents.map((agent) =>
                    React.createElement('option', { key: agent.id, value: agent.id },
                      `${agent.emoji ?? ''} ${agent.name}`.trim(),
                    ),
                  ),
                ),
              ),
            ),
          ),
          React.createElement('button', {
            className: 'w-full py-1.5 text-xs text-ctp-subtext0 hover:text-ctp-text border border-dashed border-ctp-surface0 rounded-lg hover:border-ctp-surface2 transition-colors',
            onClick: addSwimlane,
          }, '+ Add Swimlane'),
        ),

        // ── Settings tab ──────────────────────────────────────────────
        tab === 'settings' && React.createElement('div', { className: 'space-y-3' },
          React.createElement('div', null,
            React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Max Retries'),
            React.createElement('input', {
              type: 'number',
              className: 'w-24 px-2 py-1 text-xs rounded bg-ctp-mantle border border-ctp-surface2 text-ctp-text focus:outline-none focus:border-ctp-accent/50',
              min: 1,
              max: 10,
              value: maxRetries,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMaxRetries(Math.max(1, Math.min(10, parseInt(e.target.value) || 3))),
            }),
            React.createElement('p', { className: 'text-[10px] text-ctp-subtext0 mt-0.5' },
              'Number of times automation will retry before marking a card as stuck.',
            ),
          ),
        ),
      ),

      // Footer
      React.createElement('div', {
        className: 'flex items-center justify-end gap-2 px-4 py-3 border-t border-ctp-surface0',
      },
        React.createElement('button', {
          className: 'px-3 py-1 text-xs text-ctp-subtext1 border border-ctp-surface2 rounded hover:bg-ctp-surface0 transition-colors',
          onClick: handleCancel,
        }, 'Cancel'),
        React.createElement('button', {
          className: 'px-3 py-1 text-xs bg-ctp-accent text-white rounded hover:opacity-90 transition-opacity',
          onClick: handleSave,
        }, 'Save'),
      ),
    ),
  );
}
