/**
 * Memory pages for the Dispatchers on this person's other computers (#3349).
 * Each known peer gets `agents/peer-<hash>.md`, keyed by its machine-qualified
 * address and titled "<name> on <machine>". Clubhouse writes the card from
 * what the controller link knows; the Dispatcher's notes under it are kept.
 * Only stable facts go in the card, so presence changes don't rewrite memory.
 */
import type { RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
import { appLog } from '../log-service';
import { readAgentPage, remoteDispatcherPageName, writeRemoteDispatcherCard } from './dispatcher-memory';

export function peerCardText(remote: RemoteDispatcherPresence & { address: string }): string {
  return [
    `${remote.dispatcherName ?? 'The Dispatcher'} is the Dispatcher on ${remote.machineName}, another computer in this person's Annex Network.`,
    `Address: ${remote.address}`,
    'Call it by its label, never by its address. list_other_dispatchers says whether it is there now.',
  ].join('\n');
}

/** Write each known peer's card when it differs. Peers that left keep their page and notes. */
export async function syncPeerPages(remotes: RemoteDispatcherPresence[], root?: string): Promise<number> {
  let written = 0;
  for (const remote of remotes) {
    if (!remote.address) continue;
    const card = peerCardText({ ...remote, address: remote.address });
    const page = await readAgentPage(remoteDispatcherPageName(remote.address), root);
    if (page?.card === card) continue;
    await writeRemoteDispatcherCard(remote.address, remote.label, card, root);
    written++;
  }
  return written;
}

/**
 * Keep peer pages current while the Dispatcher is on. Runs are serialized,
 * and a change during a run is picked up by one more run after it.
 */
export function watchPeerPages(deps: {
  remotes: () => RemoteDispatcherPresence[];
  enabled: () => boolean;
  onChanged: (listener: () => void) => () => void;
  root?: string;
}): () => void {
  let running: Promise<void> | null = null;
  let again = false;
  const run = (): void => {
    if (running) { again = true; return; }
    if (!deps.enabled()) return;
    running = syncPeerPages(deps.remotes(), deps.root).then((): void => undefined, (err: unknown): void => {
      // telemetry-exempt: logged; the next presence change writes again.
      appLog('core:dispatcher', 'warn', 'Could not update the memory pages for other computers\' Dispatchers', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }).finally(() => {
      running = null;
      if (again) { again = false; run(); }
    });
  };
  const off = deps.onChanged(run);
  run();
  return off;
}
