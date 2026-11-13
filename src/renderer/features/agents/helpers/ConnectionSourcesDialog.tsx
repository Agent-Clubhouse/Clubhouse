/**
 * Remove one source of a connection (#2744). A connection can be held by
 * several sources (a canvas wire, Connect to Dispatcher, a link an
 * orchestrator or the Dispatcher made, a helper); each is listed with what
 * removing it changes, and removing one leaves the others. Canvas wires and
 * helper links are removed where they live, and the dialog says where.
 */

import { useEffect, useRef, useState } from 'react';
import { CONNECTION_TOOLS, WAKE_SWITCH, localWakeOn, type ConnectionDirection } from '../../../../shared/connection-grants';
import { Toggle } from '../../../components/Toggle';
import {
  CONNECTION_SOURCE_LABELS, removalRoute, type ConnectionPairSources, type ConnectionSource, type ConnectionSourceKind,
} from '../../../../shared/connection-sources';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { reportChromeActionFailed } from '../../../chrome/telemetry';
import { ConnectionGuidanceEditor } from './ConnectionGuidanceEditor';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

/** What removing a source does, in a sentence. */
export function removalEffect(kind: ConnectionSourceKind, names: { agent: string; other: string; dispatcherEnd?: string }): string {
  switch (kind) {
    case 'tool_link': return `Removes the link an agent made between ${names.agent} and ${names.other}. If nothing else connects them, it can't link them again this session.`;
    case 'dispatcher_link': return `Removes the link the Dispatcher made. It can't connect them again unless you draw the wire yourself.`;
    case 'user_link': return `Removes the link you made from ${names.agent} to ${names.other}.`;
    case 'dispatcher_auto': return `Turns off Connect to Dispatcher for ${names.dispatcherEnd ?? names.other}. The Dispatcher can no longer message it or get its reports.`;
    case 'canvas': return 'Remove it on its canvas. This card doesn’t change canvas wires.';
    case 'dispatcher_federation': return 'Controller links follow Annex Network membership. Their tools are fixed.';
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
  'dispatcher-federation': 'dispatcher_federation',
  'canvas-wires': 'canvas', 'helper-wires': 'helper', 'dispatcher-wires': 'dispatcher_auto',
  'orchestrator-connections': 'tool_link', 'network-agent-connections': 'tool_link', 'network-connections': 'user_link', 'dispatcher-connections': 'dispatcher_link', 'user-connections': 'user_link',
};

/** Removals that change a setting or can't be undone by drawing again: confirmed first. */
const CONFIRMED: ReadonlySet<ConnectionSourceKind> = new Set(['dispatcher_auto', 'dispatcher_link']);

/**
 * One direction of the connection view (#2972): what the sender may do to
 * the receiver, each tool a switch, saved in the connection store (D129).
 * Wake it comes last (#3215): on for a new connection, off for one saved
 * before the switch, until turned on. A wire with the Dispatcher
 * has none, since the Dispatcher's own wake doesn't depend on it, and neither
 * does a helper's link with its orchestrator, where it can't take effect.
 * A direction that isn't connected offers Make two-way instead.
 */
function DirectionColumn({ readOnly = false, from, to, fromName, toName, connected, inspectionOnly, disabledTools, wakeOn, showWake, canMakeTwoWay, onChanged }: {
  readOnly?: boolean;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  connected: boolean;
  inspectionOnly: boolean;
  disabledTools: readonly string[];
  wakeOn: boolean;
  showWake: boolean;
  canMakeTwoWay: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Changed here first, so a second quick switch builds on the first (#2972).
  const [tools, setTools] = useState<readonly string[]>(disabledTools);
  const writes = useRef(0);
  useEffect(() => { if (writes.current === 0) setTools(disabledTools); }, [disabledTools]);
  const [wake, setWake] = useState(wakeOn);
  const wakeWrites = useRef(0);
  useEffect(() => { if (wakeWrites.current === 0) setWake(wakeOn); }, [wakeOn]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      reportChromeActionFailed('agent_settings_save', err);
      setError('Couldn\u2019t save that, so it wasn\u2019t changed. Try again.');
    }
    setBusy(false);
  };
  const toggle = (tool: string, on: boolean) => {
    const next = on ? tools.filter((t) => t !== tool) : [...new Set([...tools, tool])];
    const before = tools;
    setTools(next);
    writes.current += 1;
    setError(null);
    void Promise.resolve().then(() => window.clubhouse.mcpBinding.setDisabledTools(from, to, next)).then(
      () => { writes.current -= 1; onChanged(); },
      (err) => {
        writes.current -= 1;
        reportChromeActionFailed('agent_settings_save', err);
        setTools(before);
        setError('Couldn\u2019t save that, so it wasn\u2019t changed. Try again.');
      },
    );
  };
  const toggleWake = (on: boolean) => {
    setWake(on);
    wakeWrites.current += 1;
    setError(null);
    void Promise.resolve().then(() => window.clubhouse.mcpBinding.setLocalWake(from, to, on)).then(
      () => { wakeWrites.current -= 1; onChanged(); },
      (err) => {
        wakeWrites.current -= 1;
        reportChromeActionFailed('agent_settings_save', err);
        setWake(!on);
        setError('Couldn\u2019t save that, so it wasn\u2019t changed. Try again.');
      },
    );
  };
  return (
    <section className="flex-1 min-w-0 flex flex-col gap-1.5" aria-label={`${fromName} to ${toName}`} data-testid={`connection-direction-${from}-${to}`}>
      <h3 className="text-[13px] text-ctp-text truncate">{fromName} to {toName}</h3>
      {inspectionOnly ? <p className="text-xs text-ctp-overlay1">Configured, but not connected. Saved metadata is read-only.</p> : connected ? (
        <ul className="flex flex-col gap-1">
          {CONNECTION_TOOLS.map(({ tool, label }) => {
            const on = !tools.includes(tool);
            return (
              <li key={tool} className="flex items-center gap-2 text-xs text-ctp-subtext1">
                <span className="flex-1 min-w-0 truncate">{label}</span>
                <Toggle disabled={readOnly} aria-label={`${label} (${fromName} to ${toName})`} checked={on} onChange={(next) => toggle(tool, next)} data-testid={`connection-tool-${from}-${to}-${tool}`} />
              </li>
            );
          })}
          {showWake && (
            <li className="flex items-center gap-2 text-xs text-ctp-subtext1">
              <span className="flex-1 min-w-0 truncate">{WAKE_SWITCH.label}</span>
              <Toggle disabled={readOnly} aria-label={`${WAKE_SWITCH.label} (${fromName} to ${toName})`} checked={wake} onChange={toggleWake} data-testid={`connection-tool-${from}-${to}-${WAKE_SWITCH.tool}`} />
            </li>
          )}
        </ul>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-ctp-overlay1">Not connected this way.</p>
          {canMakeTwoWay && (
            <div>
              <Button onClick={() => void run(() => window.clubhouse.mcpBinding.makeTwoWay(from, to))} disabled={busy} data-testid={`connection-make-two-way-${from}-${to}`}>
                Make two-way
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-ctp-error">{error}</p>}
    </section>
  );
}

export function ConnectionSourcesDialog({ agentId, otherId, agentName, otherName, dispatcherEnd, familyLink = false, targetKind = 'agent', pairs, grants = [], liveTools, liveEnabled, unreadable = [], onClose, onRemoved, backdropTestId, readError, onRetry }: {
  /** This agent and the other end, for the directions (#2972). */
  agentId?: string;
  otherId?: string;
  agentName: string;
  otherName: string;
  /** Saved per-direction permissions touching this agent (D129). */
  grants?: readonly ConnectionDirection[];
  /** The live bindings' disabled tools, by "from>to", for a direction the store has nothing for. */
  liveTools?: ReadonlyMap<string, readonly string[]>;
  /** The live bindings' switches their source started on (wake, #3214), by "from>to", likewise. */
  liveEnabled?: ReadonlyMap<string, readonly string[]>;
  /** For a wire to the Dispatcher: the other agent's name, whose switch goes off. */
  dispatcherEnd?: string;
  /** The other end is this agent's helper or orchestrator: they wake each other with their helper tools, so no Wake it. */
  familyLink?: boolean;
  targetKind?: McpBindingEntry['targetKind'];
  backdropTestId?: string;
  readError?: string;
  onRetry?: () => void;
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

  const directions = agentId && otherId ? [
    { from: agentId, to: otherId, fromName: agentName, toName: otherName },
    { from: otherId, to: agentId, fromName: otherName, toName: agentName },
  ] : [];
  const savedOf = (from: string, to: string) => grants.find((g) => g.from.agentId === from && g.to.agentId === to && !g.from.machineId && !g.to.machineId);
  const toolsOf = (from: string, to: string): readonly string[] => savedOf(from, to)?.disabledTools ?? liveTools?.get(`${from}>${to}`) ?? [];
  const connectedWay = (from: string, to: string) => pairs.some((p) => p.agentId === from && p.targetId === to && (p.bound || p.sources.length > 0));
  const inspectionWay = (from: string, to: string) => pairs.some((p) => p.agentId === from && p.targetId === to && !!p.inspection && !p.bound);
  const inspectionOnly = pairs.length > 0 && pairs.every((pair) => !pair.bound) && pairs.some((pair) => !!pair.inspection);
  const guidanceDirections = directions.filter((d, index) => (targetKind === 'agent' || index === 0)
    && (connectedWay(d.from, d.to) || liveTools?.has(`${d.from}>${d.to}`)))
    .map((d) => ({
      from: d.from, to: d.to, label: `${d.fromName} to ${d.toName}`,
      offline: !pairs.some((pair) => pair.agentId === d.from && pair.targetId === d.to && pair.bound) && !liveTools?.has(`${d.from}>${d.to}`),
    }));

  return (
    <Modal open onClose={onClose} title={`${agentName} and ${otherName}`} width="w-[640px]" testId="connection-sources-dialog" backdropTestId={backdropTestId}
      footer={<Button kind="quiet" onClick={onClose} data-testid="wire-instructions-cancel">Close</Button>}>
      {readError && <p role="alert" className="text-xs text-ctp-error mb-3">Couldn't refresh connection sources: {readError}. Showing the last known sources. <Button onClick={onRetry}>Try again</Button></p>}
      {!inspectionOnly && <p className="text-xs text-ctp-overlay1 mb-3">On describes the connection switch. The sender's Clubhouse permissions can still turn a tool off or require Ask first.</p>}
      {targetKind === 'agent' && directions.length > 0 && (
        <div className="flex gap-4 mb-4" data-testid="connection-directions">
          {directions.map((d) => (
            <DirectionColumn
              readOnly={pairs.some((p) => p.sources.some((s) => s.kind === 'dispatcher_federation'))}
              key={`${d.from}>${d.to}`}
              {...d}
              connected={connectedWay(d.from, d.to)}
              inspectionOnly={inspectionWay(d.from, d.to)}
              disabledTools={toolsOf(d.from, d.to)}
              wakeOn={localWakeOn(savedOf(d.from, d.to), liveEnabled?.get(`${d.from}>${d.to}`))}
              showWake={pairs.some((p) => p.sources.some((s) => s.kind === 'dispatcher_federation')) || (!dispatcherEnd && !familyLink)}
              canMakeTwoWay={connectedWay(d.to, d.from) && !inspectionWay(d.to, d.from)}
              onChanged={onRemoved}
            />
          ))}
        </div>
      )}
      {targetKind === 'agent' && (dispatcherEnd || familyLink) && <p className="text-xs text-ctp-overlay1 mb-3">This connection has no Wake it switch. The Dispatcher and helpers use their own wake tools.</p>}
      <p className="text-xs text-ctp-overlay1 mb-3">
        {inspectionOnly ? `Configured in ${direction}, but not connected now. Saved sources and guidance can be inspected without starting a session.` : entries.length === 0
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
              <span className="text-ctp-text">{source.makers?.length ? `Made by ${source.makers.map((maker) => `${maker.name || maker.agentId} (${maker.machineId})`).join(', ')}` : CONNECTION_SOURCE_LABELS[kind]}{held.length < pairs.length ? ', one direction' : ''}</span>
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
      <ConnectionGuidanceEditor directions={guidanceDirections} />
      {guidanceDirections.length === 0 && (
        <p className="mt-4 text-xs text-ctp-overlay1">No saved or active direction is available for guidance inspection. No session was started.</p>
      )}
    </Modal>
  );
}
