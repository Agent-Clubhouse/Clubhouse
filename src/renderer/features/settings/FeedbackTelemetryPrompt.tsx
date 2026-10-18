import { Modal } from '../../components/Modal';
import { settingsHelp } from './SettingsLayout';
import { Button } from '../../components/Button';
import { NEVER_SENT } from './TelemetrySettingsSection';

export interface TelemetryShareAsk {
  /** The developer's host, which the user is confirming. */
  host: string;
  /** Every host that will receive telemetry once confirmed. */
  hosts: string[];
  /** No telemetry consent yet: the prompt is also the consent, so it lists what's never sent. */
  needsConsent?: boolean;
}

/**
 * Asked after connecting Feedback, or when switching developer telemetry on:
 * telemetry goes to a new host only once the user confirms it (consent per
 * host), and this is the consent too when none was given yet. "Not now" keeps
 * the developer destination off; Feedback and screenshots work either way.
 */
export function FeedbackTelemetryPrompt({ ask, onShare, onDecline }: { ask: TelemetryShareAsk; onShare: () => void; onDecline: () => void }) {
  return (
    <Modal open onClose={onDecline} title="Share telemetry with the developer?" width="w-[440px]" footer={
      <>
        <Button onClick={onDecline} kind="ghost">Not now</Button>
        <Button onClick={onShare} kind="primary">Share</Button>
      </>
    }>
      <div className="space-y-3" data-testid="feedback-telemetry-prompt">
        <p className="text-[13px] text-ctp-subtext1">
          Clubhouse can send its user activity and errors to the developer, so feedback comes with context. Only &quot;User activity and errors&quot; is sent, with the same redaction as any telemetry.
        </p>
        {ask.needsConsent && (
          <div className="text-[13px] text-ctp-text" data-testid="feedback-telemetry-never-sent">
            Clubhouse never sends these.
            <ul className="mt-1 list-disc pl-5 text-xs text-ctp-subtext1">
              {NEVER_SENT.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        <div className="text-[13px] text-ctp-text">
          Telemetry will go to these hosts.
          <ul className="mt-1 font-mono text-xs text-ctp-subtext1" data-testid="feedback-telemetry-hosts">
            {ask.hosts.map((h) => <li key={h}>{h}</li>)}
          </ul>
        </div>
        <p className={settingsHelp}>You can change this later in Settings, Feedback.</p>
      </div>
    </Modal>
  );
}
