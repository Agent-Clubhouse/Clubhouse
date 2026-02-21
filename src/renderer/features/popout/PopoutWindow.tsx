import { useEffect } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { PopoutAgentView } from './PopoutAgentView';
import { PopoutHubView } from './PopoutHubView';

export function PopoutWindow() {
  const loadTheme = useThemeStore((s) => s.loadTheme);

  useEffect(() => {
    loadTheme();
  }, [loadTheme]);

  const params = window.clubhouse.window?.getPopoutParams();
  if (!params) {
    return (
      <div className="h-screen w-screen bg-ctp-base text-ctp-text flex items-center justify-center">
        <span className="text-ctp-subtext0 text-sm">Invalid pop-out configuration</span>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-ctp-base text-ctp-text flex flex-col">
      {/* Title bar drag region */}
      <div className="h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center">
        <span className="text-xs text-ctp-subtext0 select-none">
          {params.type === 'agent' ? 'Agent' : 'Hub'} — Pop-out
        </span>
      </div>
      {/* Content */}
      <div className="flex-1 min-h-0">
        {params.type === 'agent' ? (
          <PopoutAgentView agentId={params.agentId} projectId={params.projectId} />
        ) : (
          <PopoutHubView projectId={params.projectId} />
        )}
      </div>
    </div>
  );
}
