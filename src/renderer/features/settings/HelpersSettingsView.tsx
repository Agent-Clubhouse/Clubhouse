/**
 * App settings, Helpers (#2232): the app-wide cap on running helpers across
 * every orchestrator, and disposed helpers no Helpers card can reach because
 * their orchestrator is gone. Each agent's own switches are in its
 * Orchestrate card and on its Helpers settings page.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DurableAgentConfig } from '../../../shared/types';
import { MAX_HELPER_LIMIT } from '../../../shared/orchestration-policy';
import { useProjectStore } from '../../stores/projectStore';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { Button } from '../../components/Button';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { orphanedDisposed } from '../agents/helpers/helper-model';
import { sameProjectPath } from '../../utils/project-path';
import { parseHelperCount, useGlobalHelperCap } from '../agents/helpers/orchestration-hooks';
import { SettingsBlock, SettingsField, SettingsPage, SettingsSection, settingsHelp, settingsInput } from './SettingsLayout';

interface OrphanRow {
  projectId: string;
  projectName: string;
  projectPath: string;
  config: DurableAgentConfig;
}

function formatWhen(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

export function HelpersSettingsView() {
  const { cap, loaded } = useGlobalHelperCap();
  const [draft, setDraft] = useState('');
  const [capError, setCapError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (loaded) setDraft(String(cap)); }, [cap, loaded]);

  const saveCap = async () => {
    const parsed = parseHelperCount(draft, MAX_HELPER_LIMIT);
    if ('error' in parsed) { setCapError(parsed.error); return; }
    setCapError(null);
    if (parsed.value === cap) return;
    setSaving(true);
    try {
      await window.clubhouse.app.saveOrchestrationSettings({ globalHelperCap: parsed.value });
    } catch (err) {
      // telemetry-exempt: shown under the field, which goes back to the saved value.
      setCapError(`Couldn’t save. ${err instanceof Error ? err.message : String(err)}`);
      setDraft(String(cap));
    } finally {
      setSaving(false);
    }
  };

  const projects = useProjectStore((s) => s.projects);
  const [orphans, setOrphans] = useState<OrphanRow[] | null>(null);
  const [removing, setRemoving] = useState<OrphanRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const local = projects.filter((p) => !isRemoteProjectId(p.id));
    Promise.all(local.map(async (p): Promise<DurableAgentConfig[] | null> => {
      try {
        const configs: DurableAgentConfig[] = await window.clubhouse.agent.listDurable(p.path);
        return configs ?? [];
      } catch {
        // telemetry-exempt: a project that can't be read lists nothing here.
        return null;
      }
    })).then((lists) => {
      if (!alive) return;
      // A helper whose orchestrator is in another project (#2514) is reachable
      // while that orchestrator is there. A project that couldn't be read
      // counts as still holding it, so nothing is listed by mistake.
      const hasParentElsewhere = (c: DurableAgentConfig) => {
        const i = local.findIndex((p) => sameProjectPath(p.path, c.parentProjectPath!));
        if (i < 0) return false;
        const other = lists[i];
        return other === null || other.some((o) => o.id === c.parentAgentId);
      };
      setOrphans(local.flatMap((p, i) => orphanedDisposed(lists[i] ?? [], hasParentElsewhere)
        .map((config) => ({ projectId: p.id, projectName: p.displayName || p.name, projectPath: p.path, config }))));
    });
    return () => { alive = false; };
  }, [projects, nonce]);

  const remove = useCallback(async (row: OrphanRow) => {
    setRemoving(null);
    setRemoveError(null);
    try {
      const result = await window.clubhouse.agent.removeDisposed(row.projectPath, row.config.id);
      if (!result.ok) setRemoveError(result.message);
    } catch (err) {
      // telemetry-exempt: shown under the list.
      setRemoveError(err instanceof Error ? err.message : String(err));
    }
    setNonce((n) => n + 1);
  }, []);

  return (
    <SettingsPage
      title="Helpers"
      description="Limits for agents that orchestrate helpers. Each agent’s own switches are in its Orchestrate card and on its Helpers settings page."
      testId="helpers-settings"
    >
      <SettingsSection title="Limits">
        <SettingsField
          label="Helpers running at once"
          htmlFor="helpers-global-cap"
          help={capError
            ? <span className="text-ctp-error" data-testid="helpers-global-cap-error">{capError}</span>
            : 'Across every orchestrator in every project. No agent can be set to more than this.'}
        >
          <input
            id="helpers-global-cap"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_HELPER_LIMIT}
            step={1}
            value={draft}
            disabled={!loaded || saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void saveCap()}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveCap(); } }}
            className={`${settingsInput} w-[70px]`}
            data-testid="helpers-global-cap"
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Disposed helpers without an orchestrator" meta={orphans && orphans.length > 0 ? String(orphans.length) : undefined}>
        <SettingsBlock>
          {orphans === null ? (
            <p className={settingsHelp}>Loading…</p>
          ) : orphans.length === 0 ? (
            <p className={settingsHelp} data-testid="helpers-orphans-empty">None. Disposed helpers show in their orchestrator’s Helpers card until you remove them.</p>
          ) : (
            <ul className="flex flex-col" data-testid="helpers-orphans">
              {orphans.map((row) => (
                <li key={`${row.projectId}:${row.config.id}`} className="h-8 flex items-center gap-2.5 text-[13px]" data-testid="helpers-orphan-row">
                  <span className="text-ctp-text truncate">{row.config.name}</span>
                  <span className="text-xs text-ctp-overlay1 truncate">{row.projectName}</span>
                  <span className="text-xs text-ctp-overlay1 whitespace-nowrap">{formatWhen(row.config.disposedAt)}</span>
                  <Button kind="quiet" className="ml-auto" onClick={() => setRemoving(row)} data-testid="helpers-orphan-remove">Remove</Button>
                </li>
              ))}
            </ul>
          )}
          {removeError && <p className="mt-1.5 text-xs text-ctp-error" role="alert">{removeError}</p>}
        </SettingsBlock>
      </SettingsSection>

      <ConfirmDestructiveAction
        open={removing !== null}
        title={`Remove ${removing?.config.name ?? ''} for good?`}
        description={`Its folder is already gone. This removes ${removing?.config.name ?? 'it'} and its session list from Clubhouse. It can’t be undone.`}
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => { if (removing) void remove(removing); }}
      />
    </SettingsPage>
  );
}
