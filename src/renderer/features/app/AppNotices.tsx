import { useCallback, useMemo } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { PermissionViolationBanner } from '../plugins/PermissionViolationBanner';
import { PluginUpdateBanner } from '../plugins/PluginUpdateBanner';
import { UpdateBanner } from './UpdateBanner';
import { ResumeBanner, type ResumeBannerSession } from './ResumeBanner';

/**
 * The app-wide notices in the new chrome (#2014): update ready, resume
 * sessions, plugin updates and permission violations. `card` stacks them
 * above the sidebar footer; `bar` is the fallback strip while the sidebar is
 * collapsed. Render exactly one of the two at a time.
 */
export function AppNotices({ variant }: { variant: 'bar' | 'card' }) {
  const resumingAgents = useAgentStore((s) => s.resumingAgents);
  const agents = useAgentStore((s) => s.agents);
  const sessions: ResumeBannerSession[] = useMemo(() => Object.entries(resumingAgents).map(([agentId, status]) => ({
    agentId,
    agentName: agents[agentId]?.name || agentId,
    status,
  })), [resumingAgents, agents]);
  const onManualResume = useCallback((agentId: string) => {
    console.log('[ResumeBanner] Manual resume requested for agent:', agentId);
  }, []);
  const onDismiss = useCallback(() => useAgentStore.getState().clearResumingAgents(), []);

  const notices = (
    <>
      <PermissionViolationBanner variant={variant} />
      <UpdateBanner variant={variant} />
      <ResumeBanner sessions={sessions} onManualResume={onManualResume} onDismiss={onDismiss} variant={variant} />
      <PluginUpdateBanner variant={variant} />
    </>
  );

  if (variant === 'bar') return notices;
  return (
    <div
      aria-label="Notices"
      data-testid="sidebar-notices"
      className="flex-shrink-0 max-h-[50%] overflow-y-auto flex flex-col gap-2 px-2 pb-2 empty:hidden"
    >
      {notices}
    </div>
  );
}

/** The new chrome's fallback strip: the notices as bars while the sidebar (and its card) is collapsed. */
export function CollapsedSidebarNotices() {
  const collapsed = useChromeStore((s) => s.sidebarCollapsed);
  return collapsed ? <AppNotices variant="bar" /> : null;
}
