/**
 * Settings → Logging → Telemetry export (docs/telemetry-otel-spec.md §6.8).
 *
 * Each of the user's own destinations has its own collapsible panel with its
 * own switch, level, preset, health and Send test event; several can be on at
 * once (spec §6.11). A panel starts open when it's on or has an error. The
 * developer destination lives on the Feedback page, next to the connection it
 * depends on (#2097). Secrets never come back from main: the status carries
 * masked forms only.
 */
import { useCallback, useEffect, useState } from 'react';
import { Toggle } from '../../components/Toggle';
import { Modal } from '../../components/Modal';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { SettingsSection, SettingsField, settingsInput } from './SettingsLayout';
import { useUIStore } from '../../stores/uiStore';
import type { TelemetryLevel } from '../../../shared/telemetry/attributes';
import type {
  OtlpHeaderInput,
  TelemetryAcknowledgements,
  TelemetryConfirmation,
  TelemetryDestinationStatus,
  TelemetryEnableResult,
  TelemetryFilterPreset,
  TelemetryPreviewItem,
  TelemetryStatus,
  TelemetryTestReport,
} from '../../../shared/telemetry/settings-types';
import { Button } from '../../components/Button';

const LEVELS: Array<{ id: TelemetryLevel; label: string; desc: string }> = [
  { id: 'errors', label: 'Errors only', desc: 'Crashes and failed operations' },
  { id: 'standard', label: 'Standard', desc: 'Errors plus lifecycle, flows and metrics' },
  { id: 'detailed', label: 'Detailed', desc: 'Standard plus high-volume detail' },
];

const PRESETS: Array<{ id: TelemetryFilterPreset; label: string; desc: string }> = [
  { id: 'all', label: 'Everything at this level', desc: 'All flows, events and metrics the level allows' },
  {
    id: 'user_activity',
    label: 'User activity and errors',
    desc: 'Errors, crashes, feature use, agent and chat lifecycle and permission decisions; no high-volume spans and almost no metrics',
  },
];

function healthText(d: TelemetryDestinationStatus): { text: string; bad: boolean } | null {
  const h = d.health;
  const at = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : '');
  switch (h.state) {
    case 'ok': return { text: `Sending · last export ${at(h.lastSuccessAt)}`, bad: false };
    case 'pending': return { text: 'On · waiting for the first export', bad: false };
    case 'failing': return { text: `Failing: ${h.message ?? 'export failed'}`, bad: true };
    case 'error': return { text: `Not sending: ${h.message ?? 'could not start'}`, bad: true };
    default: return null;
  }
}

/** Spec §5.5. Shown in the consent step and in "Learn what's sent". */
export const NEVER_SENT = [
  'Prompts, missions, personas and agent messages',
  'Terminal output, tool input and output',
  'File contents, diffs, commit messages and search queries',
  'File paths, repository URLs and branch names',
  'Project, agent, canvas and profile names',
  'Error messages and raw stack traces (only sanitized frames)',
  'Hostnames, IP addresses, tokens and environment variables',
];

const SENT = [
  'Exceptions and crash events, with the error type only',
  'Durations and outcomes of flows such as startup, agent spawn and updates',
  'Counts and timings, bucketed where needed',
  'App version, OS type and version, CPU architecture',
  'A random install ID you can reset, and a per-run session ID',
];

const isLoopbackHost = (host?: string) => !!host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

interface PendingConfirm {
  needs: TelemetryConfirmation[];
  host?: string;
  /** Every host that would receive data, for the consent step. */
  hosts?: string[];
  /** Framebriar's host when the dialog also confirms it. */
  followHost?: string;
  /** Destination id the user is turning on or saving. */
  target: string;
  retry: (ack: TelemetryAcknowledgements) => Promise<TelemetryEnableResult>;
  onSuccess?: (status: TelemetryStatus) => void;
}

const api = () => window.clubhouse.telemetrySettings;

/** Opened in the browser by the user; Clubhouse makes no request itself (spec §6.10). */
export const WORKBOOK_DOCS_URL = 'https://github.com/Agent-Clubhouse/Clubhouse/blob/main/docs/telemetry/workbook/README.md';

const inputClass = `${settingsInput} w-full`;
const rowLabelClass = 'text-[13px] text-ctp-text';
const linkClass = 'text-xs text-ctp-link hover:underline cursor-pointer';

