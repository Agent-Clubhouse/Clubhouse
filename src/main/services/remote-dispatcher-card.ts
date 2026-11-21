/** Selected Dispatcher relationship display only; never initializes or creates a Dispatcher. */
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { cardStatus, cardSummary, dispatcherName } from '../../shared/dispatcher-card-presentation';
import { reachSummary } from '../../shared/dispatcher-card-model';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import { resolveAgentConfigTarget, type AgentConfigTarget } from './agent-config-reader';
import { captureReadOnlyConfigTargetWitness } from './read-only-config-target';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { getDispatcherAgentId } from './dispatcher/dispatcher-service';
import { getDispatcherPath } from './dispatcher/dispatcher-paths';
import { readDispatcherEnablementForDisplay } from './dispatcher/dispatcher-settings';
import { readAgentCardViewForDisplay } from './dispatcher/dispatcher-agent-card-source';
import { readAgentReachForDisplay } from './agent-grants-service';
import { display, row } from './remote-details-presentation';

/** One admission reused by the selected relationship and canonical wires read.
 * Related config and private receipts stay on the host; only named safe fields are projected. */
export function dispatcherControllerForDisplay(options: { receipts: DisplayReceipt[]; authorized: () => boolean }): () => Promise<AgentConfigTarget | undefined> {
  let admitted: Promise<AgentConfigTarget | undefined> | undefined;
  return () => admitted ??= (async () => {
    const id = getDispatcherAgentId(), folder = getDispatcherPath();
    const role = { current: () => getDispatcherAgentId() === id && getDispatcherPath() === folder };
    options.receipts.push(role);
    if (!options.authorized() || !id || id.length > 2048) return undefined;
    try {
      const target = await resolveAgentConfigTarget(id, undefined, { strict: true });
      if (!options.authorized() || !role.current()) return undefined;
      // The trusted resolver supports legacy names elsewhere; this display read
      // requires the exact canonical cached role and its fixed primary folder.
      if (target.agent.id !== id || target.project.id !== DISPATCHER_PROJECT_ID || target.project.path !== folder || isDisposedAgent(target.agent)) return undefined;
      const receipt = captureReadOnlyConfigTargetWitness(target);
      options.receipts.push(receipt);
      return receipt.current() ? target : undefined;
    } catch { return undefined; /* telemetry-exempt: no raw inventory errors or fallback discovery. */ }
  })();
}

export async function readDispatcherCard(c: RemoteDetailsCard, selected: AgentConfigTarget, connected: DisplayValue<boolean>, options: {
  receipts: DisplayReceipt[]; authorized: () => boolean; controller: () => Promise<AgentConfigTarget | undefined>;
}): Promise<void> {
  const enablement = readDispatcherEnablementForDisplay(options);
  if (enablement.enabled.state === 'ok' && !enablement.enabled.value) { c.state = 'not-applicable'; return; }
  if (enablement.enabled.state !== 'ok') {
    c.state = 'error'; c.notes.push('Dispatcher availability is unavailable from host metadata. Known relationship fields are shown.');
  }
  const controller = await options.controller();
  if (!options.authorized()) return;
  const name = dispatcherName(controller ? { config: controller.agent } : undefined);
  c.title = display(name);
  if (!controller) c.notes.push('The host Dispatcher’s current identity, name and permissions are unavailable.');
  row(c, 'Connected', connected.state === 'ok' ? connected.value ? 'On' : 'Off' : 'Unavailable from host metadata');
  if (connected.state !== 'ok') { c.state = 'error'; c.summary = 'Connection policy unavailable'; return; }
  c.summary = cardSummary('off', name);
  if (!connected.value) return;
  const description = await readAgentCardViewForDisplay(selected.agent.id, selected.project.path, options);
  if (!options.authorized()) return;
  if (description.state === 'ok') {
    const value = description.value, view = value?.view ?? null;
    const status = cardStatus(true, view, false);
    c.summary = cardSummary(status, name);
    row(c, 'Description', status === 'ready' ? 'Ready' : cardSummary(status, name));
    row(c, 'When to reach it', view?.card?.contactWhen || 'Not given');
    row(c, 'Owns', view?.card?.owns || 'Not given');
    if (view?.waitingToAsk) c.notes.push('The description request is recorded as waiting to be sent.');
    if (value?.withheld.length) c.notes.push(`Description text withheld by the conservative host display policy: ${value.withheld.map((f) => f === 'contactWhen' ? 'When to reach it' : 'Owns').join(', ')}.`);
    if (value?.truncated.length) c.notes.push(`Description fields truncated to the host display limit: ${value.truncated.map((f) => f === 'contactWhen' ? 'When to reach it' : 'Owns').join(', ')}.`);
    c.notes.push('Description fields are recorded host metadata, not evidence of provider loading or use.');
  } else {
    c.state = 'error'; c.summary = 'connected · description unavailable';
    row(c, 'Description', 'Unavailable from host metadata');
    row(c, 'When to reach it', 'Unavailable from host metadata'); row(c, 'Owns', 'Unavailable from host metadata');
    if (description.reason === 'limit') c.notes.push('The selected description exceeded the bounded host read. No complete description is inferred.');
  }
  const reach = controller && readAgentReachForDisplay(controller.agent.id, controller.agent, options);
  if (reach && reach.state === 'ok') {
    row(c, `${c.title} can`, reachSummary(reach.value));
    for (const r of reach.value) row(c, r.label, `${r.mode === 'allow' ? 'Allow' : r.mode === 'ask' ? 'Ask first' : 'Off'}${r.everyAgent ? ' · set for every agent' : ''}`);
    c.notes.push('Permissions summarize recorded Clubhouse grants; no runtime application is inferred.');
  } else {
    c.state = 'error'; row(c, 'Dispatcher permissions', 'Unavailable from host metadata');
  }
}
