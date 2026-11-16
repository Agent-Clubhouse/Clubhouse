import { useState } from 'react';
import { Button } from '../../components/Button';
import { GroupProjectsHub } from './GroupProjectsHub';
import { GroupProjectWorkspace } from './GroupProjectWorkspace';
import { openGroupWorkspace } from './groupProjectsNav';
import { useGroupProjectsNavStore, type GroupProjectsView } from './groupProjectsNavStore';
import { useGroupWorkspaceBack } from './groupWorkspaceSource';
import type { GroupWorkspaceRoute } from './groupProjectRoute';

/**
 * What Group Projects shows, in the main pane (surface "main", from the app row)
 * and in Settings > Group Projects (surface "settings"): the same hub and the
 * same workspace, with no second manager. They differ only in where an open
 * group lives. The main pane keeps it in the route (groupProjectRoute.ts), so any
 * link can open it and Back can name where the person came from. Settings keeps
 * it in the page itself, so leaving Settings leaves the group, and offers Open in
 * main view.
 */
export function GroupProjectsPane({ surface }: { surface: 'main' | 'settings' }) {
  return surface === 'main' ? <MainPane /> : <SettingsPane />;
}

function MainPane() {
  const route = useGroupProjectsNavStore((s) => s.route);
  const view = useGroupProjectsNavStore((s) => s.view);
  const query = useGroupProjectsNavStore((s) => s.query);
  const setView = useGroupProjectsNavStore((s) => s.setView);
  const setQuery = useGroupProjectsNavStore((s) => s.setQuery);
  const { source, back } = useGroupWorkspaceBack();
  if (route) return <GroupProjectWorkspace groupId={route.groupId} section={route.section} source={source} onBack={back} />;
  return (
    <GroupProjectsHub
      view={view}
      onViewChange={setView}
      query={query}
      onQueryChange={setQuery}
      onOpenGroup={(groupId) => openGroupWorkspace({ groupId })}
    />
  );
}

function SettingsPane() {
  const [route, setRoute] = useState<GroupWorkspaceRoute | null>(null);
  const [view, setView] = useState<GroupProjectsView>({ kind: 'all' });
  const [query, setQuery] = useState('');
  if (route) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex-shrink-0 px-6 pt-3 flex justify-end">
          <Button onClick={() => openGroupWorkspace(route)}>Open in main view</Button>
        </div>
        <div className="min-h-0 flex-1">
          <GroupProjectWorkspace groupId={route.groupId} section={route.section} onBack={() => setRoute(null)} />
        </div>
      </div>
    );
  }
  return (
    <GroupProjectsHub view={view} onViewChange={setView} query={query} onQueryChange={setQuery} onOpenGroup={(groupId) => setRoute({ groupId })} />
  );
}
