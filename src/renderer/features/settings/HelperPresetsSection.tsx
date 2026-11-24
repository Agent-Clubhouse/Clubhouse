/**
 * Settings > Smart selection (#3186): the model and effort a difficulty picks on each CLI
 * (#2671). A choice is checked against the CLI's list when it's saved and each
 * time it's used. One no longer offered stays saved and shows what is used
 * instead, with Reset. These are starting choices, not measured best ones.
 * Minimum and maximum (#3044) follow Easy and Hard until a person picks one.
 * A model whose list reports no effort levels (Copilot's can, #3085) shows that
 * in the effort column instead of a select.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AUTO_LEVEL_FOLLOWS,
  AUTO_LEVELS,
  isAutoBoundLevel,
  PRESET_PROVIDERS,
  quotaRefetchDelaySeconds,
  type AutoLevel,
  type HelperRoutingSettings,
  type HelperRoutingUpdate,
  type PresetCellView,
  type ProviderRoutingView,
  type QuotaView,
} from '../../../shared/helper-routing';
import { defaultAutoBudgetPolicy, isAutoReserveProvider } from '../../../shared/helper-auto-budget';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { SettingsBlock, SettingsSection, settingsHelp, settingsInput } from './SettingsLayout';
import { providerDescriptor } from '../../../shared/providers/descriptors';

const providerName = (id: string): string => providerDescriptor(id)?.shortName ?? id;

const LEVEL_NAMES: Record<AutoLevel, string> = { minimum: 'Minimum', easy: 'Easy', medium: 'Medium', hard: 'Hard', maximum: 'Maximum' };
/** The model select's value for a minimum or maximum with no choice of its own. */
const FOLLOW = '';

