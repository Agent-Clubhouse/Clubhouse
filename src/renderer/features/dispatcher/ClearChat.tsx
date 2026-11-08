/**
 * Clear chat (#3043): the Dispatcher's ⋯ menu starts its conversation over,
 * after a confirm. The menu has nowhere to draw the confirm, so it asks
 * through requestClearChat and the agent dialog host draws it
 * (ClearChatHost). Clearing never touches what the Dispatcher remembers.
 */
import { useState } from 'react';
import { create } from 'zustand';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { useToastStore } from '../../stores/toastStore';

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
  return (
    <Modal
      open
      onClose={onCancel}
      title="Clear chat?"
      testId="dispatcher-clear-chat-confirm"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button kind="primary" onClick={onConfirm} disabled={busy} data-testid="dispatcher-clear-chat-confirm-button">Clear chat</Button>
      </>}
    >
      <p className="text-[13px] text-ctp-subtext1">
        The conversation starts over. {name} still remembers what you decided and who is doing what, and your agents, connections and Actions stay as they are.
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
      useToastStore.getState().addToast(`Couldn't clear the chat. ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return <ClearChatDialog name={name} busy={busy} onConfirm={() => void confirm()} onCancel={close} />;
}
