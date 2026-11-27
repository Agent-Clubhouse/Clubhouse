import { isAutoCandidateProvider } from '../../../shared/helper-routing';
import { providerDescriptor } from '../../../shared/providers/descriptors';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

/**
 * Whether the Orchestrators step gets its Smart routing scene (#2814, #3896).
 *
 * It shows when two or more of the CLIs Smart routing can choose are ready,
 * and at least one of them is a CLI whose plan Clubhouse can read (Claude Code
 * or Codex). Without one of those, Smart routing has nothing to balance on.
 * So Claude Code with Copilot gets the scene, and Copilot alone doesn't.
 * Antigravity isn't a choice while it's opt-in with no presets, so it never
 * counts. With one CLI, Smart routing stays a card in Also new.
 *
 * Clubhouse has no sign-in check of its own, and the tour must not make one:
 * no undocumented quota reads, no scraping /usage, no prompt. So "ready" is
 * what the app already knows: the CLI is installed on this computer and turned
 * on in Settings › Agents & CLIs, and, for Copilot, allowed for Smart routing.
 * Installed but signed out still counts; Smart routing itself copes with that.
 */

export interface CliReadiness {
  id: string;
  /** Its binary was found (checkAvailability). */
  installed: boolean;
  /** Turned on in Settings › Agents & CLIs. */
  turnedOn: boolean;
}

export function smartRoutingSceneShows(clis: readonly CliReadiness[], options: { copilotAllowed: boolean }): boolean {
  const ready = clis.filter((cli) => {
    if (!isAutoCandidateProvider(cli.id) || !cli.installed || !cli.turnedOn) return false;
    const routing = providerDescriptor(cli.id)?.helperRouting;
    if (!routing || routing.auto !== 'candidate') return false;
    // Copilot can be turned off for Smart routing alone.
    return routing.allowSetting !== 'copilotAuto' || options.copilotAllowed;
  });
  return ready.length >= 2 && ready.some((cli) => providerDescriptor(cli.id)?.helperRouting.quota === 'reader');
}

/**
 * Read the same signals the app already keeps for its CLI list: no CLI is
 * started, and nothing is asked of any plan. Never throws; anything unreadable
 * leaves the scene out.
 */
export async function readSmartRoutingScene(): Promise<boolean> {
  try {
    const store = useOrchestratorStore.getState();
    if (store.allOrchestrators.length === 0) await store.loadSettings();
    await useOrchestratorStore.getState().checkAllAvailability();
    const { allOrchestrators, availability, enabled } = useOrchestratorStore.getState();
    let copilotAllowed = true;
    try {
      const orchestration = await window.clubhouse.app.getOrchestrationSettings() as { copilotAuto?: unknown } | null;
      copilotAllowed = orchestration?.copilotAuto !== false;
    } catch {
      // telemetry-exempt: unread, Copilot is allowed, as it is unless saved off.
    }
    return smartRoutingSceneShows(
      allOrchestrators.map((o) => ({ id: o.id, installed: availability[o.id]?.available === true, turnedOn: enabled.includes(o.id) })),
      { copilotAllowed },
    );
  } catch {
    // telemetry-exempt: the Orchestrators step keeps its one scene.
    return false;
  }
}
