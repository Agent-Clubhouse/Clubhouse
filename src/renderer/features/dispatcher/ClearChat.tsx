/**
 * Start new chat (#3043, once Clear chat): the Dispatcher's ⋯ menu starts its
 * conversation over, after a confirm. The menu has nowhere to draw the confirm,
 * so it asks through requestClearChat and the agent dialog host draws it
 * (ClearChatHost). Starting a new chat never touches what the Dispatcher remembers.
 *
 * Restart Dispatcher (#3240, once Start fresh) is the recovery action: it
 * restarts how the Dispatcher does its work, keeping the chat or starting it over
 * too: requestStartFresh, drawn by StartFreshHost. The scopes stay 'work' and
 * 'both' (#3616).
 */
import { useId, useState } from 'react';
import { create } from 'zustand';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { useToastStore } from '../../stores/toastStore';
import type { StartFreshScope } from '../../../shared/dispatcher-types';

const useClearChatRequest = create<{ name: string | null }>(() => ({ name: null }));

/** Ask to clear the Dispatcher's chat: the host shows the confirm. */
export function requestClearChat(name: string): void {
  useClearChatRequest.setState({ name });
}

export function ClearChatDialog({ name, busy, onConfirm, onCancel }: {
  name: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const bodyId = useId();
  return (
    <Modal
      open
      onClose={onCancel}
      title="Start a new chat?"
      aria-describedby={bodyId}
      testId="dispatcher-clear-chat-confirm"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button kind="primary" onClick={onConfirm} disabled={busy} data-testid="dispatcher-clear-chat-confirm-button">Start new chat</Button>
      </>}
    >
      <p id={bodyId} className="text-[13px] text-ctp-subtext1">
        The chat starts over. {name} still remembers what you decided and who is doing what, and keeps working on what it is handling. Your agents, connections and Actions stay as they are.
      </p>
    </Modal>
  );
}

export function ClearChatHost() {
  const name = useClearChatRequest((s) => s.name);
  const [busy, setBusy] = useState(false);
  if (!name) return null;
  const close = () => useClearChatRequest.setState({ name: null });
  const confirm = async () => {
    setBusy(true);
    try {
      await window.clubhouse.dispatcher.clearChat();
      close();
    } catch (err) {
      // telemetry-exempt: shown to the person, who can try again
      useToastStore.getState().addToast(`Couldn't start a new chat. ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return <ClearChatDialog name={name} busy={busy} onConfirm={() => void confirm()} onCancel={close} />;
}

const useStartFreshRequest = create<{ name: string | null }>(() => ({ name: null }));

/** Ask to start the Dispatcher fresh: the host shows the choice. */
export function requestStartFresh(name: string): void {
  useStartFreshRequest.setState({ name });
}

export function StartFreshDialog({ name, busy, onConfirm, onCancel }: {
  name: string;
  busy?: boolean;
  onConfirm: (scope: StartFreshScope) => void;
  onCancel: () => void;
}) {
  const bodyId = useId();
  return (
    <Modal
      open
      onClose={onCancel}
      title="Restart Dispatcher?"
      aria-describedby={bodyId}
      width="w-[420px]"
      testId="dispatcher-start-fresh-confirm"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={() => onConfirm('both')} disabled={busy} data-testid="dispatcher-start-fresh-both">Restart and start new chat</Button>
        <Button kind="primary" onClick={() => onConfirm('work')} disabled={busy} data-testid="dispatcher-start-fresh-work">Restart, keep chat</Button>
      </>}
    >
      <div id={bodyId} className="flex flex-col gap-2 text-[13px] text-ctp-subtext1">
        <p>
          Use this when {name} keeps failing at its work. Anything it is handling or has queued stops, and you may need to ask for it again. Work it already gave to other agents keeps going and is not undone.
        </p>
        <p>
          Restart, keep chat leaves this chat as it is. Restart and start new chat also clears it. Memory, agents, connections, Actions and settings stay as they are either way. If {name} is asleep, the restart happens when it next wakes.
        </p>
      </div>
    </Modal>
  );
}

export function StartFreshHost() {
  const name = useStartFreshRequest((s) => s.name);
  const [busy, setBusy] = useState(false);
  if (!name) return null;
  const close = () => useStartFreshRequest.setState({ name: null });
  const confirm = async (scope: StartFreshScope) => {
    setBusy(true);
    try {
      await window.clubhouse.dispatcher.startFresh(scope);
      close();
    } catch (err) {
      // telemetry-exempt: shown to the person, who can try again
      useToastStore.getState().addToast(`Couldn't restart the Dispatcher. ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return <StartFreshDialog name={name} busy={busy} onConfirm={(scope) => void confirm(scope)} onCancel={close} />;
}