/** Preset CLIs first in PRESET_PROVIDERS order, then any others by id. */
export function orderedProviders<T>(providers: Readonly<Record<string, T>>): [string, T][] {
  const rank = (id: string) => { const i = (PRESET_PROVIDERS as readonly string[]).indexOf(id); return i < 0 ? PRESET_PROVIDERS.length : i; };
  return Object.entries(providers).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Why Auto skips a provider now, or null when it can pick it. A desktop that doesn't report state is taken as active. */
function inactiveReason(view: Eligible): 'disabled' | 'unavailable' | 'both' | null {
  const off = view.enabled === false;
  const missing = view.available === false;
  return off && missing ? 'both' : off ? 'disabled' : missing ? 'unavailable' : null;
}

function inactiveNote(name: string, reason: 'disabled' | 'unavailable' | 'both'): string {
  const why = reason === 'disabled' ? 'turned off in Agents & providers'
    : reason === 'unavailable' ? 'not available on this computer'
      : 'turned off in Agents & providers and not available on this computer';
  return `${name} is ${why}. Its presets are saved for later, and Auto does not pick it until that changes.`;
}

function statusText(view: Eligible): string | null {
  if (view.enabled === undefined && view.available === undefined) return null;
  return [view.enabled === undefined ? null : view.enabled ? 'Enabled' : 'Disabled', view.available === undefined ? null : view.available ? 'Available' : 'Unavailable']
    .filter(Boolean).join(', ');
}

/** What Auto can pick from now, in the page's intro. */
function autoIntro(providers: [string, ProviderRoutingView][], copilotAuto: boolean, resetAware = false): string {
  const active = providers.filter((entry): entry is [string, Eligible] => entry[1].autoEligible && entry[1].autoCandidate !== false && inactiveReason(entry[1]) === null);
  const main = active.filter(([id]) => id !== 'copilot-cli').map(([id]) => providerName(id));
  const lastResort = copilotAuto && active.some(([id]) => id === 'copilot-cli');
  const tail = ' It balances plan use, not cost, and a helper stays on its provider for its whole task. An orchestrator’s own switch wins, and a project can turn it off.';
  if (main.length === 0 && !lastResort) return `Auto has nothing to pick right now. No provider is turned on and available, and Copilot is not allowed as a last resort.${tail}`;
  if (main.length === 0) return `Lets an orchestrator ask Clubhouse to start a helper on Copilot, the only provider turned on and available right now.${tail}`;
  const pick = main.length > 1 ? `pick between ${main.join(' and ')} for a helper, ${resetAware ? 'preferring usable weekly budget within 48 hours of reset, especially the final 24 hours' : 'favoring the CLI that has used less of its plan limit'}` : `start a helper on ${main[0]}, the only provider ${lastResort ? 'besides Copilot ' : ''}that is turned on and available right now`;
  return `Lets an orchestrator ask Clubhouse to ${pick}${lastResort ? ', with Copilot as a last resort' : ''}.${tail}`;
}

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
  difficulty: AutoLevel;
  view: Eligible;
  labels: HelperRoutingSettings['labels'];
  busy: boolean;
  onSave: (model: string, effort: string | null) => void;
  onReset: () => void;
}) {
  const cell = view.cells[difficulty];
  // Minimum and maximum offer "Same as" the difficulty they follow, selected while they have no choice of their own.
  const follows = isAutoBoundLevel(difficulty) ? AUTO_LEVEL_FOLLOWS[difficulty] : null;
  const following = follows && !cell.custom ? follows : null;
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
        <span className="w-16 text-ctp-text">{LEVEL_NAMES[difficulty]}</span>
        <select
          aria-label={`${providerName(provider)} ${difficulty} model`}
          className={`${settingsInput} min-w-0 flex-1`}
          disabled={busy}
          value={following ? FOLLOW : shown.model}
          onChange={(e) => {
            if (e.target.value === FOLLOW) { onReset(); return; }
            const next = view.choices.models.find((m) => m.id === e.target.value);
            // Keep the level if the new model takes it, else let its CLI pick.
            onSave(e.target.value, shown.effort && next?.efforts.includes(shown.effort) ? shown.effort : null);
          }}
          data-testid={`${testId}-model`}
        >
          {follows && (
            <option value={FOLLOW}>
              {`Same as ${LEVEL_NAMES[follows]}${following && cell.effective ? ` (${models.find((m) => m.id === cell.effective!.model)?.label ?? cell.effective.model})` : ''}`}
            </option>
          )}
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {efforts.length === 0 ? (
          <span
            className="w-24 text-xs text-ctp-overlay1"
            title="This model's list reports no effort levels, so its CLI picks."
            data-testid={`${testId}-effort-none`}
          >
            No effort levels
          </span>
        ) : (
          <select
            aria-label={`${providerName(provider)} ${difficulty} effort`}
            className={`${settingsInput} w-24`}
            disabled={busy}
            value={shown.effort ?? ''}
            onChange={(e) => onSave(shown.model, e.target.value || null)}
            data-testid={`${testId}-effort`}
          >
            <option value="">Default</option>
            {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        )}
        <Button kind="quiet" disabled={busy || !cell.custom} onClick={onReset} data-testid={`${testId}-reset`}>Reset</Button>
      </div>
      {note && <p className="mt-0.5 ml-[74px] text-xs text-ctp-overlay1" data-testid={`${testId}-note`}>{note}</p>}
    </li>
  );
}

/**
 * `title`, `autoLabel` and `footer` let the Smart selection page (#2899, #3186)
 * name it. Unset, it reads as it always has.
 */
