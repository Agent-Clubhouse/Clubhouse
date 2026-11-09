/**
 * Backfill on connect (#2920, spec §6.12): after the user turns a destination on,
 * offer to send it the history this computer has already recorded. Nothing is
 * sent until they choose Send. Main decides whether there's an offer at all
 * (never for the developer destination, never after startup); this only shows it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { settingsInput } from './SettingsLayout';
import type { BackfillOffer, BackfillRange, BackfillStatus } from '../../../shared/telemetry/settings-types';

const api = () => window.clubhouse.telemetrySettings;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How much history there is, in plain words, from real numbers: never "0 days". */
export function historyAmount(offer: Pick<BackfillOffer, 'oldest' | 'until' | 'bytes'>): string {
  const span = Math.max(0, offer.until - offer.oldest);
  let time: string;
  if (span < HOUR_MS) time = 'less than an hour';
  else if (span < DAY_MS) {
    const hours = Math.round(span / HOUR_MS);
    time = hours === 1 ? '1 hour' : `${hours} hours`;
  } else {
    const days = Math.round(span / DAY_MS);
    time = days === 1 ? '1 day' : `${days} days`;
  }
  return `${time} (${sizeText(offer.bytes)})`;
}

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** The choices that mean something for this much history: shorter windows, then everything kept. */
export function rangeChoices(offer: Pick<BackfillOffer, 'oldest' | 'until'>): Array<{ id: BackfillRange; label: string }> {
  const span = offer.until - offer.oldest;
  const shorter = ([1, 7, 30] as const).filter((d) => d * DAY_MS < span).map((d) => ({ id: d as BackfillRange, label: d === 1 ? 'The last day' : `The last ${d} days` }));
  return [...shorter, { id: 'all', label: 'Everything kept' }];
}

/** Seven days when there's more than that, else everything kept. */
export function defaultRange(offer: Pick<BackfillOffer, 'oldest' | 'until'>): BackfillRange {
  return offer.until - offer.oldest > 7 * DAY_MS ? 7 : 'all';
}

function sentText(s: BackfillStatus): string {
  const parts = [`${s.spans} ${s.spans === 1 ? 'span' : 'spans'}`, `${s.logs} ${s.logs === 1 ? 'event' : 'events'}`];
  if (s.metricPoints > 0) parts.push(`${s.metricPoints} metric ${s.metricPoints === 1 ? 'point' : 'points'}`);
  return parts.join(', ');
}

function statusText(s: BackfillStatus | null, label: string): string {
  if (!s) return '';
  if (s.state === 'running') {
    return `Sending history to ${label}: ${sentText(s)}${s.runsTotal > 1 ? `, session ${Math.min(s.runsDone + 1, s.runsTotal)} of ${s.runsTotal}` : ''}.`;
  }
  if (s.state === 'done') return `History sent to ${label}: ${sentText(s)}.`;
  if (s.state === 'cancelled') return 'Sending stopped. What was sent stays sent.';
  if (s.reason === 'not_reachable') return `Sending stopped: ${label} isn't reachable right now. What was sent stays sent.`;
  if (s.reason === 'export_failed') return `Sending stopped: ${label} didn't accept part of it. What was sent stays sent.`;
  return 'Sending stopped before the end. What was sent stays sent.';
}

export function TelemetryBackfillOffer({ destinationId, label, on }: { destinationId: string; label: string; on: boolean }) {
  const [offer, setOffer] = useState<BackfillOffer | null>(null);
  const [range, setRange] = useState<BackfillRange>(7);
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A reply that arrives after the destination was turned off is ignored.
  const onRef = useRef(on);
  onRef.current = on;

  const refresh = useCallback(async () => {
    try {
      const [next, current] = await Promise.all([api().backfillOffer(destinationId), api().backfillStatus(destinationId)]);
      if (!onRef.current) return;
      setStatus(current);
      setOffer(next);
      if (next) setRange((r) => (rangeChoices(next).some((c) => c.id === r) ? r : defaultRange(next)));
    } catch {
      setOffer(null);
    }
  }, [destinationId]);

  // Asked when the destination is on; main answers null unless the user just turned it on.
  useEffect(() => {
    if (!on) { setOffer(null); setStatus(null); setError(null); return; }
    void refresh();
  }, [on, refresh]);

  // While a send runs, follow it.
  useEffect(() => {
    if (!on || status?.state !== 'running') return;
    const timer = setInterval(() => {
      api().backfillStatus(destinationId).then((s) => {
        if (!onRef.current) return;
        setStatus(s);
        if (s?.state !== 'running') void refresh();
      }).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [on, status?.state, destinationId, refresh]);

  const send = async () => {
    setError(null);
    try {
      const result = await api().backfillStart(destinationId, range);
      if (!result.ok) {
        setError(result.reason === 'not_reachable'
          ? `${label} isn't reachable right now, so nothing was sent. Try again once it's receiving live data.`
          : "Couldn't start sending. Try again.");
        return;
      }
      const s = await api().backfillStatus(destinationId);
      setStatus(s);
      // Finished at once (nothing in the window): show what's true now.
      if (s?.state !== 'running') await refresh();
    } catch {
      setError("Couldn't start sending. Try again.");
    }
  };

  const notNow = async () => {
    setError(null);
    try {
      await api().backfillDismiss(destinationId);
    } catch {
      // Gone from view either way; main offers nothing new until the destination is turned on again.
    }
    setOffer(null);
  };

  if (!on) return null;

  const running = status?.state === 'running';
  const resuming = !!offer?.resuming;
  const message = statusText(status, label);
  if (!message && !offer && !error) return null;
  return (
    <div className="flex flex-col gap-2" data-testid={`telemetry-backfill-${destinationId}`}>
      {/* One live region for progress and outcome, read without the buttons. */}
      <p className="text-xs text-ctp-subtext1" role="status" aria-atomic="true">{message}</p>
      {running && (
        <div>
          <Button kind="ghost" onClick={() => void api().backfillCancel(destinationId)}>Cancel</Button>
        </div>
      )}
      {!running && offer && (
        <>
          <p className="text-xs text-ctp-subtext1">
            {resuming
              ? `Send the rest of the history to ${label}? It picks up after what was already sent, in the same window as before.`
              : `Send recent history to ${label}? Clubhouse has kept ${historyAmount(offer)} of telemetry on this computer. You can send it now, within the limit you choose. It goes through this destination's detail level and filters, and diagnostic log lines never leave this computer.`}
          </p>
          <div className="flex items-center gap-3">
            {!resuming && rangeChoices(offer).length > 1 && (
              <select
                aria-label={`How much history to send to ${label}`}
                className={`${settingsInput} w-auto`}
                value={String(range)}
                onChange={(e) => setRange(e.target.value === 'all' ? 'all' : (Number(e.target.value) as BackfillRange))}
              >
                {rangeChoices(offer).map((c) => <option key={String(c.id)} value={String(c.id)}>{c.label}</option>)}
              </select>
            )}
            <Button kind="ghost" onClick={() => void send()}>{resuming ? 'Send the rest' : 'Send'}</Button>
            <Button kind="ghost" onClick={() => void notNow()}>Not now</Button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-ctp-error" role="alert">{error}</p>}
    </div>
  );
}
