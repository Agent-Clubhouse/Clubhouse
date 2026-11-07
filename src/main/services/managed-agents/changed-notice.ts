/**
 * Tell open windows that something a managed agent's setup-changed bar
 * compares has changed (#2819). Settings writes (CLI, model, Free Agent
 * Mode, orchestration) come through agent-config and the orchestration
 * policy, not the managed service, so they call this after they save.
 */
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';

export function noteManagedSettingsChanged(): void {
  try {
    broadcastToAllWindows(IPC.MANAGED.CHANGED);
  } catch {
    // telemetry-exempt: a refresh notice never fails the settings write
  }
}
