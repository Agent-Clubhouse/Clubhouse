import { CONTROLLER_LINK_STATE_LABELS, REMOTE_DISPATCHER_STATE_LABELS, type RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
import { useDispatcherPresence } from './useDispatcherPresence';

/** Why there is no chat to show for it on this computer, in words. */
function explain(remote: RemoteDispatcherPresence): string {
  switch (remote.state) {
    case 'offline': return `${remote.machineName} is offline. Its Dispatcher’s chat shows here when it’s connected.`;
    case 'off': return `${remote.machineName}’s Dispatcher is turned off. Its chat shows here when it’s on.`;
    case 'unknown': return `${remote.machineName} hasn’t shared its Dispatcher yet.`;
    default: return `This computer isn’t connected to ${remote.machineName} yet. Its Dispatcher’s chat shows here once it is.`;
  }
}

/**
 * What the Dispatcher pane shows for another computer's Dispatcher while this
 * computer has no chat from it (it isn't connected from this side, or the
 * Dispatcher is off). Picking it never does nothing, and the chat takes this
 * place as soon as it arrives.
 */
export function RemoteDispatcherDetails({ machineId }: { machineId: string }) {
  const presence = useDispatcherPresence();
  const remote = presence?.remotes.find((r) => r.machineId === machineId);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 bg-ctp-base px-7 text-center" data-testid="remote-dispatcher-details" role="status">
      {remote ? (
        <>
          <p className="text-sm font-medium text-ctp-text">{remote.label}</p>
          <p className="max-w-md text-sm text-ctp-subtext0">{explain(remote)}</p>
          <p className="text-xs text-ctp-overlay1">
            {REMOTE_DISPATCHER_STATE_LABELS[remote.state]}. {CONTROLLER_LINK_STATE_LABELS[remote.link.state]}{remote.link.reason ? `: ${remote.link.reason}` : ''}
          </p>
        </>
      ) : (
        <p className="max-w-md text-sm text-ctp-subtext0">This computer’s list of Dispatchers on other computers doesn’t have that one.</p>
      )}
    </div>
  );
}
