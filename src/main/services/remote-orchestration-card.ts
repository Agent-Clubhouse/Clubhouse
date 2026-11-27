/** Present selected safe field models; all reads/receipts belong to the host container. */
import { AUTO_LOCKED_NOTES, CONTROL_LABELS, accessLabel } from '../../shared/helper-policy-display';
import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import type { DisplayValue } from './display-settings';
import type { HelperRequestDisplayText, HelperStartRequestDisplay } from './helper-start-requests';
import type { readOrchestrationForDisplay } from './orchestration-display';
import { row } from './remote-details-presentation';

export type OrchestrationDisplay = ReturnType<typeof readOrchestrationForDisplay>;
const yes = (value: boolean) => value ? 'On' : 'Off';
const unknown = 'Unavailable from host metadata';
export function projectOrchestrationFields(c: RemoteDetailsCard, model: OrchestrationDisplay, name: string, helper: boolean): { enabled?: boolean; limit?: number } {
  const f = model.fields;
  const enabled = f.orchestrate.state === 'ok' ? f.orchestrate.value : undefined;
  const limit = f.maxHelpers.state === 'ok' ? f.maxHelpers.value : undefined;
  c.summary = enabled === false ? 'off' : enabled === true ? `${f.control.state === 'ok' ? CONTROL_LABELS[f.control.value] : 'Approvals unavailable'} · ${limit === undefined ? 'helper limit unavailable' : `up to ${limit}`}` : unknown;
  if (!helper) {
    const field = <T>(label: string, value: DisplayValue<T>, text: (value: T) => string = String) => {
      if (value.state !== 'ok') c.state = 'error';
      row(c, label, value.state === 'ok' ? text(value.value) : unknown);
    };
    field('Orchestration', f.orchestrate, yes); field('Helper access', f.access, (value) => accessLabel(value, name)); field('Approvals', f.control, (value) => CONTROL_LABELS[value]);
    field('Helpers at once', f.maxHelpers); field('App-wide limit', model.globalCap); field('Cross-project helpers', f.crossProjectHelpers, yes);
    if (model.autoEffective.state === 'ok') {
      const value = model.autoEffective.value, locked = value.reason && AUTO_LOCKED_NOTES[value.reason];
      row(c, 'Smart routing', `${yes(value.effective)} · ${locked || (model.sources.autoHelpers === 'agent' ? 'Set on this agent' : 'Following the app setting')}`);
    } else { c.state = 'error'; row(c, 'Smart routing', unknown); }
    for (const input of model.globalCap.inputs) c.notes.push(`${input.field}: ${input.source === 'host-cache' ? 'established host policy' : 'host primary metadata'} observed ${new Date(input.observedAt).toISOString()}.`);
    c.notes.push('Configured helper policy. Tool availability and the actual helper CLI are established when a run starts.');
  }
  return { enabled, limit };
}

export function helperRequestText(value: HelperRequestDisplayText, field: string): string {
  return value.state === 'ok' ? value.text : `${field} withheld (${value.reason === 'safety' ? 'conservative display policy' : value.reason === 'read-limit' ? 'host read limit' : 'unavailable'})`;
}
export function projectPendingHelperStarts(c: RemoteDetailsCard, requests: DisplayValue<HelperStartRequestDisplay[]>): number | undefined {
  if (requests.state !== 'ok') { c.state = 'error'; c.notes.push('The selected pending helper starts are unavailable; no empty queue is inferred.'); return undefined; }
  for (const request of requests.value) {
    row(c, 'Waiting to start', `${helperRequestText(request.name, 'Name')} · awaiting approval`);
    row(c, 'Task', helperRequestText(request.task, 'Task'));
    row(c, 'Requested / expires', `${request.createdAt} · ${request.expiresAt}`);
    if (request.warning) row(c, 'Recorded start warning', helperRequestText(request.warning, 'Warning'));
  }
  if (requests.value.some((r) => r.name.state === 'withheld' || r.task.state === 'withheld' || r.warning?.state === 'withheld')) c.notes.push('Some text is withheld by the conservative display policy or read limit. Other request fields remain independent.');
  if (requests.value.some((r) => r.name.state === 'ok' && r.name.truncated || r.task.state === 'ok' && r.task.truncated || r.warning?.state === 'ok' && r.warning.truncated)) c.notes.push('Truncated request text is marked explicitly. Longer task text and some escaped syntax may be withheld; this is not a universal secret detector.');
  return requests.value.length;
}
