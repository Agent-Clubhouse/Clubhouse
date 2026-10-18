/**
 * Settings › Feedback › Telemetry for the developer (#2097): the developer
 * destination, next to the Feedback connection it depends on. It works on its
 * own; consent and the developer's host are confirmed in one prompt.
 */
import { useCallback, useEffect, useState } from 'react';
import { Toggle } from '../../components/Toggle';
import { Button } from '../../components/Button';
import { SettingsSection, SettingsField, settingsHelp } from './SettingsLayout';
import { DestinationControls } from './TelemetrySettingsSection';
import { FeedbackTelemetryPrompt, type TelemetryShareAsk } from './FeedbackTelemetryPrompt';
import type { TelemetryDestinationStatus, TelemetryEnableResult } from '../../../shared/telemetry/settings-types';

const api = () => window.clubhouse.telemetrySettings;

/** What the developer destination needs confirmed before it can start, or null when nothing. */
export function shareAskFrom(result: TelemetryEnableResult): TelemetryShareAsk | null {
  if (!('needs' in result) || !result.host) return null;
  return { host: result.host, hosts: result.hosts ?? [result.host], needsConsent: result.needs.includes('consent') };
}

/** Turn the developer destination on with what the prompt confirmed. */
export function shareTelemetry(ask: TelemetryShareAsk): Promise<TelemetryEnableResult> {
  return api().setEnabled('framebriar', true, { host: ask.host, ...(ask.needsConsent ? { consent: true } : {}) });
}

/**
 * The switch, level and filter for the developer destination. `refreshKey`
 * reloads it when the page changes the destination itself (the connect prompt).
 */
export function DeveloperTelemetrySection({ refreshKey }: { refreshKey?: unknown }) {
  const [available, setAvailable] = useState(false);
  const [dest, setDest] = useState<TelemetryDestinationStatus | null>(null);
  const [ask, setAsk] = useState<TelemetryShareAsk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const status = await api().getStatus();
      setAvailable(!!status?.available);
      setDest(status?.destinations.find((d) => d.id === 'framebriar') ?? null);
    } catch {
      // telemetry-exempt: the section stays hidden when telemetry can't be read.
      setAvailable(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const apply = (result: TelemetryEnableResult) => {
    const next = result.status?.destinations.find((d) => d.id === 'framebriar');
    if (next) setDest(next);
    if (!result.ok && !('needs' in result)) setError('message' in result ? result.message : 'Something went wrong.');
  };

  const toggle = async (on: boolean) => {
    setError(null);
    const result = await api().setEnabled('framebriar', on, {});
    const needs = on ? shareAskFrom(result) : null;
    if (needs) setAsk(needs);
    else apply(result);
  };

  const share = async () => {
    const pending = ask;
    setAsk(null);
    if (pending) apply(await shareTelemetry(pending));
  };

  if (!available || !dest) return null;

  return (
    <div data-testid="developer-telemetry">
      <SettingsSection title="Telemetry for the developer">
        <p className={settingsHelp}>
          Send user activity and errors to the Clubhouse developer so your feedback comes with context, with the same redaction as any telemetry. It works while Feedback is connected and stays off until you turn it on.
        </p>
        <SettingsField label="Send telemetry">
          <Toggle
            aria-label="Send telemetry to the Clubhouse developer"
            checked={dest.enabled}
            disabled={!dest.configured && !dest.enabled}
            onChange={(v) => void toggle(v)}
          />
        </SettingsField>
        {!dest.configured && (
          <p className={settingsHelp} data-testid="developer-telemetry-needs-feedback">Connect Feedback above first.</p>
        )}
        <DestinationControls
          dest={dest}
          onFilter={(level, preset) => void api().setFilter('framebriar', level, preset).then(apply)}
        />
        <div className="flex items-center gap-3">
          <Button
            kind="ghost"
            disabled={!dest.active}
            onClick={() => void api().sendTest('framebriar').then((r) => setTest(r.message))}
          >
            Send test event
          </Button>
          {test && <span className="text-xs text-ctp-subtext1">{test}</span>}
        </div>
        {error && <p className="text-xs text-ctp-error" role="alert">{error}</p>}
      </SettingsSection>
      {ask && <FeedbackTelemetryPrompt ask={ask} onShare={() => void share()} onDecline={() => setAsk(null)} />}
    </div>
  );
}
