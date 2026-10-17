import React from 'react';
import { AgentAvatar, useAgentStore, useProjectStore, useRemoteProjectStore } from './host';

/** Small pieces Review draws itself: key caps, the 18px avatar, project names, icons. */

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="min-w-[18px] h-[18px] px-1 rounded border border-surface-1 bg-ctp-mantle inline-flex items-center justify-center font-sans text-[11px] leading-none text-ctp-subtext1">
      {children}
    </kbd>
  );
}

/** An 18px avatar for a local or remote agent, the size the sidebar uses. */
export function ReviewAvatar({ agentId, size = '2xs' }: { agentId: string; size?: '2xs' | 'xs' }) {
  const local = useAgentStore((s) => s.agents[agentId]);
  const remote = useRemoteProjectStore((s) => s.remoteAgents[agentId]);
  const agent = local ?? remote;
  if (!agent) return null;
  return <span className="flex-shrink-0 flex"><AgentAvatar agent={agent} size={size} /></span>;
}

/** A project's display name, local or on a satellite. */
export function useProjectName(projectId: string | undefined): string | undefined {
  const local = useProjectStore((s) => {
    const p = projectId ? s.projects.find((x) => x.id === projectId) : undefined;
    return p ? p.displayName || p.name : undefined;
  });
  const remote = useRemoteProjectStore((s) => {
    if (!projectId || local) return undefined;
    for (const list of Object.values(s.satelliteProjects)) {
      const p = list.find((x) => x.id === projectId);
      if (p) return p.displayName || p.name;
    }
    return undefined;
  });
  return local ?? remote;
}

export const Icon = {
  chevronLeft: <path d="M15 18l-6-6 6-6" />,
  chevronRight: <path d="M9 18l6-6-6-6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  bolt: <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  branch: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-6 3-10 6" /></>,
};

export function Svg({ children, size = 14 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
