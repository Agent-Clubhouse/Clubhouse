/** Only the selected strict inventory's recorded provider may read its historical session. */
import type { DurableAgentConfig } from '../../shared/types';
import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import { describeSleep, formatShortDuration } from '../../shared/agent-session-display';
import { getProvider, isSessionCapable } from '../orchestrators';
import type { TranscriptReadStats } from '../orchestrators/types';
import { normalizeSessionEvents, SUMMARY_TRANSCRIPT_MAX_BYTES } from './session-reader';
import { isShellEnvironmentCached } from '../util/shell';
import { row } from './remote-details-presentation';
import { hasC0Control } from '../../shared/ascii-control';
import { providerDescriptor } from '../../shared/providers/descriptors';
import { isFeatureOffered, resolveEffectiveFeature } from '../../shared/providers/features';

export async function readHistoricalSessionCard(c: RemoteDetailsCard, agent: DurableAgentConfig, cwd: string): Promise<void> {
  if (agent.lastSleep) {
    row(c, 'Ended', agent.lastSleep.at);
    row(c, 'Why', describeSleep(agent.lastSleep));
  }
  const id = agent.lastSessionId;
  if (!id) { c.notes.push('No earlier session recorded.'); return; }
  // Even a host inventory cannot make an identifier into an arbitrary transcript path.
  if (id.length > 1024 || !id || /[\\/]/.test(id) || hasC0Control(id) || id.startsWith('.')) {
    row(c, 'Last CLI', 'Historical session identity unavailable');
    c.notes.push('The saved session identity cannot be read safely. No transcript was queried.'); return;
  }
  const associations = agent.sessionHistory?.filter((entry) => entry.sessionId === id) ?? [];
  const ids = new Set(associations.map((entry) => entry.orchestrator));
  const recorded = associations.length && ids.size === 1 ? associations[0].orchestrator : undefined;
  if (!recorded) {
    row(c, 'Last CLI', 'Not recorded unambiguously for this session');
    c.notes.push('Historical usage is unknown: the configured next-start provider is not used to infer the last session’s CLI.'); return;
  }
  const provider = getProvider(recorded);
  row(c, 'Last CLI', provider?.displayName || recorded);
  if (!provider || !isSessionCapable(provider)) { c.notes.push('The recorded provider does not support reading this historical session on this host.'); return; }
  // Passive lookup is established per provider: its descriptor must declare session history.
  if (!isFeatureOffered(resolveEffectiveFeature({ declarations: providerDescriptor(provider.id)?.features, feature: 'session_history' }))) {
    c.notes.push('Passive historical lookup has not been established for this provider. Usage is unknown.'); return;
  }
  // These built-in readers obtain their root synchronously before their first
  // await, and do not resolve launch environment again after awaited lookup/IO.
  // No event-loop turn separates this check from that root resolution. A cold
  // cache may be pending or unavailable; display must never initialize it.
  if (!isShellEnvironmentCached()) {
    c.notes.push('Historical usage is unknown: the host launch environment is not cached (initialization may be pending or unavailable). Details does not initialize it.'); return;
  }
  const stats: TranscriptReadStats = {};
  const raw = await provider.readSessionTranscript(id, cwd, { maxBytes: SUMMARY_TRANSCRIPT_MAX_BYTES, stats, passiveLookup: true });
  const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (stats.lookupIncomplete) c.notes.push('Historical lookup reached its bounded limit or an unreadable directory. Session availability is unknown.');
  if (stats.truncated) c.notes.push('The historical transcript was truncated to the host summary byte limit; earlier results may be missing.');
  else if (known(stats.fileBytes) && stats.fileBytes === stats.bytesRead) c.notes.push('The provider read the complete file for this summary.');
  else c.notes.push('The provider did not report whether this historical transcript read was complete.');
  if (!raw?.length) { c.notes.push('The recorded provider did not return a readable historical transcript. Usage is unknown.'); return; }
  // Native JSONL may store ISO timestamps. The ordinary normalizer invents a
  // clock value for missing timestamps; that is useful for ordering, but is
  // not historical activity evidence. NaN keeps those events untimed here.
  const events = normalizeSessionEvents(raw.map((event) => {
    const timestamp = typeof event.timestamp === 'number' ? event.timestamp
      : typeof event.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) ? Date.parse(event.timestamp) : NaN;
    return { ...event, timestamp: Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e15 ? timestamp : NaN };
  }));
  const lastActivity = events.reduce((latest, event) => Number.isFinite(event.timestamp) ? Math.max(latest, event.timestamp) : latest, 0);
  if (lastActivity) {
    row(c, 'Last activity', new Date(lastActivity).toISOString());
    c.notes.push('Last activity is the latest explicit timestamp among parsed events in this selected provider transcript read. It is not a verified sleep or end time; unread or untimed events may be missing.');
  }
  const results = events.filter((event) => event.type === 'result');
  const lastResult = results[results.length - 1];
  row(c, 'Duration', known(lastResult?.durationMs) ? formatShortDuration(lastResult.durationMs) : 'Not reported');
  row(c, 'Cost', known(lastResult?.costUsd) ? `$${lastResult.costUsd.toFixed(2)}` : 'Not reported');
  c.notes.push('Duration and cost are the last parsed provider result’s reported totals; missing fields are not zero.');
}
