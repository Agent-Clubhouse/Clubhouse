import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';

// ── Props ────────────────────────────────────────────────────────────────

interface SendToAgentDialogProps {
  api: PluginAPI;
  filePath: string;
  content: string;
  onClose: () => void;
}

// ── Component ────────────────────────────────────────────────────────────

export function SendToAgentDialog({ api, filePath, content, onClose }: SendToAgentDialogProps) {
  const [instructions, setInstructions] = useState('');
  const [durableAgents, setDurableAgents] = useState<AgentInfo[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Load durable agents on mount
  useEffect(() => {
    const agents = api.agents.list().filter((a) => a.kind === 'durable');
    setDurableAgents(agents);
  }, [api]);

  // Close on outside click
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (overlayRef.current && e.target === overlayRef.current) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Build mission string
  const buildMission = useCallback((): string => {
    const parts = [
      `Wiki page: ${filePath}`,
      '',
      'Page content:',
      '```markdown',
      content,
      '```',
    ];
    if (instructions.trim()) {
      parts.push('', `Additional instructions: ${instructions.trim()}`);
    }
    return parts.join('\n');
  }, [filePath, content, instructions]);

  // Quick agent handler
  const handleQuickAgent = useCallback(async () => {
    const mission = buildMission();
    try {
      await api.agents.runQuick(mission);
      api.ui.showNotice('Quick agent launched with wiki page');
    } catch {
      api.ui.showError('Failed to launch quick agent');
    }
    onClose();
  }, [api, buildMission, onClose]);

  // Durable agent handler
  const handleDurableAgent = useCallback(async (agent: AgentInfo) => {
    if (agent.status === 'running') {
      const ok = await api.ui.showConfirm(
        'This agent is running. Restarting will interrupt its work. Continue?'
      );
      if (!ok) return;
      await api.agents.kill(agent.id);
    }

    try {
      await api.agents.resume(agent.id);
      api.ui.showNotice(`Wiki page sent to ${agent.name}`);
    } catch {
      api.ui.showError(`Failed to send to ${agent.name}`);
    }
    onClose();
  }, [api, onClose]);

  return React.createElement('div', {
    ref: overlayRef,
    className: 'absolute inset-0 z-50 flex items-center justify-center bg-ctp-base/80',
  },
    React.createElement('div', {
      className: 'bg-ctp-mantle border border-ctp-surface0 rounded-lg shadow-lg p-4 w-80 max-h-[80vh] overflow-auto',
    },
      // Title
      React.createElement('div', { className: 'text-sm font-medium text-ctp-text mb-3' }, 'Send to Agent'),

      // File path
      React.createElement('div', { className: 'text-[10px] text-ctp-subtext0 mb-3 truncate' }, filePath),

      // Instructions textarea
      React.createElement('textarea', {
        className: 'w-full h-20 px-2 py-1.5 text-xs bg-ctp-base border border-ctp-surface0 rounded text-ctp-text resize-none focus:outline-none focus:border-ctp-accent',
        placeholder: 'Additional instructions (optional)',
        value: instructions,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setInstructions(e.target.value),
      }),

      // Agent list
      React.createElement('div', { className: 'mt-3 space-y-1' },
        // Quick Agent
        React.createElement('button', {
          className: 'w-full text-left px-3 py-2 text-xs text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: handleQuickAgent,
        },
          React.createElement('div', { className: 'font-medium' }, 'Quick Agent'),
          React.createElement('div', { className: 'text-[10px] text-ctp-subtext0 mt-0.5' }, 'Spawn a quick agent with this page'),
        ),

        // Divider
        durableAgents.length > 0 && React.createElement('div', {
          className: 'border-t border-ctp-surface0 my-1',
        }),

        // Durable agents
        ...durableAgents.map((agent) =>
          React.createElement('button', {
            key: agent.id,
            className: 'w-full text-left px-3 py-2 text-xs text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
            onClick: () => handleDurableAgent(agent),
          },
            React.createElement('div', { className: 'flex items-center gap-1.5' },
              React.createElement('span', {
                className: 'w-2 h-2 rounded-full flex-shrink-0',
                style: { backgroundColor: agent.color || 'var(--ctp-accent)' },
              }),
              React.createElement('span', { className: 'font-medium' }, agent.name),
              agent.status === 'running' && React.createElement('span', {
                className: 'text-[9px] px-1 py-px rounded bg-ctp-yellow/15 text-ctp-yellow',
              }, 'running'),
            ),
            React.createElement('div', { className: 'text-[10px] text-ctp-subtext0 mt-0.5 pl-3.5' }, 'Send page to this agent'),
          ),
        ),
      ),

      // Cancel button
      React.createElement('div', { className: 'mt-3 flex justify-end' },
        React.createElement('button', {
          className: 'px-3 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: onClose,
        }, 'Cancel'),
      ),
    ),
  );
}
