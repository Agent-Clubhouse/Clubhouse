import { useState } from 'react';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { useDispatcherStore } from './dispatcherStore';

/**
 * After "Set up later" (#3047): one quiet line above the Dispatcher's chat
 * offering setup again. Hide puts the offer away; setup stays in its menu.
 */
export function SetupOffer({ name }: { name: string }) {
  const setSetupOpen = useDispatcherStore((s) => s.setSetupOpen);
  const [error, setError] = useState<string | null>(null);

  const hide = async () => {
    setError(null);
    try {
      useDispatcherStore.getState().setState(await window.clubhouse.dispatcher.setSetupStatus('done'));
    } catch (err) {
      // telemetry-exempt: shown in the line, which stays.
      setError(`Couldn’t hide this. ${ipcErrorMessage(err)}`);
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-surface-0 text-xs text-ctp-subtext0" data-testid="dispatcher-setup-offer">
      <span className="flex-1 min-w-0 truncate">
        {error ?? `${name} is using the default Behavior and personality. Set it up anytime.`}
      </span>
      <Button onClick={() => setSetupOpen(true)} data-testid="dispatcher-setup-offer-open">Set up</Button>
      <Button kind="quiet" onClick={() => void hide()} data-testid="dispatcher-setup-offer-hide">Hide</Button>
    </div>
  );
}
