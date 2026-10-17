import { Modal } from '../../components/Modal';

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
    <Modal open onClose={onDecline} title="Share telemetry with the developer?" width="w-[440px]">
      <div className="px-5 pb-5 pt-3 space-y-3" data-testid="feedback-telemetry-prompt">
        <p className="text-sm text-ctp-subtext1">
          Telemetry export is on. Clubhouse can also send its user activity and errors to the developer, with the same redaction as your own export, so feedback comes with context. Only &quot;User activity and errors&quot; is sent, never prompts, file contents or paths.
        </p>
        <div className="text-sm text-ctp-text">
          Telemetry will go to:
          <ul className="mt-1 font-mono text-xs text-ctp-subtext1" data-testid="feedback-telemetry-hosts">
            {ask.hosts.map((h) => <li key={h}>{h}</li>)}
          </ul>
        </div>
        <p className="text-xs text-ctp-subtext0">You can change this later in Settings, Logging, under Telemetry export.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onDecline} className="px-3 py-1.5 text-sm rounded-md text-ctp-subtext1 hover:text-ctp-text hover:bg-surface-0">Not now</button>
          <button type="button" onClick={onShare} className="px-3 py-1.5 text-sm rounded-md bg-ctp-accent text-white">Share</button>
        </div>
      </div>
    </Modal>
  );
}
