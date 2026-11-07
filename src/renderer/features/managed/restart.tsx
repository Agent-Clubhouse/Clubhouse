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
 *
 * "When this turn ends" closes the confirm as soon as it is sent: main holds
 * the wait, which can't be called off (D32). Until it resolves the agent
 * counts as pending, every surface says so, and a second request is told a
 * restart is already waiting rather than being dropped.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

// ── Restarts waiting for a turn to end ──────────────────────────────

export const PENDING_RESTART_NOTE = 'Restarts when this turn ends.';
export const ALREADY_PENDING = 'A restart is already waiting for this turn to end.';

/**
 * Agents with a restart waiting for their turn to end. Main holds the wait
 * (up to 30 minutes) and can't call it off, so the confirm closes as soon as
 * the request is sent and the surfaces show this state until it resolves.
 */
const usePendingRestarts = create<{ byAgent: Record<string, true> }>(() => ({ byAgent: {} }));

export function useRestartPending(agentId: string | undefined): boolean {
  return usePendingRestarts((s) => !!agentId && !!s.byAgent[agentId]);
}

export function isRestartPending(agentId: string): boolean {
  return !!usePendingRestarts.getState().byAgent[agentId];
}

/** Tests only. */
export function resetPendingRestarts(): void {
  usePendingRestarts.setState({ byAgent: {} });
}

/** Ask main to restart once the turn ends, marked pending until main answers. */
async function restartWhenTurnEnds(target: RestartTarget, options: RestartOptions): Promise<string | null> {
  usePendingRestarts.setState((s) => ({ byAgent: { ...s.byAgent, [target.agentId]: true } }));
  try {
    return await runRestart(target, { ...options, whenTurnEnds: true });
  } finally {
    usePendingRestarts.setState((s) => {
      const byAgent = { ...s.byAgent };
      delete byAgent[target.agentId];
      return { byAgent };
    });
  }
}

const toast = (message: string, type: 'error' | 'info') => useToastStore.getState().addToast(message, type);
const restartsLater = (agentName: string) => `${agentName} restarts when this turn ends.`;

/**
 * Restart the running agents that use a part just saved (#2897). The person
 * ticked them in the impact dialog, so there is no second confirm: an idle
 * agent restarts now and a working one when its turn ends. Failures are
 * toasts, apart from the save, which already succeeded.
 */
export function restartAfterSave(targets: RestartTarget[]): void {
  for (const target of targets) {
    void (async () => {
      if (isRestartPending(target.agentId)) { toast(`${target.agentName}: ${ALREADY_PENDING}`, 'info'); return; }
      const working = await isWorking(target.agentId);
      if (working) toast(restartsLater(target.agentName), 'info');
      const failed = working ? await restartWhenTurnEnds(target, {}) : await runRestart(target, {});
      if (failed) toast(`Couldn't restart ${target.agentName}. ${failed}`, 'error');
    })();
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
          : 'Restart keeps the conversation. The new setup applies from the next turn.'}
      </p>
    </Modal>
  );
}

/**
 * Restart with a confirm while working, and the last error, for a surface
 * that draws both itself. `pending` is true while a restart waits for the
 * turn to end; the surface shows PENDING_RESTART_NOTE meanwhile.
 */
export function useManagedRestart(target: RestartTarget | null): {
  restart: (options?: { fresh?: boolean }) => void;
  busy: boolean;
  pending: boolean;
  error: string | null;
  dialog: ReactNode;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ fresh: boolean } | null>(null);
  const busyRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  const pending = useRestartPending(target?.agentId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async (options: RestartOptions) => {
    const t = targetRef.current;
    if (!t) return;
    setConfirm(null);
    setError(null);
    if (options.whenTurnEnds) {
      // The wait can take the whole turn: nothing stays open meanwhile.
      const failed = await restartWhenTurnEnds(t, options);
      if (!failed) return;
      if (mounted.current) setError(failed);
      else toast(`Couldn't restart ${t.agentName}. ${failed}`, 'error');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const failed = await runRestart(t, options);
    busyRef.current = false;
    if (!mounted.current) {
      if (failed) toast(`Couldn't restart ${t.agentName}. ${failed}`, 'error');
      return;
    }
    setBusy(false);
    setError(failed);
  }, []);

  const restart = useCallback((options: { fresh?: boolean } = {}) => {
    const t = targetRef.current;
    if (!t || busyRef.current) return;
    if (isRestartPending(t.agentId)) { setError(ALREADY_PENDING); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void isWorking(t.agentId).then((working) => {
      if (working) {
        busyRef.current = false;
        setBusy(false);
        setConfirm({ fresh: !!options.fresh });
      } else {
        busyRef.current = false;
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

  return { restart, busy, pending, error, dialog };
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
  if (options.whenTurnEnds) {
    // Close the confirm at once; a toast says what happens, and another says if it fails.
    useManagedRestartRequests.setState({ confirm: null });
    toast(restartsLater(pending.agentName), 'info');
    const failed = await restartWhenTurnEnds(pending, options);
    if (failed) toast(`Couldn't restart ${pending.agentName}. ${failed}`, 'error');
    return;
  }
  useManagedRestartRequests.setState({ busy: true });
  const failed = await runRestart(pending, options);
  useManagedRestartRequests.setState({ busy: false, confirm: null });
  if (failed) toast(`Couldn't restart ${pending.agentName}. ${failed}`, 'error');
}

/** The ⋯ menu's Restart: straight away when idle, else the confirm drawn by ManagedRestartHost. */
export async function requestManagedRestart(target: RestartTarget, options: { fresh?: boolean } = {}): Promise<void> {
  if (useManagedRestartRequests.getState().busy) return;
  if (isRestartPending(target.agentId)) {
    toast(`${target.agentName}: ${ALREADY_PENDING}`, 'info');
    return;
  }
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
