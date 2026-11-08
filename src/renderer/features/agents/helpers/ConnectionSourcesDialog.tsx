/**
 * Remove one source of a connection (#2744). A connection can be held by
 * several sources (a canvas wire, Connect to Dispatcher, a link an
 * orchestrator or the Dispatcher made, a helper); each is listed with what
 * removing it changes, and removing one leaves the others. Canvas wires and
 * helper links are removed where they live, and the dialog says where.
 */

import { useState } from 'react';
import {
  CONNECTION_SOURCE_LABELS, removalRoute, type ConnectionPairSources, type ConnectionSource, type ConnectionSourceKind,
} from '../../../../shared/connection-sources';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { reportChromeActionFailed } from '../../../chrome/telemetry';

/** What removing a source does, in a sentence. */
export function removalEffect(kind: ConnectionSourceKind, names: { agent: string; other: string; dispatcherEnd?: string }): string {
  switch (kind) {
    case 'tool_link': return `Removes the link an orchestrator made between ${names.agent} and ${names.other}. If nothing else connects them, it can't link them again this session.`;
    case 'dispatcher_link': return `Removes the link the Dispatcher made. It can't connect them again unless you draw the wire yourself.`;
    case 'dispatcher_auto': return `Turns off Connect to Dispatcher for ${names.dispatcherEnd ?? names.other}. The Dispatcher can no longer message it or get its reports.`;
    case 'canvas': return 'Remove it on its canvas. This card doesn’t change canvas wires.';
    case 'helper': return `A helper stays connected to its orchestrator while it exists. To end it, dispose the helper from the Helpers card.`;
    default: return 'This source can’t be removed here.';
  }
}

/** The sources of a row, one entry per kind, with the pairs each holds. */
export function sourcesByKind(pairs: readonly ConnectionPairSources[]): Array<{ kind: ConnectionSourceKind; source: ConnectionSource; pairs: ConnectionPairSources[] }> {
  const out = new Map<ConnectionSourceKind, { kind: ConnectionSourceKind; source: ConnectionSource; pairs: ConnectionPairSources[] }>();
  for (const p of pairs) {
    for (const s of p.sources) {
      const entry = out.get(s.kind) ?? { kind: s.kind, source: s, pairs: [] };
      entry.pairs.push(p);
      out.set(s.kind, entry);
    }
  }
  return [...out.values()];
}

const KIND_BY_ID: Readonly<Record<string, ConnectionSourceKind>> = {
  'canvas-wires': 'canvas', 'helper-wires': 'helper', 'dispatcher-wires': 'dispatcher_auto',
  'orchestrator-connections': 'tool_link', 'dispatcher-connections': 'dispatcher_link',
};

/** Removals that change a setting or can't be undone by drawing again: confirmed first. */
const CONFIRMED: ReadonlySet<ConnectionSourceKind> = new Set(['dispatcher_auto', 'dispatcher_link']);

