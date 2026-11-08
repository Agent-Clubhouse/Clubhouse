import { useEffect, useState } from 'react';
import { SettingsBlock, SettingsSection, settingsHelp } from '../settings/SettingsLayout';
import { managed, unwrap } from './managedApi';

const CODE_CLASS = 'font-mono text-ctp-subtext1';

/**
 * A project's Agents & providers page, Managed agents (D97): the root files
 * Clubhouse delivers are git-ignored for the whole repository while managed
 * agents need them, and this says so, with the names in effect now.
 */
export function ManagedGitExcludesSection({ projectPath }: { projectPath: string }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      unwrap(managed().projectGitExcludes(projectPath))
        .then((value) => { if (live) { setNames(value); setFailed(false); } })
        .catch(() => { if (live) setFailed(true); });
    };
    load();
    const off = managed().onChanged(load);
    return () => { live = false; off(); };
  }, [projectPath]);

  return (
    <SettingsSection title="Managed agents">
      <SettingsBlock>
        <div className="flex flex-col gap-1.5" data-testid="managed-git-excludes">
          {names && names.length > 0 ? (
            <p className={settingsHelp}>
              Git ignores these files for the whole repository, in the main checkout and every worktree, while this project has managed agents that need them:{' '}
              {names.map((n, i) => (
                <span key={n}>{i > 0 && ', '}<code className={CODE_CLASS}>{n}</code></span>
              ))}.
            </p>
          ) : (
            <p className={settingsHelp}>
              {failed ? 'Couldn\'t read which files git ignores for managed agents.' : 'Git ignores nothing for managed agents in this project right now.'}{' '}
              While a managed agent needs them, git ignores the files Clubhouse writes for it (its instructions file, its MCP file and Claude Code&apos;s <code className={CODE_CLASS}>.claude/settings.local.json</code>) for the whole repository.
            </p>
          )}
          <p className={settingsHelp}>
            Clubhouse writes these files into each managed agent&apos;s folder at every start, so ignoring them keeps agents from committing them. Your own untracked file with one of these names, at the top of the main checkout or any worktree, is hidden from <code className={CODE_CLASS}>git status</code> and <code className={CODE_CLASS}>git add .</code> too. A file of that name in a subfolder isn&apos;t ignored.
          </p>
          <p className={settingsHelp}>
            Files git already tracks aren&apos;t affected, and their changes still show and commit as usual.
          </p>
        </div>
      </SettingsBlock>
    </SettingsSection>
  );
}
