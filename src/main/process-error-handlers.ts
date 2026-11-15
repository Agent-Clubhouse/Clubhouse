import { redactActiveRunText } from '../shared/log-redaction';
import { isFailedCopilotWrite } from './chat/copilot/failed-writes';
import { appLog } from './services/log-service';
import { reportMainProcessError } from './telemetry/crash-handlers';

/** Local catch-all diagnostics. Original errors still reach the existing reporter. */
export function installProcessErrorHandlers(events: Pick<NodeJS.Process, 'on' | 'removeListener'> = process): () => void {
  const uncaught = (err: Error) => {
    appLog('core:process', 'fatal', 'Uncaught exception', {
      meta: { error: redactActiveRunText(err.message), stack: err.stack === undefined ? undefined : redactActiveRunText(err.stack) },
    });
    reportMainProcessError(err, 'uncaught');
  };
  const rejected = (reason: unknown) => {
    const msg = redactActiveRunText(reason instanceof Error ? reason.message : String(reason));
    const stack = reason instanceof Error && reason.stack !== undefined ? redactActiveRunText(reason.stack) : undefined;
    // A failed Copilot message write whose caller already received the error (#2706).
    if (isFailedCopilotWrite(reason)) {
      appLog('core:process', 'warn', 'A Copilot message write failed, and its request already failed with it', { meta: { error: msg, stack } });
      return;
    }
    appLog('core:process', 'error', 'Unhandled promise rejection', { meta: { error: msg, stack } });
    reportMainProcessError(reason, 'unhandled-rejection');
  };
  events.on('uncaughtException', uncaught);
  events.on('unhandledRejection', rejected);
  return () => {
    events.removeListener('uncaughtException', uncaught);
    events.removeListener('unhandledRejection', rejected);
  };
}
