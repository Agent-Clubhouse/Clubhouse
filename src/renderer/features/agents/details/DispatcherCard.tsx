/**
 * An agent's Dispatcher card in Details (#3049, part of #3034). It replaces
 * the "Connect to Dispatcher" switch that sat in the Orchestration card, and
 * holds the agent's description (#2583).
 *
 * The title is the Dispatcher's name, and the switch on the right connects
 * the agent:
 * - Off: "not connected".
 * - Turning on: "Asking what it does…" until the agent answers with its card
 *   (#3041), then the fields fill in. No answer: "No description yet", with Edit.
 * - On: When to reach it, Owns, and what the Dispatcher can do to this agent,
 *   with Edit and Permissions.
 * - Edit: both fields in place, with Save and Cancel. Saving replaces what the
 *   agent wrote.
 * - Permissions: a popover of the Dispatcher's permissions that reach this
 *   agent, Off, Ask or Allow each, and a link to all of them.
 * - Turning it off takes effect at once, with Undo in a toast. The card is
 *   kept, so turning it back on is instant.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../../../../shared/types';
import type { AgentGrantsView, GrantChangeMode } from '../../../../shared/agent-grant-changes';
import { AGENT_CARD_FIELD_MAX, type AgentCardView } from '../../../../shared/dispatcher-agent-card';
import type { DispatcherState } from '../../../../shared/dispatcher-types';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { Toggle } from '../../../components/Toggle';
import { LAYER_PORTAL_ATTR } from '../../../components/layers';
import { useToastStore } from '../../../stores/toastStore';
import { reportChromeActionFailed } from '../../../chrome/telemetry';
import { useDispatcherStore } from '../../dispatcher/dispatcherStore';
import { onAgentCardChanged, saveAgentCard, useAgentCard } from '../../dispatcher/agent-card-client';
import { AgentGrantsSettings } from '../AgentGrantsSettings';
import type { OrchestrationState } from '../helpers/orchestration-hooks';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { CONNECTED_TARGET, reachRows, reachSummary, type ReachRow } from './dispatcher-card-model';

/** The Dispatcher's name as the user set it, or its working name. */
export function dispatcherName(state: Pick<DispatcherState, 'config'> | null | undefined): string {
  return state?.config?.name?.trim() || 'Dispatcher';
}

export const ASKING_TEXT = 'Asking what it does…';
export const NO_DESCRIPTION_TEXT = 'No description yet';
/** How long "Asking what it does…" shows after turning on when nothing comes back, before "No description yet". */
export const TURNING_ON_MS = 15_000;

export type DispatcherCardStatus = 'off' | 'asking' | 'ready' | 'none';

/** Which state the card is in, from the switch and the agent's card. */
export function cardStatus(on: boolean, view: AgentCardView | null, turningOn: boolean): DispatcherCardStatus {
  if (!on) return 'off';
  if (view?.state === 'ready') return 'ready';
  if (view?.state === 'asking' || turningOn) return 'asking';
  return 'none';
}

/** The header's one line for each state. */
export function cardSummary(status: DispatcherCardStatus, view: AgentCardView | null): string {
  switch (status) {
    case 'off': return 'not connected';
    case 'asking': return ASKING_TEXT;
    case 'none': return NO_DESCRIPTION_TEXT;
    case 'ready': return view?.card?.purpose?.trim() || 'connected';
  }
}

const TEXTAREA_CLASS = 'w-full min-h-[44px] px-2 py-1 rounded-md border border-surface-1 bg-ctp-crust text-xs text-ctp-text leading-normal resize-y focus-ring';
const LINK_CLASS = 'text-ctp-link hover:underline cursor-pointer focus-ring rounded-sm';
const SAVE_FAILED = 'Couldn’t save. Try again.';

