import { REMOTE_DETAILS_MAX_BYTES, REMOTE_DETAILS_MAX_ROWS, type RemoteAgentDetails, type RemoteDetailsCard, type RemoteDetailsCardId } from '../../shared/remote-agent-details';
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


/** Preserve requested source records as an explicit page-only response. The
 * enclosing reader still retains/checks every selected/run/role/auth receipt.
 * Other cards remain structurally compatible but explicitly not requested;
 * their empty bodies must never be interpreted as verified empty results. */
export function selectedConnectionPageEnvelope(result: RemoteAgentDetails): void {
  const requested = result.cards.find((c) => c.id === 'connections');
  if (!requested?.connectionPage) return; // An unsupported/failed page retains its explicit error response.
  result.connectionPageEnvelope = 1; result.connectionPageOnly = true; result.settings = null;
  delete result.providerEvidence; delete result.providerEvidenceState;
  delete result.outgoingWires;
  for (const c of result.cards) if (c !== requested) {
    c.requested = false; c.omitted += c.rows.length; c.rows = []; c.notes = [];
    c.summary = 'Not included in this selected Connections page';
  }
  const sourceNotes = requested.notes.slice(0, 19), omittedNotes = Math.max(0, requested.notes.length - 19);
  const notice = `Source field text was truncated to fit the page envelope. Every selected record and field remains represented.${omittedNotes ? ` ${omittedNotes} additional notice omitted.` : ''}`;
  for (let limit = 1024; Buffer.byteLength(JSON.stringify(result)) > REMOTE_DETAILS_MAX_BYTES && limit >= 64; limit = Math.floor(limit / 2)) {
    requested.rows = requested.rows.map((r) => ({ ...r, label: display(r.label, limit), value: display(r.value, limit) }));
    requested.notes = [...sourceNotes.map((note) => display(note, limit)), display(notice, limit)];
    requested.summary = display(requested.summary, limit);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > REMOTE_DETAILS_MAX_BYTES) throw new Error('details_page_limit');
}
