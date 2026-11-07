/**
 * Restarting a running managed agent (#2896). Restart resumes the same
 * conversation on the new setup; `fresh` (or a CLI change, which main
 * detects) starts a new one. Like the app-update restart, an agent in the
 * middle of a turn asks first: restart when this turn ends, or now.
 *
 * The setup-changed bar and the Setup card hold their own confirm and show
 * errors inline (useManagedRestart). The ⋯ menu has nowhere to draw either,
 * so it goes through requestManagedRestart, whose confirm the agent dialog
 * hosts draw (ManagedRestartHost) and whose errors are toasts.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { useToastStore } from '../../stores/toastStore';
import { errorText, managed, unwrap } from './managedApi';

export interface RestartTarget {
  projectPath: string;
  agentId: string;
  agentName: string;
}

export interface RestartOptions {
  fresh?: boolean;
  whenTurnEnds?: boolean;
}

/** Whether the agent is mid-turn. A failed read counts as working, so a restart never cuts a turn off unasked. */
async function isWorking(agentId: string): Promise<boolean> {
  try {
    return await unwrap(managed().isWorking(agentId));
  } catch {
    // telemetry-exempt: treated as working, so the person is asked before anything stops.
    return true;
  }
}

/** Only the options that are set, so a plain restart sends none. */
function cleanOptions({ fresh, whenTurnEnds }: RestartOptions): RestartOptions {
  return { ...(fresh ? { fresh: true } : {}), ...(whenTurnEnds ? { whenTurnEnds: true } : {}) };
}

/** Restart, returning an error to show, or null. */
async function runRestart(target: RestartTarget, options: RestartOptions): Promise<string | null> {
  try {
    await unwrap(managed().restart(target.projectPath, target.agentId, cleanOptions(options)));
    return null;
  } catch (err) {
    // telemetry-exempt: the caller shows the reason where the person asked to restart.
    return errorText(err);
  }
}

/** Asked while the agent is mid-turn: restart when this turn ends (the default), now, or not at all. */
export function RestartConfirmDialog({ agentName, fresh, busy, onWhenTurnEnds, onNow, onCancel }: {
  agentName: string;
  /** Starts a new conversation rather than resuming this one. */
  fresh: boolean;
  busy?: boolean;
  onWhenTurnEnds: () => void;
  onNow: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Restart ${agentName}?`}
      testId="managed-restart-confirm"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={onNow} disabled={busy} data-testid="managed-restart-now">Restart now</Button>
        <Button kind="primary" onClick={onWhenTurnEnds} disabled={busy} data-testid="managed-restart-when-turn-ends">Restart when this turn ends</Button>
      </>}
    >
      <p className="text-[13px] text-ctp-subtext1">
        {agentName} is in the middle of a turn. {fresh
          ? 'Restarting starts a new conversation. This one stays in History.'
          : 'Restarting resumes this conversation on the new setup.'}
      </p>
    </Modal>
  );
}

/** Restart with a confirm while working, and the last error, for a surface that draws both itself. */
export function useManagedRestart(target: RestartTarget | null): {
  restart: (options?: { fresh?: boolean }) => void;
  busy: boolean;
  error: string | null;
  dialog: ReactNode;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ fresh: boolean } | null>(null);
  const busyRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  const run = useCallback(async (options: RestartOptions) => {
    const t = targetRef.current;
    if (!t) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const failed = await runRestart(t, options);
    busyRef.current = false;
    setBusy(false);
    setConfirm(null);
    setError(failed);
  }, []);

  const restart = useCallback((options: { fresh?: boolean } = {}) => {
    const t = targetRef.current;
    if (!t || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void isWorking(t.agentId).then((working) => {
      if (working) {
        busyRef.current = false;
        setBusy(false);
        setConfirm({ fresh: !!options.fresh });
      } else {
        void run({ fresh: options.fresh });
      }
    });
  }, [run]);

  const dialog = confirm && target ? (
    <RestartConfirmDialog
      agentName={target.agentName}
      fresh={confirm.fresh}
      busy={busy}
      onWhenTurnEnds={() => void run({ fresh: confirm.fresh, whenTurnEnds: true })}
      onNow={() => void run({ fresh: confirm.fresh })}
      onCancel={() => setConfirm(null)}
    />
  ) : null;

  return { restart, busy, error, dialog };
}

// ── The ⋯ menu's restart ────────────────────────────────────────────

interface PendingRestart extends RestartTarget {
  fresh: boolean;
}

interface RestartRequestState {
  confirm: PendingRestart | null;
  busy: boolean;
}

export const useManagedRestartRequests = create<RestartRequestState>(() => ({ confirm: null, busy: false }));

async function restartFromMenu(pending: PendingRestart, options: RestartOptions): Promise<void> {
  useManagedRestartRequests.setState({ busy: true });
  const failed = await runRestart(pending, options);
  useManagedRestartRequests.setState({ busy: false, confirm: null });
  if (failed) useToastStore.getState().addToast(`Couldn't restart ${pending.agentName}. ${failed}`, 'error');
}

/** The ⋯ menu's Restart: straight away when idle, else the confirm drawn by ManagedRestartHost. */
export async function requestManagedRestart(target: RestartTarget, options: { fresh?: boolean } = {}): Promise<void> {
  if (useManagedRestartRequests.getState().busy) return;
  const pending = { ...target, fresh: !!options.fresh };
  if (await isWorking(target.agentId)) {
    useManagedRestartRequests.setState({ confirm: pending });
    return;
  }
  await restartFromMenu(pending, { fresh: pending.fresh });
}

/** Draws the ⋯ menu's restart confirm. Mounted with the other agent dialogs, in both shells. */
export function ManagedRestartHost() {
  const confirm = useManagedRestartRequests((s) => s.confirm);
  const busy = useManagedRestartRequests((s) => s.busy);
  if (!confirm) return null;
  return (
    <RestartConfirmDialog
      agentName={confirm.agentName}
      fresh={confirm.fresh}
      busy={busy}
      onWhenTurnEnds={() => void restartFromMenu(confirm, { fresh: confirm.fresh, whenTurnEnds: true })}
      onNow={() => void restartFromMenu(confirm, { fresh: confirm.fresh })}
      onCancel={() => useManagedRestartRequests.setState({ confirm: null })}
    />
  );
}