/** The Dispatcher's permissions, read from main and kept here so the summary and the popover agree. */
function useDispatcherGrants(state: DispatcherState | null, enabled: boolean) {
  const [view, setView] = useState<AgentGrantsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const path = state?.path ?? null;
  const id = state?.agentId ?? null;
  useEffect(() => {
    if (!enabled || !path || !id) return;
    let alive = true;
    setFailed(false);
    Promise.resolve().then(() => window.clubhouse.agent.getGrants(path, id)).then(
      (next) => { if (alive) setView(next); },
      // telemetry-exempt: the card says it couldn't read them; Permissions offers to try again.
      () => { if (alive) setFailed(true); },
    );
    return () => { alive = false; };
  }, [enabled, path, id, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { view, setView, failed, reload, path, id };
}

export function DispatcherCard({ agent, orch, open, onToggle }: {
  agent: Pick<Agent, 'id' | 'name'>;
  orch: Pick<OrchestrationState, 'policy' | 'saving' | 'setPolicy'>;
  open: boolean;
  onToggle: () => void;
}) {
  const dispatcher = useDispatcherStore((s) => s.state);
  const name = dispatcherName(dispatcher);
  const addToast = useToastStore((s) => s.addToast);
  const on = !!orch.policy?.connectToDispatcher;

  const [switchError, setSwitchError] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const card = useAgentCard(agent.id, on, on);
  const grants = useDispatcherGrants(dispatcher, on);
  const [editing, setEditing] = useState(false);
  // The Permissions button while its popover is open.
  const [permissionsAnchor, setPermissionsAnchor] = useState<HTMLElement | null>(null);
  const closePermissions = useCallback(() => setPermissionsAnchor(null), []);
  const [allPermissionsOpen, setAllPermissionsOpen] = useState(false);

  // "Asking what it does…" right after turning on, until main says the card changed or a while passes.
  useEffect(() => {
    if (!turningOn) return;
    const off = onAgentCardChanged((id) => { if (id === agent.id) setTurningOn(false); });
    const timer = setTimeout(() => setTurningOn(false), TURNING_ON_MS);
    return () => { off(); clearTimeout(timer); };
  }, [turningOn, agent.id]);
  // Another agent's edits, popover and errors never carry over.
  useEffect(() => { setEditing(false); closePermissions(); setSwitchError(null); setTurningOn(false); }, [agent.id, closePermissions]);
  useEffect(() => { if (!on) { setEditing(false); closePermissions(); } }, [on, closePermissions]);

  const setConnected = useCallback(async (next: boolean): Promise<boolean> => {
    setSwitchError(null);
    const ok = await orch.setPolicy({ connectToDispatcher: next });
    if (!ok) setSwitchError(SAVE_FAILED);
    return ok;
  }, [orch]);

  const onSwitch = async (next: boolean) => {
    if (next) {
      if (await setConnected(true)) setTurningOn(card.view?.state !== 'ready');
      return;
    }
    setTurningOn(false);
    if (!(await setConnected(false))) return;
    addToast(`${agent.name} is no longer connected to ${name}.`, 'info', {
      label: 'Undo',
      onClick: () => { void setConnected(true); },
    });
  };

  const status = cardStatus(on, card.view, turningOn || (on && card.loading));
  const reach = grants.view ? reachRows(grants.view) : null;

  return (
    <>
      <DetailsCard
        id="dispatcher"
        title={name}
        summary={cardSummary(status, card.view)}
        open={open}
        onToggle={onToggle}
        action={orch.policy ? (
          <Toggle
            checked={on}
            disabled={orch.saving}
            onChange={(next) => void onSwitch(next)}
            aria-label={`Connect ${agent.name} to ${name}`}
            data-testid="dispatcher-card-switch"
          />
        ) : undefined}
      >
        {status === 'off' ? (
          <CardNote>Turn this on so {name} can message {agent.name} and get its reports.</CardNote>
        ) : editing ? (
          <CardEdit
            agentId={agent.id}
            agentName={agent.name}
            view={card.view}
            onSaved={(view) => { card.set(view); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            {status === 'asking' && <CardNote><span data-testid="dispatcher-card-asking">{ASKING_TEXT}</span></CardNote>}
            {status === 'none' && (
              <CardNote>
                <span data-testid="dispatcher-card-none">
                  {NO_DESCRIPTION_TEXT}.{card.view?.waitingToAsk ? ` ${agent.name} is asked the next time it runs.` : ''}
                </span>
              </CardNote>
            )}
            {status === 'ready' && (
              <>
                <CardRow label="When to reach it" labelWidth="wide" testId="dispatcher-card-contact">
                  {card.view?.card?.contactWhen || <span className="text-ctp-overlay1">Not given</span>}
                </CardRow>
                <CardRow label="Owns" labelWidth="wide" testId="dispatcher-card-owns">
                  {card.view?.card?.owns || <span className="text-ctp-overlay1">Not given</span>}
                </CardRow>
              </>
            )}
            <CardRow label={`${name} can`} labelWidth="wide" testId="dispatcher-card-reach">
              {reach ? reachSummary(reach)
                : grants.failed ? <span className="text-ctp-overlay1">Couldn’t read its permissions.</span>
                  : <span className="text-ctp-overlay1">Loading…</span>}
            </CardRow>
            <div className="flex items-center gap-1.5 pr-3.5 pl-[33px] pt-1">
              <Button onClick={() => setEditing(true)} data-testid="dispatcher-card-edit">Edit</Button>
              <Button
                onClick={(e) => {
                  if (grants.failed) grants.reload();
                  const button = e.currentTarget;
                  setPermissionsAnchor((current) => (current ? null : button));
                }}
                aria-expanded={!!permissionsAnchor}
                aria-haspopup="dialog"
                data-testid="dispatcher-card-permissions"
              >
                Permissions
              </Button>
            </div>
          </>
        )}
        {switchError && <p className="pr-3.5 pl-[33px] pt-1 text-xs text-ctp-error" role="alert" data-testid="dispatcher-card-error">{switchError}</p>}
      </DetailsCard>
      {permissionsAnchor && (
        <PermissionsPopover
          anchor={permissionsAnchor}
          name={name}
          agentName={agent.name}
          rows={reach}
          failed={grants.failed}
          onSet={async (row, mode) => {
            if (!grants.path || !grants.id) return;
            grants.setView(await window.clubhouse.agent.setGrant(grants.path, grants.id, { action: row.action, target: CONNECTED_TARGET, mode }));
          }}
          onShowAll={() => { closePermissions(); setAllPermissionsOpen(true); }}
          onClose={closePermissions}
        />
      )}
      {allPermissionsOpen && grants.path && grants.id && (
        <Modal
          open
          onClose={() => { setAllPermissionsOpen(false); grants.reload(); }}
          title={`${name}’s Clubhouse permissions`}
          width="w-[620px] max-w-[calc(100vw-32px)]"
          testId="dispatcher-card-all-permissions"
        >
          <div className="max-h-[70vh] overflow-y-auto">
            <AgentGrantsSettings agent={{ id: grants.id, name }} projectPath={grants.path} />
          </div>
        </Modal>
      )}
    </>
  );
}

/** Both fields in place, with Save and Cancel. */
function CardEdit({ agentId, agentName, view, onSaved, onCancel }: {
  agentId: string;
  agentName: string;
  view: AgentCardView | null;
  onSaved: (view: AgentCardView) => void;
  onCancel: () => void;
}) {
  const ids = { contact: useId(), owns: useId(), note: useId() };
  const [contactWhen, setContactWhen] = useState(view?.card?.contactWhen ?? '');
  const [owns, setOwns] = useState(view?.card?.owns ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = !contactWhen.trim() && !owns.trim() && !view?.card?.purpose;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveAgentCard(agentId, { contactWhen, owns }));
    } catch (err) {
      reportChromeActionFailed('agent_settings_save', err);
      setError(SAVE_FAILED);
      setSaving(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-2 pr-3.5 pl-[33px] pt-1 text-xs"
      data-testid="dispatcher-card-editor"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
    >
      <label htmlFor={ids.contact} className="text-ctp-overlay1">When to reach it</label>
      <textarea
        id={ids.contact}
        value={contactWhen}
        maxLength={AGENT_CARD_FIELD_MAX}
        onChange={(e) => setContactWhen(e.target.value)}
        aria-describedby={ids.note}
        className={TEXTAREA_CLASS}
        autoFocus
        data-testid="dispatcher-card-edit-contact"
      />
      <label htmlFor={ids.owns} className="text-ctp-overlay1">Owns</label>
      <textarea
        id={ids.owns}
        value={owns}
        maxLength={AGENT_CARD_FIELD_MAX}
        onChange={(e) => setOwns(e.target.value)}
        aria-describedby={ids.note}
        className={TEXTAREA_CLASS}
        data-testid="dispatcher-card-edit-owns"
      />
      <p id={ids.note} className="text-ctp-overlay1">Saving replaces what {agentName} wrote.</p>
      {error && <p className="text-ctp-error" role="alert" data-testid="dispatcher-card-edit-error">{error}</p>}
      <div className="flex items-center gap-1.5">
        <Button kind="primary" onClick={() => void save()} disabled={saving || empty} data-testid="dispatcher-card-save">Save</Button>
        <Button onClick={onCancel} disabled={saving} data-testid="dispatcher-card-cancel">Cancel</Button>
      </div>
    </div>
  );
}

const MODES: ReadonlyArray<{ mode: GrantChangeMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'ask', label: 'Ask' },
  { mode: 'allow', label: 'Allow' },
];

const POPOVER_W = 300;

/** The Dispatcher's permissions that reach this agent, placed under the Permissions button. */
function PermissionsPopover({ anchor, name, agentName, rows, failed, onSet, onShowAll, onClose }: {
  anchor: HTMLElement;
  name: string;
  agentName: string;
  rows: ReachRow[] | null;
  failed: boolean;
  onSet: (row: ReachRow, mode: GrantChangeMode) => Promise<void>;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [pending, setPending] = useState<Record<string, GrantChangeMode>>({});
  const [error, setError] = useState<string | null>(null);

  // Focus moves in, and back to the button when it closes.
  useEffect(() => {
    el.current?.focus();
    return () => { if (anchor.isConnected) anchor.focus(); };
  }, [anchor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (el.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [anchor, onClose]);

  const set = async (row: ReachRow, mode: GrantChangeMode) => {
    setError(null);
    setPending((p) => ({ ...p, [row.action]: mode }));
    try {
      await onSet(row, mode);
    } catch (err) {
      reportChromeActionFailed('agent_settings_save', err);
      setError('Couldn’t save that change, so it wasn’t changed. Try again.');
    }
    setPending((p) => {
      const rest = { ...p };
      delete rest[row.action];
      return rest;
    });
  };

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(POPOVER_W, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
  const top = Math.min(rect.bottom + 6, Math.max(12, window.innerHeight - 420));

  return createPortal(
    <div
      ref={el}
      role="dialog"
      tabIndex={-1}
      aria-labelledby={headingId}
      data-testid="dispatcher-card-permissions-popover"
      {...{ [LAYER_PORTAL_ATTR]: '' }}
      style={{ left, top, width }}
      className="fixed z-dropdown max-h-[400px] overflow-y-auto rounded-lg border border-surface-1 bg-ctp-mantle shadow-lg outline-none py-2 text-xs"
    >
      <p id={headingId} className="px-3 pb-1 text-[12.5px] font-semibold text-ctp-text">What {name} can do to {agentName}</p>
      <p className="px-3 pb-2 text-ctp-overlay1">These apply to every agent connected to {name}.</p>
      {failed && <p className="px-3 pb-2 text-ctp-error" role="alert">Couldn’t read {name}’s permissions.</p>}
      {!rows && !failed && <p className="px-3 pb-2 text-ctp-overlay1">Loading…</p>}
      {rows && (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const mode = pending[row.action] ?? row.mode;
            const locked = row.everyAgent;
            return (
              <li key={row.action} className="px-3 py-1 flex flex-col gap-0.5" data-testid={`dispatcher-card-permission-${row.action}`}>
                <span className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-ctp-text">{row.label}</span>
                  <span role="radiogroup" aria-label={row.label} className="flex items-center gap-2">
                    {MODES.map((m) => (
                      <label key={m.mode} className={`flex items-center gap-1 ${locked ? 'text-ctp-overlay0 cursor-not-allowed' : 'text-ctp-subtext1 cursor-pointer'}`}>
                        <input
                          type="radio"
                          name={`${headingId}-${row.action}`}
                          value={m.mode}
                          checked={mode === m.mode}
                          disabled={locked || row.action in pending}
                          onChange={() => void set(row, m.mode)}
                          className="w-3 h-3 accent-ctp-accent shrink-0 disabled:cursor-not-allowed"
                        />
                        {m.label}
                      </label>
                    ))}
                  </span>
                </span>
                {locked && <span className="text-ctp-overlay1">Set for every agent. Change it in all permissions.</span>}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="px-3 pt-1 text-ctp-error" role="alert">{error}</p>}
      <div className="px-3 pt-2">
        <button type="button" className={LINK_CLASS} onClick={onShowAll} data-testid="dispatcher-card-all-permissions-link">
          All Clubhouse permissions
        </button>
      </div>
    </div>,
    document.body,
  );
}
