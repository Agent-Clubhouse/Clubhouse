import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TelemetryBackfillOffer, defaultRange, historyAmount, rangeChoices } from './TelemetryBackfillOffer';
import type { BackfillStatus } from '../../../shared/telemetry/settings-types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const UNTIL = Date.parse('2026-11-08T12:00:00.000Z');
const offer = (span: number, bytes = 3 * 1024 * 1024) => ({ destinationId: 'otlp', until: UNTIL, oldest: UNTIL - span, days: Math.max(1, Math.ceil(span / DAY)), bytes });
const status = (state: BackfillStatus['state'], extra: Partial<BackfillStatus> = {}): BackfillStatus => ({ destinationId: 'otlp', state, spans: 120, logs: 4, metricPoints: 0, filtered: 0, runsDone: 1, runsTotal: 3, ...extra });
const api = () => window.clubhouse.telemetrySettings;

afterEach(() => vi.restoreAllMocks());

describe('backfill offer wording (#2920)', () => {
  it('says how much history there is from the real numbers, never "0 days"', () => {
    expect(historyAmount(offer(20 * 60 * 1000, 40 * 1024))).toBe('less than an hour (40 KB)');
    expect(historyAmount(offer(5 * HOUR))).toBe('5 hours (3.0 MB)');
    expect(historyAmount(offer(DAY))).toBe('1 day (3.0 MB)');
    expect(historyAmount(offer(12 * DAY, 48 * 1024 * 1024))).toBe('12 days (48 MB)');
  });

  it('offers only the windows shorter than the history, then everything kept, defaulting to 7 days when there is more', () => {
    expect(rangeChoices(offer(5 * HOUR)).map((c) => c.id)).toEqual(['all']);
    expect(rangeChoices(offer(3 * DAY)).map((c) => c.id)).toEqual([1, 'all']);
    expect(rangeChoices(offer(40 * DAY)).map((c) => c.id)).toEqual([1, 7, 30, 'all']);
    expect(defaultRange(offer(3 * DAY))).toBe('all');
    expect(defaultRange(offer(10 * DAY))).toBe(7);
  });
});

describe('TelemetryBackfillOffer (#2920)', () => {
  it('shows nothing when main has no offer, or while the destination is off', async () => {
    const ask = vi.spyOn(api(), 'backfillOffer').mockResolvedValue(null);
    const { container, rerender } = render(<TelemetryBackfillOffer destinationId="otlp" label="OTLP" on />);
    await waitFor(() => expect(ask).toHaveBeenCalledWith('otlp'));
    expect(container).toBeEmptyDOMElement();
    ask.mockClear();
    rerender(<TelemetryBackfillOffer destinationId="otlp" label="OTLP" on={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(ask).not.toHaveBeenCalled();
  });

  it("names the destination and the real amount, and sends only the window the user picks", async () => {
    vi.spyOn(api(), 'backfillOffer').mockResolvedValue(offer(12 * DAY));
    const start = vi.spyOn(api(), 'backfillStart').mockResolvedValue({ ok: true });
    vi.spyOn(api(), 'backfillStatus').mockResolvedValue(null);
    render(<TelemetryBackfillOffer destinationId="otlp" label="Honeycomb" on />);
    expect(await screen.findByText(/Send recent history to Honeycomb\? Clubhouse has kept 12 days \(3\.0 MB\) of telemetry on this computer/)).toBeInTheDocument();
    expect(screen.getByText(/diagnostic log lines never leave this computer/)).toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'How much history to send to Honeycomb' }) as HTMLSelectElement;
    expect(picker.value).toBe('7');
    // Twelve days kept: 30 days would be the same as everything, so it isn't offered.
    expect(Array.from(picker.options).map((o) => o.text)).toEqual(['The last day', 'The last 7 days', 'Everything kept']);
    fireEvent.change(picker, { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('otlp', 'all'));
  });

  it('dismisses on Not now, sending nothing', async () => {
    vi.spyOn(api(), 'backfillOffer').mockResolvedValue(offer(2 * DAY));
    const start = vi.spyOn(api(), 'backfillStart');
    const dismiss = vi.spyOn(api(), 'backfillDismiss').mockResolvedValue(undefined);
    render(<TelemetryBackfillOffer destinationId="otlp" label="OTLP" on />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('otlp'));
    expect(start).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Send' })).toBeNull());
  });

  it('shows progress with Cancel while sending', async () => {
    vi.spyOn(api(), 'backfillOffer').mockResolvedValue(null);
    vi.spyOn(api(), 'backfillStatus').mockResolvedValue(status('running'));
    const cancel = vi.spyOn(api(), 'backfillCancel').mockResolvedValue(undefined);
    render(<TelemetryBackfillOffer destinationId="otlp" label="OTLP" on />);
    expect(await screen.findByText('Sending history to OTLP: 120 spans, 4 events, session 2 of 3.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledWith('otlp');
  });

  it('after a failure, says so and offers to send the rest in the same window, with no picker', async () => {
    vi.spyOn(api(), 'backfillOffer').mockResolvedValue({ ...offer(12 * DAY), resuming: true });
    vi.spyOn(api(), 'backfillStatus').mockResolvedValue(status('failed', { reason: 'export_failed' }));
    const start = vi.spyOn(api(), 'backfillStart').mockResolvedValue({ ok: true });
    render(<TelemetryBackfillOffer destinationId="otlp" label="OTLP" on />);
    expect(await screen.findByText("Sending stopped: OTLP didn't accept part of it. What was sent stays sent.")).toBeInTheDocument();
    expect(screen.getByText('Send the rest of the history to OTLP? It picks up after what was already sent, in the same window as before.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send the rest' }));
    await waitFor(() => expect(start).toHaveBeenCalled());
  });

  it('says when history was sent, with no offer left', async () => {
    vi.spyOn(api(), 'backfillOffer').mockResolvedValue(null);
    vi.spyOn(api(), 'backfillStatus').mockResolvedValue(status('done', { metricPoints: 1 }));
    render(<TelemetryBackfillOffer destinationId="otlp" label="OTLP" on />);
    expect(await screen.findByText('History sent to OTLP: 120 spans, 4 events, 1 metric point.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it("says plainly when the destination isn't reachable, both on start and when sending stopped for it", async () => {
    vi.spyOn(api(), 'backfillOffer').mockResolvedValue(offer(2 * DAY));
    const statusSpy = vi.spyOn(api(), 'backfillStatus').mockResolvedValue(null);
    vi.spyOn(api(), 'backfillStart').mockResolvedValue({ ok: false, reason: 'not_reachable' });
    const { unmount } = render(<TelemetryBackfillOffer destinationId="azure" label="Azure Application Insights" on />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Azure Application Insights isn't reachable right now, so nothing was sent. Try again once it's receiving live data.");
    unmount();
    statusSpy.mockResolvedValue(status('failed', { destinationId: 'azure', reason: 'not_reachable' }));
    render(<TelemetryBackfillOffer destinationId="azure" label="Azure Application Insights" on />);
    expect(await screen.findByText("Sending stopped: Azure Application Insights isn't reachable right now. What was sent stays sent.")).toBeInTheDocument();
  });
});

