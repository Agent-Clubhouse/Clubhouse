import { useState, useRef, useEffect } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';
import { MODEL_OPTIONS } from '../../../shared/models';

interface Props {
  notePath: string;
  noteContent: string;
  onClose: () => void;
}

export function SendToAgentDialog({ notePath, noteContent, onClose }: Props) {
  const agents = useAgentStore((s) => s.agents);
  const spawnQuickAgent = useAgentStore((s) => s.spawnQuickAgent);
  const spawnDurableAgent = useAgentStore((s) => s.spawnDurableAgent);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const { projects, activeProjectId } = useProjectStore();
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const [instruction, setInstruction] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [useQuickAgent, setUseQuickAgent] = useState(false);
  const [quickModel, setQuickModel] = useState('default');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const durableAgents = Object.values(agents).filter(
    (a) => a.kind === 'durable' && a.projectId === activeProjectId
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const canSend = instruction.trim() && (selectedAgentId || useQuickAgent) && !sending;

  const formatMessage = () => {
    return `${instruction.trim()}\n\n<note-content path="${notePath}">\n${noteContent}\n</note-content>`;
  };

  const handleSend = async () => {
    if (!canSend || !activeProject || !activeProjectId) return;
    setSending(true);

    try {
      if (useQuickAgent) {
        const agentId = await spawnQuickAgent(activeProjectId, activeProject.path, formatMessage(), quickModel);
        setActiveAgent(agentId);
      } else if (selectedAgentId) {
        const agent = agents[selectedAgentId];
        if (!agent) return;

        if (agent.status === 'sleeping' || agent.status === 'error') {
          await spawnDurableAgent(agent.projectId, activeProject.path, {
            id: agent.id,
            name: agent.name,
            color: agent.color,
            localOnly: agent.localOnly,
            branch: agent.branch || '',
            worktreePath: agent.worktreePath || '',
            createdAt: '',
            overrides: { claudeMd: false, permissions: false, mcpConfig: false, skills: false, agents: false },
            quickOverrides: { claudeMd: false, permissions: false, mcpConfig: false, skills: false, agents: false },
            quickConfigLayer: {},
          }, true);
          // Give the agent a moment to start before writing
          await new Promise((r) => setTimeout(r, 1500));
        }

        window.clubhouse.pty.write(selectedAgentId, formatMessage() + '\n');
        setActiveAgent(selectedAgentId);
      }

      setExplorerTab('agents');
      onClose();
    } catch {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[420px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ctp-text mb-3">Send to Agent</h2>

        <textarea
          ref={textareaRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="What should the agent do with this note?"
          className="w-full px-3 py-2 text-sm rounded-lg border border-surface-0
            bg-ctp-base text-ctp-text placeholder:text-ctp-overlay0
            focus:outline-none focus:border-indigo-500 resize-none mb-3"
          rows={3}
        />

        {durableAgents.length > 0 && (
          <div className="space-y-1 mb-3">
            <p className="text-xs text-ctp-subtext0 mb-1">Durable agents</p>
            {durableAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => { setSelectedAgentId(agent.id); setUseQuickAgent(false); }}
                className={`w-full text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer
                  flex items-center gap-3 ${
                  selectedAgentId === agent.id && !useQuickAgent
                    ? 'border-indigo-500 bg-indigo-500/10'
                    : 'border-surface-0 hover:border-surface-2 hover:bg-surface-0'
                }`}
              >
                <AgentAvatarWithRing agent={agent} />
                <span className="text-sm text-ctp-text truncate flex-1">{agent.name}</span>
                <span className="text-xs text-ctp-subtext0">{agent.status}</span>
              </button>
            ))}
          </div>
        )}

        {durableAgents.length > 0 && (
          <div className="border-t border-surface-0 my-3" />
        )}

        <button
          onClick={() => { setUseQuickAgent(true); setSelectedAgentId(null); }}
          className={`w-full text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer
            text-sm mb-2 ${
            useQuickAgent
              ? 'border-indigo-500 bg-indigo-500/10 text-ctp-text'
              : 'border-surface-0 hover:border-surface-2 hover:bg-surface-0 text-ctp-subtext1 hover:text-ctp-text'
          }`}
        >
          + Quick Agent
        </button>

        {useQuickAgent && (
          <div className="mb-3">
            <select
              value={quickModel}
              onChange={(e) => setQuickModel(e.target.value)}
              className="px-2 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
                text-ctp-text focus:outline-none focus:border-indigo-500"
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
              hover:bg-surface-2 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="px-4 py-1.5 text-xs rounded bg-indigo-500/80 text-white
              hover:bg-indigo-500 cursor-pointer font-medium
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
