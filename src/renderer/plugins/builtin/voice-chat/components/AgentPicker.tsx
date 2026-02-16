import React, { useEffect, useCallback, useSyncExternalStore } from 'react';
import type { PluginAPI, AgentInfo } from '../../../../../shared/plugin-types';
import { voiceState } from '../state';

function useVoiceState() {
  const subscribe = useCallback((cb: () => void) => voiceState.subscribe(cb), []);
  const getSelectedAgent = useCallback(() => voiceState.selectedAgent, []);
  const selectedAgent = useSyncExternalStore(subscribe, getSelectedAgent);
  return { selectedAgent };
}

export function AgentPicker({ api }: { api: PluginAPI }) {
  const { selectedAgent } = useVoiceState();
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);

  const refreshAgents = useCallback(() => {
    const all = api.agents.list();
    const durables = all.filter((a) => a.kind === 'durable');
    setAgents(durables);
  }, [api]);

  useEffect(() => {
    refreshAgents();
    const sub = api.agents.onAnyChange(refreshAgents);
    return () => sub.dispose();
  }, [api, refreshAgents]);

  const handleSelect = useCallback(async (agent: AgentInfo) => {
    if (agent.status === 'running') {
      const confirmed = await api.ui.showConfirm(
        'This will end the agent\'s current session to start a voice conversation. Continue?'
      );
      if (!confirmed) return;
      await api.agents.kill(agent.id);
    }
    voiceState.setSelectedAgent(agent);
  }, [api]);

  const sleeping = agents.filter((a) => a.status === 'sleeping');
  const running = agents.filter((a) => a.status === 'running');

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle' },
    // Header
    React.createElement('div', {
      className: 'px-3 py-2 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-ctp-surface0',
    }, 'Agents'),

    // Scrollable list
    React.createElement('div', { className: 'flex-1 overflow-y-auto py-1' },
      // Sleeping agents (ready for voice)
      sleeping.length > 0 && React.createElement('div', { className: 'mb-2' },
        React.createElement('div', {
          className: 'px-3 py-1 text-xs text-ctp-subtext0',
        }, 'Available'),
        sleeping.map((agent) =>
          React.createElement('button', {
            key: agent.id,
            className: `w-full text-left px-3 py-3 text-sm cursor-pointer transition-colors ${
              selectedAgent?.id === agent.id
                ? 'bg-surface-1 text-ctp-text font-medium'
                : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
            }`,
            onClick: () => handleSelect(agent),
          },
            React.createElement('div', { className: 'flex items-center gap-3' },
              React.createElement('span', {
                className: 'w-2 h-2 rounded-full flex-shrink-0',
                style: { backgroundColor: agent.color },
              }),
              React.createElement('span', { className: 'truncate' },
                agent.emoji ? `${agent.emoji} ${agent.name}` : agent.name,
              ),
            ),
          ),
        ),
      ),

      // Running agents (with warning)
      running.length > 0 && React.createElement('div', { className: 'mt-2' },
        React.createElement('div', {
          className: 'px-3 py-1 text-xs text-ctp-subtext0',
        }, 'Running'),
        running.map((agent) =>
          React.createElement('button', {
            key: agent.id,
            className: `w-full text-left px-3 py-3 text-sm cursor-pointer transition-colors ${
              selectedAgent?.id === agent.id
                ? 'bg-surface-1 text-ctp-text font-medium'
                : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
            }`,
            onClick: () => handleSelect(agent),
          },
            React.createElement('div', { className: 'flex items-center gap-3' },
              React.createElement('span', {
                className: 'w-2 h-2 rounded-full flex-shrink-0',
                style: { backgroundColor: agent.color },
              }),
              React.createElement('div', { className: 'flex flex-col min-w-0' },
                React.createElement('span', { className: 'truncate' },
                  agent.emoji ? `${agent.emoji} ${agent.name}` : agent.name,
                ),
                React.createElement('span', { className: 'text-xs text-ctp-peach truncate' },
                  'Will end current session',
                ),
              ),
            ),
          ),
        ),
      ),

      // Empty state
      agents.length === 0 && React.createElement('div', {
        className: 'px-3 py-6 text-xs text-ctp-subtext0 text-center',
      }, 'No durable agents found. Create one from the Hub.'),
    ),
  );
}
