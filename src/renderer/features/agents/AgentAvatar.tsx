import { useAgentStore } from '../../stores/agentStore';
import { Agent } from '../../../shared/types';
import { getAgentColorHex } from '../../../shared/name-generator';

interface Props {
  agent: Agent;
  size?: '2xs' | 'xs' | 'sm' | 'md' | 'lg';
  showRing?: boolean;
  ringColor?: string;
  /** Override icon URL (e.g. for remote agents whose icons are in a different store) */
  iconUrl?: string;
}

const SIZE_CONFIG = {
  /** 18px, for the new chrome's 30px sidebar rows (no ring). */
  '2xs': { outer: 'w-[18px] h-[18px]', inner: 'w-[18px] h-[18px]', font: 'text-[8px]', bolt: 8 },
  xs: { outer: 'w-7 h-7', inner: 'w-5 h-5', font: 'text-[8px]', bolt: 8 },
  sm: { outer: 'w-8 h-8', inner: 'w-6 h-6', font: 'text-[9px]', bolt: 10 },
  md: { outer: 'w-9 h-9', inner: 'w-7 h-7', font: 'text-xs', bolt: 12 },
  lg: { outer: 'w-14 h-14', inner: 'w-12 h-12', font: 'text-base', bolt: 16 },
};

export function AgentAvatar({ agent, size = 'md', showRing = false, ringColor, iconUrl }: Props) {
  const bgColor = getAgentColorHex(agent.color);
  const storeIconUrl = useAgentStore((s) => s.agentIcons[agent.id]);
  const iconDataUrl = iconUrl ?? storeIconUrl;

  const s = SIZE_CONFIG[size];
  const outerSize = s.outer;
  const innerSize = s.inner;
  const fontSize = s.font;

  const renderContent = () => {
    if (agent.kind !== 'durable') {
      // Quick agent: lightning bolt
      return (
        <div className={`${innerSize} rounded-full flex items-center justify-center bg-surface-2 text-ctp-subtext0`}>
          <svg width={s.bolt} height={s.bolt} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </div>
      );
    }

    // Emoji avatar
    if (agent.emoji) {
      return (
        <div
          className={`${innerSize} rounded-full flex items-center justify-center flex-shrink-0`}
          style={{ backgroundColor: `${bgColor}20` }}
        >
          <span className={size === '2xs' ? 'text-xs' : size === 'sm' ? 'text-sm' : 'text-base'} role="img">{agent.emoji}</span>
        </div>
      );
    }

    // Image icon avatar
    if (agent.icon && iconDataUrl) {
      return (
        <div className={`${innerSize} rounded-full overflow-hidden flex-shrink-0`}>
          <img src={iconDataUrl} alt={agent.name} draggable={false} className="w-full h-full object-cover" />
        </div>
      );
    }

    // Initials on the agent color. The provider shows as the neutral
    // OrchestratorGlyph beside the model instead of a brand mascot (#2025).
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

import { agentDot, statusRingColor } from './agent-status';
export { STATUS_RING_COLORS as STATUS_RING_COLOR } from './status-colors';

export function AgentAvatarWithRing({ agent }: { agent: Agent }) {
  const detailedStatus = useAgentStore((s) => s.agentDetailedStatus);
  const detailed = detailedStatus[agent.id];
  const isWorking = agentDot(agent, detailed) === 'working';
  const ringColor = statusRingColor(agent, detailed);

  return (
    <div className={`relative flex-shrink-0 ${isWorking ? 'animate-pulse-ring' : ''}`}>
      <AgentAvatar agent={agent} size="sm" showRing ringColor={ringColor} />
    </div>
  );
}
