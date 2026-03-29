import { useAgentStore } from '../../stores/agentStore';
import { Agent, OrchestratorId } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';

/* ── Orchestrator mini icons for agent avatars ────────────────────── */

function ClaudeCodeMiniIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <rect x="20" y="20" width="12" height="10" rx="2" fill="#d4896b" />
      <rect x="68" y="20" width="12" height="10" rx="2" fill="#d4896b" />
      <rect x="20" y="27" width="60" height="38" rx="3" fill="#d4896b" />
      <rect x="10" y="36" width="10" height="14" rx="3" fill="#d4896b" />
      <rect x="80" y="36" width="10" height="14" rx="3" fill="#d4896b" />
      <path d="M 34 42 Q 38 37 42 42" stroke="#2a1f1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M 58 42 Q 62 37 66 42" stroke="#2a1f1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <rect x="24" y="65" width="9" height="14" rx="2" fill="#be7a5e" />
      <rect x="35" y="65" width="9" height="14" rx="2" fill="#be7a5e" />
      <rect x="56" y="65" width="9" height="14" rx="2" fill="#be7a5e" />
      <rect x="67" y="65" width="9" height="14" rx="2" fill="#be7a5e" />
    </svg>
  );
}

function CopilotMiniIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <ellipse cx="50" cy="42" rx="36" ry="30" fill="#1ABFAE" />
      <rect x="22" y="42" width="56" height="26" rx="10" fill="#B8C8D8" />
      <line x1="31" y1="54" x2="45" y2="54" stroke="#0a1830" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="55" y1="54" x2="69" y2="54" stroke="#0a1830" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function CodexCliMiniIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <ellipse cx="50" cy="32" rx="24" ry="20" fill="#E8E8EC" />
      <ellipse cx="50" cy="36" rx="18" ry="12" fill="#0a0a14" />
      <ellipse cx="40" cy="38" rx="5" ry="3" fill="#3a6a9a" opacity="0.4" />
      <ellipse cx="60" cy="38" rx="5" ry="3" fill="#3a6a9a" opacity="0.4" />
      <path d="M 30 50 Q 30 48 32 48 L 68 48 Q 70 48 70 50 L 63 82 Q 61 88 50 88 Q 39 88 37 82 Z" fill="#E0E0E8" />
    </svg>
  );
}

function GenericRobotMiniIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <line x1="50" y1="14" x2="50" y2="6" stroke="#5a5a6e" strokeWidth="2" strokeLinecap="round" />
      <circle cx="50" cy="5" r="3" fill="#3a3a4c" />
      <rect x="28" y="14" width="44" height="28" rx="12" fill="#6a6a7e" />
      <rect x="32" y="22" width="36" height="14" rx="5" fill="#3a3a4c" />
      <line x1="38" y1="29" x2="44" y2="29" stroke="#8a8a9e" strokeWidth="2" strokeLinecap="round" />
      <line x1="56" y1="29" x2="62" y2="29" stroke="#8a8a9e" strokeWidth="2" strokeLinecap="round" />
      <rect x="26" y="48" width="48" height="30" rx="6" fill="#5a5a6e" />
    </svg>
  );
}

function OrchestratorMiniIcon({ orchestrator, size }: { orchestrator?: OrchestratorId; size: number }) {
  switch (orchestrator) {
    case 'claude-code': return <ClaudeCodeMiniIcon size={size} />;
    case 'copilot-cli': return <CopilotMiniIcon size={size} />;
    case 'codex-cli': return <CodexCliMiniIcon size={size} />;
    default: return <GenericRobotMiniIcon size={size} />;
  }
}

interface Props {
  agent: Agent;
  size?: 'sm' | 'md';
  showRing?: boolean;
  ringColor?: string;
}

export function AgentAvatar({ agent, size = 'md', showRing = false, ringColor }: Props) {
  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const bgColor = colorInfo?.hex || '#6366f1';
  const iconDataUrl = useAgentStore((s) => s.agentIcons[agent.id]);

  const outerSize = size === 'sm' ? 'w-8 h-8' : 'w-9 h-9';
  const innerSize = size === 'sm' ? 'w-6 h-6' : 'w-7 h-7';
  const fontSize = size === 'sm' ? 'text-[9px]' : 'text-[10px]';
  const iconPx = size === 'sm' ? 24 : 28;

  const renderContent = () => {
    if (agent.kind !== 'durable') {
      // Quick agent: lightning bolt
      return (
        <div className={`${innerSize} rounded-full flex items-center justify-center bg-surface-2 text-ctp-subtext0`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </div>
      );
    }

    // Image icon avatar
    if (agent.icon && iconDataUrl) {
      return (
        <div className={`${innerSize} rounded-full overflow-hidden flex-shrink-0`}>
          <img src={iconDataUrl} alt={agent.name} className="w-full h-full object-cover" />
        </div>
      );
    }

    // Orchestrator-specific mini icon
    if (agent.orchestrator) {
      return (
        <div
          className={`${innerSize} rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center`}
          style={{ backgroundColor: bgColor }}
        >
          <OrchestratorMiniIcon orchestrator={agent.orchestrator} size={iconPx} />
        </div>
      );
    }

    // Default initials
    const initials = agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
    return (
      <div
        className={`${innerSize} rounded-full flex items-center justify-center ${fontSize} font-bold text-white`}
        style={{ backgroundColor: bgColor }}
      >
        {initials}
      </div>
    );
  };

  if (showRing && ringColor) {
    return (
      <div className="relative">
        <div
          className={`${outerSize} rounded-full flex items-center justify-center`}
          style={{ border: `2px solid ${ringColor}` }}
        >
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {renderContent()}
    </div>
  );
}

export const STATUS_RING_COLOR: Record<string, string> = {
  running: '#22c55e',
  sleeping: '#6c7086',
  waking: '#f59e0b',
  error: '#f87171',
};

export function AgentAvatarWithRing({ agent }: { agent: Agent }) {
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const detailed = detailedStatus[agent.id];
  const isWorking = agent.status === 'running' && detailed?.state === 'working';
  const baseRingColor = STATUS_RING_COLOR[agent.status] || STATUS_RING_COLOR.sleeping;
  const ringColor = agent.status === 'running' && detailed?.state === 'needs_permission' ? '#f97316'
    : agent.status === 'running' && detailed?.state === 'tool_error' ? '#facc15'
    : baseRingColor;

  return (
    <div className={`relative flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
      <AgentAvatar agent={agent} size="sm" showRing ringColor={ringColor} />
    </div>
  );
}
