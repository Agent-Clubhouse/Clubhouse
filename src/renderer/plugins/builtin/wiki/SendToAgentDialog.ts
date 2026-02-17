import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';

// ── Props ────────────────────────────────────────────────────────────────

interface SendToAgentDialogProps {
  api: PluginAPI;
  filePath: string;
  content: string;
  onClose: () => void;
}

// ── Status badge helper ──────────────────────────────────────────────────

function statusBadge(status: AgentInfo['status']) {
  switch (status) {
    case 'sleeping':
      return React.createElement('span', {
        className: 'text-[9px] px-1 py-px rounded bg-ctp-green/15 text-ctp-green',
      }, 'sleeping');
    case 'running':
      return React.createElement('span', {
        className: 'text-[9px] px-1 py-px rounded bg-ctp-yellow/15 text-ctp-yellow',
      }, 'running');
    case 'error':
      return React.createElement('span', {
        className: 'text-[9px] px-1 py-px rounded bg-ctp-red/15 text-ctp-red',
      }, 'error');
    default:
      return null;
  }
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

  // Durable agent handler
  const handleDurableAgent = useCallback(async (agent: AgentInfo) => {
    if (agent.status === 'running') {
      const ok = await api.ui.showConfirm(
        `"${agent.name}" is currently running. Sending this page will interrupt its current work. Continue?`
      );
      if (!ok) return;
      await api.agents.kill(agent.id);
    }

    const mission = buildMission();
    try {
      await api.agents.resume(agent.id, mission);
      api.ui.showNotice(`Wiki page sent to ${agent.name}`);
    } catch {
      api.ui.showError(`Failed to send to ${agent.name}`);
    }
    onClose();
  }, [api, buildMission, onClose]);

  const AgentAvatar = api.widgets.AgentAvatar;

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
        // Empty state
        durableAgents.length === 0
          ? React.createElement('div', {
              className: 'text-xs text-ctp-subtext0 text-center py-4',
            }, 'No durable agents found')
          : null,

        // Durable agents
        ...durableAgents.map((agent) =>
          React.createElement('button', {
            key: agent.id,
            className: 'w-full text-left px-3 py-2 text-xs text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
            onClick: () => handleDurableAgent(agent),
          },
            React.createElement('div', { className: 'flex items-center gap-1.5' },
              React.createElement(AgentAvatar, {
                agentId: agent.id,
                size: 'sm',
                showStatusRing: true,
              }),
              React.createElement('span', { className: 'font-medium' }, agent.name),
              statusBadge(agent.status),
            ),
            agent.status === 'running'
              ? React.createElement('div', {
                  className: 'text-[10px] text-ctp-yellow mt-0.5 pl-5',
                }, 'Will interrupt current work')
              : React.createElement('div', {
                  className: 'text-[10px] text-ctp-subtext0 mt-0.5 pl-5',
                }, 'Send page to this agent'),
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
