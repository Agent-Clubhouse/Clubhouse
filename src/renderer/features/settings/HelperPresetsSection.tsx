/**
 * Settings > Helpers: the model and effort a difficulty picks on each CLI
 * (#2671). A choice is checked against the CLI's list when it's saved and each
 * time it's used. One no longer offered stays saved and shows what is used
 * instead, with Reset. These are starting choices, not measured best ones.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  HELPER_DIFFICULTIES,
  quotaRefetchDelaySeconds,
  type HelperDifficulty,
  type HelperRoutingSettings,
  type HelperRoutingUpdate,
  type PresetCellView,
  type ProviderRoutingView,
  type QuotaView,
} from '../../../shared/helper-routing';
import { Button } from '../../components/Button';
import { SettingsBlock, SettingsSection, settingsHelp, settingsInput } from './SettingsLayout';

const PROVIDER_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex' };
const DIFFICULTY_NAMES: Record<HelperDifficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

type Eligible = Extract<ProviderRoutingView, { autoEligible: true }>;

function ago(asOf: string, serverTime: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(serverTime) - Date.parse(asOf)) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} hr ago`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** A provider's limits in one line. Unknown is never worded as available. */
function quotaLine(quota: QuotaView, settings: HelperRoutingSettings): string {
  const { labels, serverTime } = settings;
  const checked = quota.asOf ? ` Checked ${ago(quota.asOf, serverTime)}.` : '';
  if (quota.state === 'unknown') {
    const why = quota.unknownReason ? `${(labels.unknown as Record<string, string>)[quota.unknownReason] ?? labels.generic.unknownCode}.` : '';
    return `Plan limit unknown. ${why}${checked}`;
  }
  const limit = quota.limitingWindow === 'weekly' ? quota.weekly : quota.limitingWindow === 'fiveHour' ? quota.fiveHour : null;
  const which = quota.limitingWindow === 'weekly' || quota.limitingWindow === 'fiveHour' ? labels.window[quota.limitingWindow] : labels.window.other;
  const used = limit?.usedPercent != null ? ` ${limit.usedPercent}% used.` : '';
  const reset = quota.resetsAt ? ` Resets ${when(quota.resetsAt)}.` : '';
  return `${labels.quota[quota.state]}.${' '}${which}${used ? `:${used}` : '.'}${reset}${checked}`;
}

/** A sentence for a cell that isn't plainly fine. */
function cellNote(cell: PresetCellView, labels: HelperRoutingSettings['labels']): string | null {
  if (cell.state === 'stale') {
    return cell.effective
      ? `${labels.cell.stale}. Using ${cell.effective.model} until you change it.`
      : `${labels.cell.stale}. Starts with this difficulty are refused until you change it.`;
  }
  return cell.state === 'unverified' ? `${labels.cell.unverified}. The model list may be out of date.` : null;
}