export function HelperPresetsSection({ title = 'Presets by difficulty', autoLabel = 'Auto provider', toggleText, footer }: {
  title?: string;
  autoLabel?: string;
  /** Visible text beside the switch, when the section title already names it. Defaults to `autoLabel`. */
  toggleText?: string;
  footer?: ReactNode;
} = {}) {
  const [settings, setSettings] = useState<HelperRoutingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  const [refetches, setRefetches] = useState(0);
  /** Moves around Check again, so a timed read that overlapped it can't put back what it replaced. */
  const checkEpoch = useRef(0);

  useEffect(() => {
    let alive = true;
    const epoch = checkEpoch.current;
    const current = () => alive && epoch === checkEpoch.current;
    window.clubhouse.app.getHelperRouting().then(
      (loaded) => { if (current()) setSettings(loaded); },
      // telemetry-exempt: shown on the page.
      (err: unknown) => { if (current()) setError(`Couldn’t read the presets. ${err instanceof Error ? err.message : String(err)}`); },
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

  const checkAgain = useCallback(async () => {
    checkEpoch.current++;
    setBusy(true);
    setChecking(true);
    setError(null);
    try {
      setSettings(await window.clubhouse.app.getHelperRouting({ refresh: true }));
    } catch (err) {
      // telemetry-exempt: shown on the page.
      setError(`Couldn’t check again. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      checkEpoch.current++;
      setChecking(false);
      setBusy(false);
    }
  }, []);

  // A fixed order (#3186): picking a model must not move the section being edited.
  const providers = settings ? orderedProviders(settings.providers) : [];
  return (
    <SettingsSection title={title}>
      <SettingsBlock>
        {settings && (
          <label className="flex items-center gap-2.5 text-[13px] text-ctp-text mb-1.5">
            <Toggle
              checked={settings.auto.scopes.app.value}
              disabled={busy}
              onChange={(on) => void update({ auto: on })}
              aria-label={`Let orchestrators use ${autoLabel}`}
              data-testid="helper-presets-auto"
            />
            <span>{toggleText ?? autoLabel}</span>
          </label>
        )}
        {settings && (
          <p className={settingsHelp}>
            {autoIntro(providers, settings.copilotAuto !== false, settings.autoBudget?.policy?.enabled === true)}
          </p>
        )}
        {settings?.autoBudget && (
          <div className="mt-2" data-testid="helper-budget-policy">
            <label className="flex items-center gap-2.5 text-[13px] text-ctp-text">
              <Toggle
                checked={settings.autoBudget.policy?.enabled === true}
                disabled={busy || !settings.autoBudget.editable}
                aria-label="Prefer useful work before quota resets"
                data-testid="helper-budget-enabled"
                onChange={(enabled) => void update({ autoBudgetPolicy: { ...(settings.autoBudget!.policy ?? defaultAutoBudgetPolicy()), enabled } })}
              />
              <span>Prefer useful work before quota resets</span>
            </label>
            <p className={settingsHelp}>
              For new Auto helpers, prefer eligible weekly budget within 48 hours of reset, with stronger priority in the final 24 hours. Uses your existing tasks and mapped models. Does not enable Auto itself.
            </p>
            <p className={settingsHelp}>
              Reserves apply to each provider’s shared local login across orchestrators and every applicable reported window. Auto stops admitting at the threshold; running or outside work can still use more. Reserves never relax automatically. Burn pace is not measured.
            </p>
            {settings.autoBudget.invalid && (
              <p className="text-xs text-ctp-error" role="alert">The saved budget policy could not be read. Auto starts are paused. Choose this preference again, or turn it off, to save a valid policy.</p>
            )}
            {settings.autoBudget.invalid && (
              <Button kind="quiet" disabled={busy || !settings.autoBudget.editable}
                onClick={() => void update({ autoBudgetPolicy: { ...defaultAutoBudgetPolicy(), enabled: false } })}>Use legacy selection</Button>
            )}
          </div>
        )}
        <p className={settingsHelp}>
          An orchestrator can name a difficulty instead of a model. These are what it picks on each CLI. They are starting choices, so change them to suit your work. Anything an orchestrator names itself still wins.
        </p>
        <p className={settingsHelp}>
          Minimum and Maximum are the cheapest and strongest choices on each CLI, for Clubhouse’s own background work. Until you pick one, they use Easy and Hard.
        </p>
        <div className="mt-1.5 flex items-center gap-2.5">
          <p className={`${settingsHelp} min-w-0 flex-1`}>Asks each CLI again for its models and limits, for after you sign in.</p>
          <Button kind="quiet" disabled={busy} aria-busy={checking} onClick={() => void checkAgain()} data-testid="helper-presets-check-again">
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        </div>
        {!settings && !error && <p className={settingsHelp}>Loading…</p>}
        {providers.map(([provider, view]) => (
          view.autoEligible ? (
            <div key={provider} className="mt-2" data-testid={`helper-presets-${provider}`}>
              <div className="flex items-center gap-2 text-xs text-ctp-overlay1">
                <span>{providerName(provider)}</span>
                {statusText(view) && <span data-testid={`helper-presets-${provider}-status`}>{statusText(view)}</span>}
                {view.choices.source === 'fallback' && <span>Model list may be out of date</span>}
                <Button
                  kind="quiet"
                  className="ml-auto"
                  disabled={busy || !AUTO_LEVELS.some((level) => view.cells[level]?.custom)}
                  onClick={() => void update({ reset: { provider } })}
                  data-testid={`helper-presets-${provider}-reset`}
                >
                  Reset all
                </Button>
              </div>
              <p className="mt-0.5 text-xs text-ctp-overlay1" data-testid={`helper-presets-${provider}-quota`}>
                {quotaLine(view.quota, settings!)} Limits for one model aren’t included.
              </p>
              {settings?.autoBudget?.policy?.enabled && isAutoReserveProvider(provider) && (
                <label className="mt-1 flex items-center gap-2.5 text-[13px] text-ctp-text">
                  <span>Keep for me (%)</span>
                  <select className={`${settingsInput} w-24`}
                    value={settings.autoBudget.policy.reserves[provider]}
                    disabled={busy || !settings.autoBudget.editable}
                    aria-label={`${providerName(provider)} retained reserve percent`}
                    data-testid={`helper-budget-${provider}`}
                    onChange={(event) => void update({ autoBudgetPolicy: { ...settings.autoBudget!.policy!,
                      reserves: { ...settings.autoBudget!.policy!.reserves, [provider]: Number(event.target.value) } } })}
                  >
                    {Array.from({ length: 101 }, (_, value) => <option key={value} value={value}>{value}%</option>)}
                  </select>
                </label>
              )}
              {provider === 'copilot-cli' && view.autoCandidate && (
                <>
                  <label className="mt-1 flex items-center gap-2.5 text-[13px] text-ctp-text">
                    <Toggle
                      checked={settings!.copilotAuto !== false}
                      disabled={busy}
                      onChange={(on) => void update({ copilotAuto: on })}
                      aria-label="Allow Copilot as Auto's last resort"
                      data-testid="helper-presets-copilot-auto"
                    />
                    <span>Allow Copilot as a last resort</span>
                  </label>
                  <p className="mt-0.5 text-xs text-ctp-overlay1">
                    Copilot's quota is unknown. Auto picks it only when no other provider is eligible, even if another provider's limit is low or its usage could not be checked.
                  </p>
                </>
              )}
              {inactiveReason(view) && view.autoCandidate !== false && (
                <p className="mt-0.5 text-xs text-ctp-overlay1" data-testid={`helper-presets-${provider}-inactive`}>
                  {inactiveNote(providerName(provider), inactiveReason(view)!)}
                </p>
              )}
              {view.autoCandidate === false && (
                <p className="mt-0.5 text-xs text-ctp-overlay1" data-testid={`helper-presets-${provider}-not-candidate`}>
                  {autoLabel} doesn’t pick {providerName(provider)}. These are used when a helper on {providerName(provider)} names a level.
                </p>
              )}
              <ul className="flex flex-col">
                {AUTO_LEVELS.filter((level) => view.cells[level]).map((difficulty) => (
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
        {footer && <p className={`${settingsHelp} mt-2`} data-testid="helper-presets-footer">{footer}</p>}
      </SettingsBlock>
    </SettingsSection>
  );
}
