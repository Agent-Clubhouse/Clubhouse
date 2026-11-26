/**
 * What Auto can pick for a helper right now, in one clause (#3896). The Smart
 * selection page builds its intro from it, and the fixed help lines under the
 * per-agent switch and the template's Helper selection reuse it, so none of
 * them can say Auto picks only Claude Code or Codex when Copilot is a last
 * resort (docs/helper-auto-routing.md).
 */

import { useEffect, useState } from 'react';
import { PRESET_PROVIDERS, type HelperRoutingSettings, type ProviderRoutingView } from '../../../shared/helper-routing';
import { providerDescriptor } from '../../../shared/providers/descriptors';

export const providerName = (id: string): string => providerDescriptor(id)?.shortName ?? id;

/** Preset CLIs first in PRESET_PROVIDERS order, then any others by id. */
export function orderedProviders<T>(providers: Readonly<Record<string, T>>): [string, T][] {
  const rank = (id: string) => { const i = (PRESET_PROVIDERS as readonly string[]).indexOf(id); return i < 0 ? PRESET_PROVIDERS.length : i; };
  return Object.entries(providers).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

export type Eligible = Extract<ProviderRoutingView, { autoEligible: true }>;

/** Why Auto skips a provider now, or null when it can pick it. A desktop that doesn't report state is taken as active. */
export function inactiveReason(view: Eligible): 'disabled' | 'unavailable' | 'both' | null {
  const off = view.enabled === false;
  const missing = view.available === false;
  return off && missing ? 'both' : off ? 'disabled' : missing ? 'unavailable' : null;
}

/**
 * The clause after "Clubhouse … to", such as "pick between Claude Code and
 * Codex for a helper, favoring …, with Copilot as a last resort". Null when
 * Auto has nothing it can pick.
 */
export function autoPick(providers: [string, ProviderRoutingView][], copilotAuto: boolean, resetAware = false): string | null {
  const active = providers.filter((entry): entry is [string, Eligible] => entry[1].autoEligible && entry[1].autoCandidate !== false && inactiveReason(entry[1]) === null);
  const main = active.filter(([id]) => id !== 'copilot-cli').map(([id]) => providerName(id));
  const lastResort = copilotAuto && active.some(([id]) => id === 'copilot-cli');
  if (main.length === 0) return lastResort ? 'start a helper on Copilot, the only provider turned on and available right now' : null;
  const pick = main.length > 1 ? `pick between ${main.join(' and ')} for a helper, ${resetAware ? 'preferring usable weekly budget within 48 hours of reset, especially the final 24 hours' : 'favoring the CLI that has used less of its plan limit'}` : `start a helper on ${main[0]}, the only provider ${lastResort ? 'besides Copilot ' : ''}that is turned on and available right now`;
  return `${pick}${lastResort ? ', with Copilot as a last resort' : ''}`;
}

export function autoPickFrom(settings: HelperRoutingSettings): string | null {
  return autoPick(orderedProviders(settings.providers), settings.copilotAuto !== false, settings.autoBudget?.policy?.enabled === true);
}

/**
 * The live clause, read once when a help line mounts. Undefined until it is
 * read, and when it can't be: callers then show a line that holds for any setup.
 */
export function useAutoPick(): string | null | undefined {
  const [pick, setPick] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const read = window.clubhouse?.app?.getHelperRouting;
    if (typeof read !== 'function') return undefined;
    Promise.resolve()
      .then(() => read())
      .then((settings) => { if (alive && settings?.providers) setPick(autoPickFrom(settings)); })
      .catch(() => { /* telemetry-exempt: the help line keeps its general wording. */ });
    return () => { alive = false; };
  }, []);
  return pick;
}

/** For a help line beside an Auto switch: "Let Clubhouse …", or the general wording until the live one is read. */
export function autoPickSentence(pick: string | null | undefined, lead: string): string {
  if (pick === undefined) return `${lead} pick the CLI for a helper, favoring the CLI that has used less of its plan limit. Settings › Smart routing says which CLIs it can pick.`;
  if (pick === null) return `${lead} pick the CLI for a helper, but right now it has nothing to pick. Settings › Smart routing says why.`;
  return `${lead} ${pick}.`;
}
