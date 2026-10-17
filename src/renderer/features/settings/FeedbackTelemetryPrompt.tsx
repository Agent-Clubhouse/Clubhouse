import { Modal } from '../../components/Modal';
import { settingsHelp } from './SettingsLayout';
import { Button } from '../../components/Button';

export interface TelemetryShareAsk {
  /** Framebriar's host, which the user is confirming. */
  host: string;
  /** Every host that will receive telemetry once confirmed. */
  hosts: string[];
}

/**
 * Asked after connecting Feedback while telemetry export is on: telemetry goes to a new
 * host only once the user confirms it (consent per host). "Not now" keeps the Framebriar
 * destination off; Feedback and screenshots work either way.
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
          Telemetry export is on. Clubhouse can also send its user activity and errors to the developer, with the same redaction as your own export, so feedback comes with context. Only &quot;User activity and errors&quot; is sent, never prompts, file contents or paths.
        </p>
        <div className="text-[13px] text-ctp-text">
          Telemetry will go to these hosts.
          <ul className="mt-1 font-mono text-xs text-ctp-subtext1" data-testid="feedback-telemetry-hosts">
            {ask.hosts.map((h) => <li key={h}>{h}</li>)}
          </ul>
        </div>
        <p className={settingsHelp}>You can change this later in Settings, Logging, under Telemetry export.</p>
      </div>
    </Modal>
  );
}
