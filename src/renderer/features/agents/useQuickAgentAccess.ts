import { useEffect, useState } from 'react';
import { accessFromLegacy, type AccessLevel } from '../../../shared/agent-access';
import { useDefaultAccess } from './AccessSelect';

/**
 * Where a quick agent form's Access picker starts (#2761): the parent
 * agent's quick agent defaults when they set a level, else the app's Default
 * access. `defaultAccess` is what the form passes to spawnQuickAgent as its
 * fallback, so a level the person never changed is resolved there, the same
 * way, at spawn time.
 */
export function useQuickAgentAccess(projectPath: string | undefined, parentAgentId: string | undefined): { start: AccessLevel; defaultAccess: AccessLevel } {
  const defaultAccess = useDefaultAccess();
  const key = projectPath && parentAgentId ? `${projectPath}\u0000${parentAgentId}` : null;
  const [parent, setParent] = useState<{ key: string; level: AccessLevel | undefined } | null>(null);
  useEffect(() => {
    if (!key || !projectPath || !parentAgentId) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => window.clubhouse.agent.getDurableConfig(projectPath, parentAgentId))
      .then((config) => {
        if (cancelled) return;
        const d = config?.quickAgentDefaults;
        const level = d?.access ?? (d?.freeAgentMode !== undefined ? accessFromLegacy(d.freeAgentMode, undefined) : undefined);
        setParent({ key, level });
      })
      // telemetry-exempt: without the parent's defaults the picker starts at the Default access, which the person can see and change.
      .catch(() => { if (!cancelled) setParent({ key, level: undefined }); });
    return () => { cancelled = true; };
  }, [key, projectPath, parentAgentId]);
  const parentLevel = key && parent?.key === key ? parent.level : undefined;
  return { start: parentLevel ?? defaultAccess, defaultAccess };
}