function PresetRow({ provider, difficulty, view, labels, busy, onSave, onReset }: {
  provider: string;
  difficulty: HelperDifficulty;
  view: Eligible;
  labels: HelperRoutingSettings['labels'];
  busy: boolean;
  onSave: (model: string, effort: string | null) => void;
  onReset: () => void;
}) {
  const cell = view.cells[difficulty];
  const shown = cell.custom ?? cell.effective ?? cell.builtin;
  const listed = view.choices.models.find((m) => m.id === shown.model);
  const models = listed ? view.choices.models : [{ id: shown.model, label: shown.model, efforts: shown.effort ? [shown.effort] : [] }, ...view.choices.models];
  // What's saved or in use is always an option, or the select would show Default while starts use it.
  const efforts = [...new Set([...(listed?.efforts ?? []), ...(shown.effort ? [shown.effort] : [])])];
  const note = cellNote(cell, labels);
  const testId = `helper-preset-${provider}-${difficulty}`;
  return (
    <li className="py-1" data-testid={testId}>
      <div className="flex items-center gap-2.5 text-[13px]">
        <span className="w-16 text-ctp-text">{DIFFICULTY_NAMES[difficulty]}</span>
        <select
          aria-label={`${PROVIDER_NAMES[provider] ?? provider} ${difficulty} model`}
          className={`${settingsInput} min-w-0 flex-1`}
          disabled={busy}
          value={shown.model}
          onChange={(e) => {
            const next = view.choices.models.find((m) => m.id === e.target.value);
            // Keep the level if the new model takes it, else let its CLI pick.
            onSave(e.target.value, shown.effort && next?.efforts.includes(shown.effort) ? shown.effort : null);
          }}
          data-testid={`${testId}-model`}
        >
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <select
          aria-label={`${PROVIDER_NAMES[provider] ?? provider} ${difficulty} effort`}
          className={`${settingsInput} w-24`}
          disabled={busy || efforts.length === 0}
          value={shown.effort ?? ''}
          onChange={(e) => onSave(shown.model, e.target.value || null)}
          data-testid={`${testId}-effort`}
        >
          <option value="">Default</option>
          {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
        <Button kind="quiet" disabled={busy || !cell.custom} onClick={onReset} data-testid={`${testId}-reset`}>Reset</Button>
      </div>
      {note && <p className="mt-0.5 ml-[74px] text-xs text-ctp-overlay1" data-testid={`${testId}-note`}>{note}</p>}
    </li>
  );
}

export function HelperPresetsSection() {
  const [settings, setSettings] = useState<HelperRoutingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [refetches, setRefetches] = useState(0);

  useEffect(() => {
    let alive = true;
    window.clubhouse.app.getHelperRouting().then(
      (loaded) => { if (alive) setSettings(loaded); },
      // telemetry-exempt: shown on the page.
      (err: unknown) => { if (alive) setError(`Couldn’t read the presets. ${err instanceof Error ? err.message : String(err)}`); },
    );
    return () => { alive = false; };
  }, [refetches]);

  // While the page is open, read again when the limits would be new: never for a page nobody is looking at.
  const refetchAfter = settings ? quotaRefetchDelaySeconds(settings.providers) : null;
  useEffect(() => {
    if (refetchAfter === null) return undefined;
    const timer = setTimeout(() => setRefetches((n) => n + 1), refetchAfter * 1000);
    return () => clearTimeout(timer);
  }, [refetchAfter, settings]);

  const update = useCallback(async (change: Omit<HelperRoutingUpdate, 'revision'>) => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.clubhouse.app.updateHelperRouting({ ...change, revision: settings.revision });
      if (result.ok === false) setError(result.message);
      if (result.settings) setSettings(result.settings);
    } catch (err) {
      // telemetry-exempt: shown on the page; main records refusals.
      setError(`Couldn’t save. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [settings]);

  const providers = settings ? Object.entries(settings.providers) : [];
  return (
    <SettingsSection title="Presets by difficulty">
      <SettingsBlock>
        <p className={settingsHelp}>
          An orchestrator can name a difficulty instead of a model. These are what it picks on each CLI. They are starting choices, so change them to suit your work. Anything an orchestrator names itself still wins.
        </p>
        {!settings && !error && <p className={settingsHelp}>Loading…</p>}
        {providers.map(([provider, view]) => (
          view.autoEligible ? (
            <div key={provider} className="mt-2" data-testid={`helper-presets-${provider}`}>
              <div className="flex items-center gap-2 text-xs text-ctp-overlay1">
                <span>{PROVIDER_NAMES[provider] ?? provider}</span>
                {view.choices.source === 'fallback' && <span>Model list may be out of date</span>}
                <Button
                  kind="quiet"
                  className="ml-auto"
                  disabled={busy || !HELPER_DIFFICULTIES.some((d) => view.cells[d].custom)}
                  onClick={() => void update({ reset: { provider } })}
                  data-testid={`helper-presets-${provider}-reset`}
                >
                  Reset all
                </Button>
              </div>
              <p className="mt-0.5 text-xs text-ctp-overlay1" data-testid={`helper-presets-${provider}-quota`}>
                {quotaLine(view.quota, settings!)} Limits for one model aren’t included.
              </p>
              <ul className="flex flex-col">
                {HELPER_DIFFICULTIES.map((difficulty) => (
                  <PresetRow
                    key={difficulty}
                    provider={provider}
                    difficulty={difficulty}
                    view={view}
                    labels={settings!.labels}
                    busy={busy}
                    onSave={(model, effort) => void update({ cells: [{ provider, difficulty, model, effort }] })}
                    onReset={() => void update({ reset: { provider, difficulty } })}
                  />
                ))}
              </ul>
            </div>
          ) : null
        ))}
        {error && <p className="mt-1.5 text-xs text-ctp-error" role="alert" data-testid="helper-presets-error">{error}</p>}
      </SettingsBlock>
    </SettingsSection>
  );
}
