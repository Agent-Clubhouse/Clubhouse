import { useEffect, useMemo, useState } from 'react';
import type { Project } from '../../../shared/types';
import { useProjectStore } from '../../stores/projectStore';
import { parseNamespacedId, type RemoteProject } from '../../stores/remoteProjectStore';
import { useNetworkSidebarStore } from '../../chrome/sidebar/networkSidebarStore';
import { linkGroupOf, pairKey } from '../../chrome/sidebar/networkTree';
import { useLinkSuggestions, usePairedRemoteProjects, useVisibleProjectLinks } from '../../chrome/sidebar/projectLinks';
import { Button } from '../../components/Button';
import { SettingsSection, SettingsField, SettingsBlock, settingsInput } from './SettingsLayout';

/**
 * Linked projects (#3066): the same project on another computer, shown as one
 * group in the sidebar. A shared git remote suggests a link once; any two
 * projects can be linked by hand, folders without a remote included. Linking
 * only changes how they're shown: each agent runs on its own computer, in its
 * folder, with its settings.
 */
export function LinkedProjectsSection({ projectId }: { projectId: string }) {
  const projects = useProjectStore((s) => s.projects);
  const remoteProjects = usePairedRemoteProjects();
  const links = useVisibleProjectLinks();
  const link = useNetworkSidebarStore((s) => s.link);
  const unlink = useNetworkSidebarStore((s) => s.unlink);
  const keepSeparate = useNetworkSidebarStore((s) => s.keepSeparate);
  const keptSeparate = useNetworkSidebarStore((s) => s.keptSeparate);
  const handoffLinkError = useNetworkSidebarStore((s) => s.handoffLinkError);
  const linkErrorRetryable = useNetworkSidebarStore((s) => s.linkErrorRetryable);
  const retryHandoffLinks = useNetworkSidebarStore((s) => s.retryHandoffLinks);
  const suggestions = useLinkSuggestions().filter((s) => s.local.id === projectId);
  const [choice, setChoice] = useState<{ projectId: string; targetId: string } | null>(null);

  const everyProject = useMemo<Array<Project | RemoteProject>>(
    () => [...projects, ...remoteProjects],
    [projects, remoteProjects],
  );
  const label = (p: Project | RemoteProject) => {
    const name = p.displayName || p.name;
    if ('satelliteName' in p) return p.satelliteName ? `${name} on ${p.satelliteName}` : name;
    return `${name} on this computer`;
  };
  const group = linkGroupOf(links, projectId) ?? [projectId];
  // A linked project whose computer hasn't sent its list yet (offline since a restart, say) is named as such, not by its id.
  const linked = group.filter((id) => id !== projectId).map((id) => everyProject.find((p) => p.id === id)
    ?? ({ id, name: parseNamespacedId(id) ? 'A project on a computer not connected now' : 'A project no longer here', path: '', satelliteName: '' } as Project));
  const candidates = everyProject.filter((p) => !group.includes(p.id));
  const separated = candidates.filter((p) => keptSeparate.includes(pairKey(projectId, p.id)));
  const selected = choice?.projectId === projectId ? candidates.find((p) => p.id === choice.targetId) : undefined;
  const source = projects.find((p) => p.id === projectId);
  const sourceName = source?.displayName || source?.name || 'this project';
  useEffect(() => {
    if (choice && !selected) setChoice(null);
  }, [choice, selected]);

  // Shown once another computer's projects are known, or a link exists: without a network there's nothing to link across.
  const anyRemote = remoteProjects.length > 0;
  if (linked.length === 0 && suggestions.length === 0 && separated.length === 0 && !anyRemote && !handoffLinkError) return null;

  return (
    <SettingsSection title="Linked projects">
      <p className="text-xs text-ctp-overlay1 pb-2">
        Linked projects show as one group in the sidebar and let accepted handoffs choose the matching local project. Each agent runs on its own computer, in its own folder.
      </p>
      {handoffLinkError && <div role="alert" className="text-xs text-ctp-red pb-2">Could not save project links. {linkErrorRetryable && <Button onClick={retryHandoffLinks} kind="ghost">Retry</Button>}</div>}
      {suggestions.map((s) => (
        <SettingsField
          key={s.remote.id}
          label={label(s.remote)}
          testId="linked-project-suggestion"
          help={<>Same git remote as this project. <span className="break-all">{s.remote.path}</span></>}
        >
          <Button onClick={() => link(projectId, s.remote.id)} kind="primary">Link</Button>
          <Button onClick={() => keepSeparate(projectId, s.remote.id)} kind="ghost">Keep separate</Button>
        </SettingsField>
      ))}
      {linked.map((p) => (
        <SettingsField key={p.id} label={label(p)} help={<>{p.path && <div className="break-all">{p.path}</div>}Unlink to show these projects separately and stop link suggestions for this pair.</>} testId="linked-project">
          <Button onClick={() => unlink(p.id)} kind="ghost">Unlink</Button>
        </SettingsField>
      ))}
      {separated.map((p) => (
        <SettingsField key={p.id} label={label(p)} help={<>Kept separate. You can still link these projects. <span className="break-all">{p.path}</span></>} testId="kept-separate-project">
          <Button onClick={() => link(projectId, p.id)} kind="ghost">Link instead</Button>
        </SettingsField>
      ))}
      {candidates.length > 0 && (
        <SettingsBlock>
          <label htmlFor="link-project-choice" className="block text-[13px] text-ctp-text mb-2">Link with another project</label>
          <div className="flex items-center gap-2">
            <select
              id="link-project-choice"
              value={selected?.id ?? ''}
              onChange={(e) => setChoice({ projectId, targetId: e.target.value })}
              className={`${settingsInput} flex-1 min-w-0`}
            >
              <option value="">Choose a project</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{label(p)} ({p.path})</option>)}
            </select>
            <Button onClick={() => { if (selected) { link(projectId, selected.id); setChoice(null); } }} kind="ghost" disabled={!selected}>Link</Button>
          </div>
          {selected && <p role="status" className="text-xs text-ctp-overlay1 mt-2">
            Link {sourceName} with {label(selected)} to show them as one sidebar group and use the matching local project for accepted handoffs. Each keeps its own folder and settings.
          </p>}
        </SettingsBlock>
      )}
    </SettingsSection>
  );
}
