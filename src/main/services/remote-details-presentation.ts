import { REMOTE_DETAILS_MAX_ROWS, type RemoteDetailsCard, type RemoteDetailsCardId } from '../../shared/remote-agent-details';
import { redactSecretValues } from '../telemetry/diag-redaction';

/** Redact before cutting so a partial credential cannot evade the existing secret patterns. */
export const display = (value: unknown, max = 2048) => {
  const text = redactSecretValues(String(value)).replace(/[\x00-\x1f\x7f]/g, ' ');
  return text.length > max ? `${text.slice(0, max - 24)}… [text truncated]` : text;
};

export function card(id: RemoteDetailsCardId, title: string): RemoteDetailsCard {
  return { id, title, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: Date.now() };
}
export function row(c: RemoteDetailsCard, label: string, value: unknown) {
  if (value === undefined || value === null || value === '') return;
  if (c.rows.length >= REMOTE_DETAILS_MAX_ROWS) { c.omitted++; return; }
  c.rows.push({ label: display(label), value: display(value) });
}
export async function section(c: RemoteDetailsCard, run: () => Promise<void> | void) {
  try { await run(); }
  catch { // telemetry-exempt: a safe per-card error is the result; no raw host error crosses the wire.
    c.state = 'error'; c.summary = 'Couldn’t read from host'; c.notes.push('Couldn’t read this section. Refresh to try again.');
  }
}