/** One word for a closed panel's header: whether the destination is sending. */
function destinationSummary(on: boolean, configured: boolean, dest?: TelemetryDestinationStatus): string {
  if (on && dest && healthText(dest)?.bad) return 'On, not sending';
  if (on) return 'On';
  return configured ? 'Off' : 'Not set up';
}

/** A destination panel whose body folds away; the header keeps its name and state. */
function CollapsiblePanel({ id, title, summary, defaultOpen, forceOpen, children }: {
  id: string;
  title: string;
  summary: string;
  defaultOpen: boolean;
  /** Opens the panel when it turns true (an error to show). */
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const bodyId = `telemetry-panel-body-${id}`;
  return (
    <section className="mt-[22px]" aria-label={title} data-testid={`telemetry-panel-${id}`}>
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`text-ctp-overlay1 transition-transform ${open ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[13px] font-semibold text-ctp-text">{title}</span>
        <span className="ml-auto text-xs text-ctp-overlay1" data-testid={`telemetry-panel-summary-${id}`}>{summary}</span>
      </button>
      {/* Kept mounted while closed: aria-controls needs its target, and typed drafts survive a fold. */}
      <div id={bodyId} className="mt-3 space-y-3" hidden={!open}>{children}</div>
    </section>
  );
}

export function TelemetrySettingsSection() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState<{ panel: string; message: string } | null>(null);
  const setSettingsSubPage = useUIStore((st) => st.setSettingsSubPage);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [test, setTest] = useState<{ panel: string; report: TelemetryTestReport | 'sending' } | null>(null);
  const [preview, setPreview] = useState<TelemetryPreviewItem[] | null>(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClearQueue, setConfirmClearQueue] = useState(false);

  // App Insights form
  const [connectionString, setConnectionString] = useState('');
  const [replacingCs, setReplacingCs] = useState(false);
  // OTLP form
  const [endpoint, setEndpoint] = useState('');
  const [headers, setHeaders] = useState<Array<OtlpHeaderInput & { stored?: string }>>([]);
  const [sampleRate, setSampleRate] = useState('1');

  /** Status updates never overwrite fields the user is still editing. */
  const applyStatus = useCallback((s: TelemetryStatus) => setStatus(s), []);
  const syncOtlpForm = useCallback((s: TelemetryStatus) => {
    setEndpoint(s.otlp?.endpoint ?? '');
    setHeaders((s.otlp?.headers ?? []).map((h) => ({ name: h.name, stored: h.last4 })));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api()?.getStatus?.().then((s) => {
      if (cancelled || !s) return;
      setStatus(s);
      syncOtlpForm(s);
      setSampleRate(String(s.sampleRate ?? 1));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [syncOtlpForm]);

  const handleResult = useCallback(async (
    panel: string,
    target: string,
    run: (ack: TelemetryAcknowledgements) => Promise<TelemetryEnableResult>,
    ack: TelemetryAcknowledgements = {},
    onSuccess?: (status: TelemetryStatus) => void,
  ): Promise<boolean> => {
    setError(null);
    const result = await run(ack);
    if (result.status) applyStatus(result.status);
    if (result.ok) {
      onSuccess?.(result.status);
      return true;
    }
    if ('needs' in result) {
      setConfirm({ needs: result.needs, host: result.host, hosts: result.hosts, followHost: result.followHost, target, retry: run, onSuccess });
      return false;
    }
    setError({ panel, message: 'message' in result ? result.message : 'Something went wrong.' });
    return false;
  }, [applyStatus]);

  if (!status || !status.available) return null;

  const dest = (id: string) => status.destinations.find((d) => d.id === id);
  const azure = dest('azure');
  const otlp = dest('otlp');
  const framebriar = dest('framebriar');
  const azureOn = azure?.enabled === true;
  const otlpOn = otlp?.enabled === true;

  const confirmAndRetry = async () => {
    if (!confirm) return;
    const ack: TelemetryAcknowledgements = {};
    if (confirm.needs.includes('consent')) ack.consent = true;
    if (confirm.needs.includes('weak_storage')) ack.weakStorage = true;
    if (confirm.needs.includes('destination') || confirm.needs.includes('consent')) ack.host = confirm.host;
    // The dialog listed Framebriar's host: confirm exactly the one shown.
    if (confirm.followHost) ack.followHost = confirm.followHost;
    const pending = confirm;
    setConfirm(null);
    await handleResult(pending.target, pending.target, pending.retry, ack, pending.onSuccess);
  };

  // onSuccess also runs after a confirmed retry (e.g. weak storage), so the
  // typed secret never lingers in the input.
  const saveCs = () => handleResult('azure', 'azure', (ack) => api().saveAzure(connectionString, ack), {}, () => {
    setConnectionString('');
    setReplacingCs(false);
  });

  const saveOtlp = () => handleResult('otlp', 'otlp', (ack) =>
    api().saveOtlp({ endpoint, headers: headers.map(({ name, value }) => ({ name, value: value || undefined })) }, ack), {}, syncOtlpForm);

  const runTest = async (panel: string) => {
    setTest({ panel, report: 'sending' });
    setTest({ panel, report: await api().sendTest(panel) });
  };

  const openPreview = async () => setPreview(await api().getPreview());

  const testLine = (panel: string) => {
    if (!test || test.panel !== panel) return null;
    if (test.report === 'sending') return <span className="text-xs text-ctp-overlay1">Sending…</span>;
    const r = test.report;
    const detail = [r.httpStatus ? `HTTP ${r.httpStatus}` : null, r.latencyMs !== undefined ? `${r.latencyMs} ms` : null].filter(Boolean).join(', ');
    return (
      <span className={`text-xs ${r.ok ? 'text-ctp-subtext1' : 'text-ctp-error'}`} data-testid={`telemetry-test-result-${panel}`}>
        {r.ok ? '✓ ' : ''}{r.message}{detail ? ` (${detail})` : ''}
      </span>
    );
  };

  const errorLine = (panel: string) =>
    error?.panel === panel ? <p className="text-xs text-ctp-error mt-2" role="alert">{error.message}</p> : null;

  return (
    <div data-testid="telemetry-settings">
      <SettingsSection title="Telemetry export" />
      <p className="text-xs text-ctp-overlay1 mb-1">
        Send anonymized diagnostics to your own Azure Application Insights, an OpenTelemetry backend, or both, each with its own level. Nothing goes to the Clubhouse developer unless you turn that on in Settings, Feedback. Off by default.
      </p>
      <p className="text-xs text-ctp-overlay1">
        Telemetry is separate from local logging, and each has its own switch.{' '}
        <button type="button" className={linkClass} onClick={() => setLearnOpen(true)}>Learn what's sent</button>
      </p>

      {status.secureStorage === 'unavailable' && (
        <p className="text-xs text-ctp-warning mt-2">
          Secure storage is not available on this system, so a connection string or header values can't be saved.
        </p>
      )}

      {/* Azure Application Insights */}
      <CollapsiblePanel
        id="azure"
        title="Azure Application Insights"
        summary={destinationSummary(azureOn, status.azure.configured, azure)}
        defaultOpen={azureOn || error?.panel === 'azure'}
        forceOpen={error?.panel === 'azure'}
      >
        <SettingsField label="Send telemetry">
          <Toggle
            aria-label="Send telemetry to Application Insights"
            checked={azureOn}
            disabled={!status.azure.configured && !azureOn}
            onChange={(v) => void handleResult('azure', 'azure', (ack) => api().setEnabled('azure', v, ack))}
          />
        </SettingsField>
        <div>
          <label className="block text-xs text-ctp-overlay1 mb-1" htmlFor="telemetry-cs">Connection string</label>
          {status.azure.configured && !replacingCs ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-ctp-subtext1 font-mono" data-testid="telemetry-cs-masked">
                IKey …{status.azure.ikeyLast4} · {status.azure.host}
              </span>
              <button type="button" className={linkClass} onClick={() => setReplacingCs(true)}>Replace</button>
              <button type="button" className={linkClass} onClick={() => void handleResult('azure', 'azure', () => api().clearAzure())}>Clear</button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                id="telemetry-cs"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
                placeholder="InstrumentationKey=…;IngestionEndpoint=https://…"
                value={connectionString}
                onChange={(e) => setConnectionString(e.target.value)}
              />
              <Button kind="ghost" disabled={!connectionString.trim()} onClick={() => void saveCs()}>Save</Button>
              {replacingCs && <Button kind="ghost" onClick={() => setReplacingCs(false)}>Cancel</Button>}
            </div>
          )}
          {errorLine('azure')}
        </div>
        {azure && (
          <DestinationControls
            dest={azure}
            onFilter={(level, preset) => void handleResult('azure', 'azure', () => api().setFilter('azure', level, preset))}
          />
        )}
        <div className="flex items-center gap-3">
          <Button kind="ghost" disabled={!azure?.active} onClick={() => void runTest('azure')}>Send test event</Button>
          {testLine('azure')}
        </div>
      </CollapsiblePanel>


      {/* Preview, Workbook */}
      <div className="mt-3">
        <button type="button" className={linkClass} onClick={() => void openPreview()}>Preview data</button>
        {azureOn && (
          <>
            <span className="text-xs text-ctp-overlay1 mx-2">·</span>
            <button type="button" className={linkClass} onClick={() => void window.clubhouse.app.openExternalUrl(WORKBOOK_DOCS_URL)}>
              Get the Clubhouse Workbook
            </button>
          </>
        )}
        {errorLine('general')}
      </div>

      {/* Other destinations */}
      <CollapsiblePanel
        id="otlp"
        title="Other destinations"
        summary={destinationSummary(otlpOn, status.otlp.configured, otlp)}
        defaultOpen={otlpOn || error?.panel === 'otlp'}
        forceOpen={error?.panel === 'otlp'}
      >
        <div className="text-xs text-ctp-overlay1">Send to an OpenTelemetry (OTLP) backend, on its own or alongside Application Insights.</div>
        <SettingsField label="Send to OTLP">
          <Toggle
            aria-label="Send telemetry to OTLP"
            checked={otlpOn}
            disabled={!status.otlp.configured && !otlpOn}
            onChange={(v) => void handleResult('otlp', 'otlp', (ack) => api().setEnabled('otlp', v, ack))}
          />
        </SettingsField>
        <div>
          <label className="block text-xs text-ctp-overlay1 mb-1" htmlFor="telemetry-otlp-endpoint">Endpoint</label>
          <input
            id="telemetry-otlp-endpoint"
            className={inputClass}
            placeholder="http://localhost:4318"
            spellCheck={false}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <p className="text-xs text-ctp-overlay1 mt-1">HTTPS is required, except for a collector on this computer.</p>
        </div>
        <div>
          <div className="text-xs text-ctp-overlay1 mb-1">Headers</div>
          <div className="space-y-2">
            {headers.map((h, i) => (
              <div key={i} className="flex gap-2">
                <input
                  aria-label={`Header ${i + 1} name`}
                  className={inputClass}
                  placeholder="x-api-key"
                  spellCheck={false}
                  value={h.name}
                  onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <input
                  aria-label={`Header ${i + 1} value`}
                  type="password"
                  autoComplete="off"
                  className={inputClass}
                  placeholder={h.stored !== undefined ? `••••${h.stored}` : 'value'}
                  value={h.value ?? ''}
                  onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <Button kind="ghost" aria-label={`Remove header ${i + 1}`} onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
          </div>
          <button type="button" className={`${linkClass} mt-2`} onClick={() => setHeaders([...headers, { name: '' }])}>Add header</button>
        </div>
        <div className="text-xs text-ctp-overlay1">Protocol: HTTP/JSON</div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button kind="ghost" disabled={!endpoint.trim()} onClick={() => void saveOtlp()}>Save</Button>
          {status.otlp.configured && (
            <Button kind="ghost" onClick={() => void handleResult('otlp', 'otlp', () => api().clearOtlp(), {}, syncOtlpForm)}>Clear</Button>
          )}
        </div>
        {errorLine('otlp')}
        <div className="flex items-center gap-4">
          <span className={rowLabelClass}>Metric temporality</span>
          {(['cumulative', 'delta'] as const).map((t) => (
            <label key={t} className="text-xs text-ctp-subtext1 flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="telemetry-temporality"
                checked={status.otlp.temporality === t}
                onChange={() => void handleResult('otlp', 'otlp', () => api().setAdvanced({ otlpTemporality: t }))}
              />
              {t === 'cumulative' ? 'Cumulative' : 'Delta'}
            </label>
          ))}
        </div>
        {otlp && (
          <DestinationControls
            dest={otlp}
            onFilter={(level, preset) => void handleResult('otlp', 'otlp', () => api().setFilter('otlp', level, preset))}
          />
        )}
        <div className="flex items-center gap-3">
          <Button kind="ghost" disabled={!otlp?.active} onClick={() => void runTest('otlp')}>Send test event</Button>
          {testLine('otlp')}
        </div>
      </CollapsiblePanel>

      {/* The developer destination follows Feedback, so it's set up there (#2097). */}
      {framebriar && (
        <p className="text-xs text-ctp-overlay1 mt-[22px]" data-testid="telemetry-developer-pointer">
          Telemetry for the Clubhouse developer is {framebriar.enabled ? 'on' : 'off'}. It&apos;s set in{' '}
          <button type="button" className={linkClass} onClick={() => setSettingsSubPage('feedback')}>Settings, Feedback</button>.
        </p>
      )}

      {/* Advanced */}
      <details className="mt-[22px] pt-3 border-t border-surface-0">
        <summary className="text-[13px] font-semibold text-ctp-text cursor-pointer">Advanced</summary>
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-[13px] text-ctp-text w-44" htmlFor="telemetry-sample-rate">Trace sample rate</label>
            <input
              id="telemetry-sample-rate"
              type="number"
              min={0.01}
              max={1}
              step={0.05}
              className={`${inputClass} w-24`}
              value={sampleRate}
              onChange={(e) => setSampleRate(e.target.value)}
            />
            <Button
              kind="ghost"
              onClick={() => void handleResult('general', 'general', () => api().setAdvanced({ sampleRate: Number(sampleRate) }), {}, (s) => setSampleRate(String(s.sampleRate)))}
            >
              Apply
            </Button>
          </div>
          <div className="text-[13px] text-ctp-text">
            Install ID <span className="font-mono text-xs text-ctp-subtext1">{status.installId ?? 'created when telemetry is first turned on'}</span>
            <div className="text-xs text-ctp-overlay1 mt-px">
              Random, not derived from this computer. Resetting it also rotates the hash salt, so nothing sent before can be linked to anything sent after.
            </div>
            <button type="button" className={`${linkClass} mt-1`} onClick={() => setConfirmReset(true)}>Reset telemetry ID</button>
          </div>
          <div className="text-[13px] text-ctp-text">
            Offline queue (Application Insights only): {status.offlineItems} {status.offlineItems === 1 ? 'item' : 'items'}{' '}
            <button type="button" className={linkClass} onClick={() => setConfirmClearQueue(true)}>Clear</button>
          </div>
          <div>
            <button type="button" className={linkClass} onClick={() => setConfirmDelete(true)}>Delete local telemetry data</button>
          </div>
        </div>
      </details>

      <ConfirmDialog confirm={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void confirmAndRetry()} />

      <Modal open={learnOpen} onClose={() => setLearnOpen(false)} title="What telemetry sends" width="w-[520px]">
        <WhatsSent />
      </Modal>

      <Modal open={preview !== null} onClose={() => setPreview(null)} title="Preview data" width="w-[640px]">
        {preview && preview.length === 0 ? (
          <p className="text-[13px] text-ctp-subtext1">
            Nothing has been exported in this session yet. Turn telemetry on, or send a test event, to see exactly what leaves this computer.
          </p>
        ) : (
          <pre className="text-xs text-ctp-subtext1 bg-ctp-crust border border-surface-0 rounded-md p-3 max-h-[60vh] overflow-auto" data-testid="telemetry-preview">
            {/* Where each item went, by its name in Settings (never a service id); the item itself is shown as sent. */}
            {JSON.stringify(preview?.map((item) => (item.destination
              ? { ...item, destination: status.destinations.find((d) => d.id === item.destination)?.label ?? item.destination }
              : item)), null, 2)}
          </pre>
        )}
      </Modal>

      <ConfirmDestructiveAction
        open={confirmReset}
        title="Reset telemetry ID?"
        description="A new install ID and hash salt will be created. Data already sent stays in your destination but can't be linked to new data."
        confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void handleResult('general', 'general', () => api().resetId());
        }}
      />
      <ConfirmDestructiveAction
        open={confirmClearQueue}
        title="Clear the offline queue?"
        description="Telemetry that couldn't be sent yet is deleted from this computer and won't reach your destination."
        confirmLabel="Clear"
        onCancel={() => setConfirmClearQueue(false)}
        onConfirm={() => {
          setConfirmClearQueue(false);
          void handleResult('general', 'general', () => api().clearOffline());
        }}
      />
      <ConfirmDestructiveAction
        open={confirmDelete}
        title="Delete local telemetry data?"
        description="Telemetry is turned off, and the install ID, hash salt and offline queue are removed from this computer. Your destination settings are kept."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void handleResult('general', 'general', () => api().deleteLocalData());
        }}
      />
    </div>
  );
}

function WhatsSent() {
  return (
    <div className="space-y-4 text-[13px] text-ctp-subtext1">
      <div>
        <div className="text-ctp-text font-semibold mb-1">Sent</div>
        <ul className="list-disc pl-5 space-y-0.5">{SENT.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
      <div>
        <div className="text-ctp-text font-semibold mb-1">Never sent</div>
        <ul className="list-disc pl-5 space-y-0.5">{NEVER_SENT.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
      <p className="text-xs text-ctp-overlay1">
        Everything goes only to the destinations you turn on. Preview data shows each item exactly as it was sent, and where.
      </p>
    </div>
  );
}

function ConfirmDialog({ confirm, onCancel, onConfirm }: { confirm: PendingConfirm | null; onCancel: () => void; onConfirm: () => void }) {
  if (!confirm) return null;
  const host = confirm.host;
  const loopback = isLoopbackHost(host);
  return (
    <Modal open onClose={onCancel} title="Before telemetry starts" width="w-[480px]" testId="telemetry-confirm" footer={
      <>
        <Button kind="ghost" onClick={onCancel}>Cancel</Button>
        <Button kind="primary" onClick={onConfirm}>Continue</Button>
      </>
    }>
      <div className="space-y-4 text-[13px] text-ctp-subtext1">
        {confirm.needs.includes('destination') && !confirm.needs.includes('consent') && (
          loopback
            ? <p>Telemetry will be sent to a collector on this computer ({host}).</p>
            : <p>Telemetry will be sent to {host}. Clubhouse can't see or control what this service does with it.</p>
        )}
        {confirm.needs.includes('weak_storage') && (
          <p>
            This system has no keyring, so the secret will be stored with weak protection. Other programs running as your user could read it.
          </p>
        )}
        {confirm.needs.includes('consent') && (
          <div>
            <p className="mb-1">Telemetry will be sent to:</p>
            <ul className="list-disc pl-5 space-y-0.5 mb-3" data-testid="telemetry-confirm-hosts">
              {(confirm.hosts?.length ? confirm.hosts : host ? [host] : []).map((h) => (
                <li key={h} className="font-mono">{isLoopbackHost(h) ? `${h} (a collector on this computer)` : h}</li>
              ))}
            </ul>
            <p className="mb-2">Clubhouse can't see or control what these services do with it. It sends anonymized diagnostics and never sends:</p>
            <ul className="list-disc pl-5 space-y-0.5">{NEVER_SENT.map((s) => <li key={s}>{s}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** A destination's level, preset and health, inside its panel. Also used on the Feedback page. */
export function DestinationControls({ dest, onFilter }: {
  dest: TelemetryDestinationStatus;
  onFilter: (level: TelemetryLevel, preset: TelemetryFilterPreset) => void;
}) {
  const health = healthText(dest);
  const levelDesc = LEVELS.find((l) => l.id === dest.level)?.desc;
  const presetDesc = PRESETS.find((p) => p.id === dest.preset)?.desc;
  return (
    <div className="space-y-3" data-testid={`telemetry-filter-${dest.id}`}>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-ctp-text">
          <span className="block text-xs text-ctp-overlay1 mb-1">Level</span>
          <select
            aria-label={`${dest.label} level`}
            className={inputClass}
            value={dest.level}
            onChange={(e) => onFilter(e.target.value as TelemetryLevel, dest.preset)}
          >
            {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          {levelDesc && <span className="block text-xs text-ctp-overlay1 mt-1">{levelDesc}</span>}
        </label>
        <label className="text-xs text-ctp-text">
          <span className="block text-xs text-ctp-overlay1 mb-1">What to send</span>
          <select
            aria-label={`${dest.label} filter`}
            className={inputClass}
            value={dest.preset}
            onChange={(e) => onFilter(dest.level, e.target.value as TelemetryFilterPreset)}
          >
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {presetDesc && <span className="block text-xs text-ctp-overlay1 mt-1">{presetDesc}</span>}
        </label>
      </div>
      {health && (
        <p className={`text-xs ${health.bad ? 'text-ctp-error' : 'text-ctp-subtext1'}`} data-testid={`telemetry-health-${dest.id}`}>
          {health.text}
        </p>
      )}
    </div>
  );
}