export function ConnectionSourcesDialog({ agentName, otherName, dispatcherEnd, pairs, unreadable = [], onClose, onRemoved }: {
  agentName: string;
  otherName: string;
  /** For a wire to the Dispatcher: the other agent's name, whose switch goes off. */
  dispatcherEnd?: string;
  pairs: ConnectionPairSources[];
  /** Sources that couldn't be read: they may hold it too. */
  unreadable?: readonly string[];
  onClose: () => void;
  /** After a removal went through, to re-read the sources. */
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState<ConnectionSourceKind | null>(null);
  const [confirming, setConfirming] = useState<ConnectionSourceKind | null>(null);
  const [result, setResult] = useState<{ kind: ConnectionSourceKind; text: string; error?: boolean } | null>(null);
  const entries = sourcesByKind(pairs);
  const direction = pairs.length > 1 ? 'both directions' : 'one direction';

  const remove = async (kind: ConnectionSourceKind, held: ConnectionPairSources[]) => {
    setConfirming(null);
    setBusy(kind);
    setResult(null);
    try {
      let still = false;
      let notSaved = false;
      let remaining: string[] = [];
      // Connect to Dispatcher is one switch for both directions: turned off once.
      const targets = kind === 'dispatcher_auto' ? held.slice(0, 1) : held;
      for (const p of targets) {
        const r = await window.clubhouse.mcpBinding.removeConnectionSource(p.agentId, p.targetId, kind);
        if (r.ok === false) {
          setResult({ kind, text: r.error, error: true });
          setBusy(null);
          onRemoved();
          return;
        }
        if (r.stillConnected) still = true;
        if (r.notSaved) notSaved = true;
        remaining = [...new Set([...remaining, ...r.remaining.filter((s) => !s.suspended).map((s) => CONNECTION_SOURCE_LABELS[s.kind])])];
      }
      const text = still && remaining.length > 0 ? `Removed. Still connected through: ${remaining.join(', ')}.` : 'Removed. They aren’t connected now.';
      setResult(notSaved
        ? { kind, text: `${text} Clubhouse couldn’t save the removal yet, so it may come back after a restart.`, error: true }
        : { kind, text });
      onRemoved();
    } catch (err) {
      reportChromeActionFailed('agent_settings_save', err);
      setResult({ kind, text: 'Couldn’t remove it, so nothing changed. Try again.', error: true });
    }
    setBusy(null);
  };

  return (
    <Modal open onClose={onClose} title={`${agentName} and ${otherName}`} width="w-[460px]" testId="connection-sources-dialog">
      <p className="text-xs text-ctp-overlay1 mb-3">
        {entries.length === 0
          ? (pairs.some((p) => p.unresolved) ? 'Connected now, but no saved source lists it.' : 'Nothing connects them now.')
          : `Connected in ${direction}. Each source below keeps them connected on its own; removing one leaves the others.`}
      </p>
      {result && (
        <p role={result.error ? 'alert' : 'status'} className={`mb-3 text-xs ${result.error ? 'text-ctp-error' : 'text-ctp-subtext1'}`} data-testid="connection-source-result">{result.text}</p>
      )}
      <ul className="flex flex-col gap-3" data-testid="connection-sources-list">
        {entries.map(({ kind, source, pairs: held }) => {
          const route = removalRoute(kind);
          return (
            <li key={kind} className="flex flex-col gap-1 text-[13px]" data-testid={`connection-source-${kind}`}>
              <span className="text-ctp-text">{CONNECTION_SOURCE_LABELS[kind]}{held.length < pairs.length ? ', one direction' : ''}</span>
              {source.suspended && <span className="text-xs text-ctp-overlay1">Not connected now: {source.suspended}</span>}
              <span className="text-xs text-ctp-overlay1">{removalEffect(kind, { agent: agentName, other: otherName, dispatcherEnd })}</span>
              {route === 'here' && confirming !== kind && (
                <div>
                  <Button
                    onClick={() => (CONFIRMED.has(kind) ? setConfirming(kind) : void remove(kind, held))}
                    disabled={busy !== null}
                    data-testid={`connection-source-remove-${kind}`}
                  >
                    {busy === kind ? 'Removing…' : 'Remove'}
                  </Button>
                </div>
              )}
              {route === 'here' && confirming === kind && (
                <div className="flex items-center gap-2">
                  <Button kind="danger" onClick={() => void remove(kind, held)} disabled={busy !== null} data-testid={`connection-source-confirm-${kind}`}>
                    {kind === 'dispatcher_auto' ? 'Turn it off' : 'Remove it'}
                  </Button>
                  <Button kind="quiet" onClick={() => setConfirming(null)} data-testid={`connection-source-cancel-${kind}`}>Cancel</Button>
                </div>
              )}
            </li>
          );
        })}
        {unreadable.length > 0 && (
          <li className="text-xs text-ctp-overlay1" data-testid="connection-source-unreadable">
            Couldn’t check: {unreadable.map((id) => CONNECTION_SOURCE_LABELS[KIND_BY_ID[id] ?? 'other']).join(', ')}. It may hold this connection too.
          </li>
        )}
      </ul>
    </Modal>
  );
}
