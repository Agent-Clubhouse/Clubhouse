/**
 * Settings › Dispatcher (#3046, part of #3034, merged with #2815): one page
 * for the app-wide Dispatcher.
 *
 * - The switch that turns it on (#2535). Its row and view are in the new
 *   layout only, so on the classic layout a switch that's off stays off (#2565).
 * - Identity: setup again, name, color, icon and personality (#3047's field).
 * - Behavior (#3045): the level, the provider it runs on, auto-sleep and
 *   today's usage, conversations apart from background work (#3040).
 *   Choose models yourself (#3191) swaps the provider row for one row per
 *   job, talking with you and working in the background, each with its own
 *   provider, model, effort and context; Behavior then sets only how often
 *   it checks in.
 * - Connected agents: one list across projects (DispatcherConnectedAgents).
 * - Lead (#3351): one computer's Dispatcher for the whole Annex Network, shown
 *   only in a network with another computer (DispatcherLeadSection).
 * - Reset, at the bottom: Forget everything, behind a confirmation. It clears
 *   memory only.
 *
 * Access and "runs in" are gone for the Dispatcher. Model and context are
 * Behavior's unless Choose models yourself is on. Its instructions, orchestration settings and
 * folder can't change here or anywhere else.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { DISPATCHER_CLASSIC_MESSAGE, DISPATCHER_PROJECT_ID, type DispatcherState } from '../../../shared/dispatcher-types';
import type { Agent, DurableAgentConfig, DurableConfigUpdates } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { AGENT_IDLE_SLEEP_MINUTES, formatIdleMinutes, normalizeIdleSleep } from '../../../shared/idle-sleep';
import { describeUsage } from '../../../shared/dispatcher-settings-page';
import type { DispatcherUsageSplit } from '../../../shared/dispatcher-usage';
import { Button } from '../../components/Button';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { EmojiPicker } from '../../components/EmojiPicker';
import { ImageCropDialog } from '../../components/ImageCropDialog';
import { Toggle } from '../../components/Toggle';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useContextWindowOptions } from '../../hooks/useContextWindowOptions';
import { ContextWindowSelect, contextWindowHelp } from '../agents/ContextWindowField';
import { EffortSelect, effortHelp, useModelEfforts } from '../managed/settings-fields';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { AgentAvatar } from '../agents/AgentAvatar';
import { useAppIdleMinutes, SELECT_CLASS } from '../agents/details/AutoSleepRow';
import { dispatcherName } from '../agents/details/DispatcherCard';
import { useDispatcherRead } from '../dispatcher/useDispatcherEnabled';
import { useProviderName } from '../dispatcher/BehaviorChip';
import { openAutoSettings, openDispatcherSetup } from '../dispatcher/dispatcherNav';
import {
  DISPATCHER_NAME_MAX,
  DISPATCHER_PERSONALITY_PRESETS,
  PERSONALITY_PRESET_LABELS,
  PERSONALITY_TEXT_MAX,
  cleanDispatcherName,
  isPersonalityPreset,
  presetForText,
  presetText,
  type DispatcherPersonality,
} from '../../../shared/dispatcher-personality';
import {
  DISPATCHER_BEHAVIORS,
  DISPATCHER_BEHAVIOR_LABELS,
  DISPATCHER_ROLES,
  behaviorAutoNote,
  behaviorDescription,
  canSetUpAuto,
  isDispatcherBehavior,
  type DispatcherBehaviorState,
  type DispatcherRole,
} from '../../../shared/dispatcher-behavior';
import { DEFAULT_DISPATCHER_MODELS_STATE, DISPATCHER_MODELS_APPLY_NOTE, DISPATCHER_ROLE_LABELS, type DispatcherModelsState, type DispatcherModelsUpdate, type DispatcherRoleModel } from '../../../shared/dispatcher-models';
import { ConnectedAgentsSection } from './DispatcherConnectedAgents';
import { LeadSection } from './DispatcherLeadSection';
import { SettingsBlock, SettingsField, SettingsPage, SettingsSection, settingsError, settingsHelp, settingsInput, settingsLabel, settingsTextArea } from './SettingsLayout';

const TITLE = 'Dispatcher';
const DESCRIPTION = 'One agent for the whole app. It remembers what you decided, checks in on your agents and gets work going across projects.';

/** The line under the switch: what it is doing, and which setting to change if it can't be turned on here. */
export function dispatcherSwitchHelp({ enabled, classic }: Pick<DispatcherState, 'enabled' | 'classic'>): string {
  if (classic && enabled) {
    return 'On because you turned it on before. It has no row here because its row and view are in the new layout only. To use it, turn off Classic layout in Settings > Display & UI, then restart Clubhouse. You can turn it off here, and on the classic layout it can’t be turned back on.';
  }
  if (classic) {
    return DISPATCHER_CLASSIC_MESSAGE;
  }
  const kept = 'Its folder and memory are kept, so turning it back on carries on where it left off.';
  return enabled
    ? `On by default in the new layout. It stays asleep until you start it. Turning it off stops it. ${kept}`
    : `On by default in the new layout, and turned off here. ${kept}`;
}

/** Saves to the Dispatcher's record; main mirrors identity and settings onto its chat and broadcasts the new state. */
function useDispatcherSave(state: DispatcherState | null) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = state?.path ?? null;
  const id = state?.config?.id ?? null;

  const run = async (write: (path: string, id: string) => Promise<unknown>): Promise<boolean> => {
    if (!path || !id) return false;
    setSaving(true);
    setError(null);
    try {
      await write(path, id);
      return true;
    } catch (err) {
      // telemetry-exempt: shown in the section, which keeps the saved values.
      setError(`Couldn’t save. ${ipcErrorMessage(err)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };
  return {
    saving,
    error,
    saveConfig: (updates: DurableConfigUpdates) => run((p, i) => window.clubhouse.agent.updateDurableConfig(p, i, updates)),
    saveIdentity: (updates: { name?: string; color?: string; icon?: string | null; emoji?: string | null }) =>
      run((p, i) => window.clubhouse.agent.updateDurable(p, i, updates)),
    run,
  };
}

/** The Dispatcher's record as AgentAvatar takes it. */
function avatarAgent(config: DurableAgentConfig): Agent {
  return {
    id: config.id, name: config.name, color: config.color, icon: config.icon, emoji: config.emoji ?? undefined,
    kind: 'durable', status: 'sleeping', projectId: DISPATCHER_PROJECT_ID,
  } as Agent;
}

/** Its image icon as a data URL, read from main when the record names one. */
function useIconData(icon: string | undefined): string | undefined {
  const [data, setData] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!icon) { setData(undefined); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.readIcon(icon)).then(
      (url) => { if (alive) setData(url ?? undefined); },
      // telemetry-exempt: the avatar shows initials instead.
      () => { if (alive) setData(undefined); },
    );
    return () => { alive = false; };
  }, [icon]);
  return data;
}

/**
 * Personality (#3047's field): a preset fills the text, and the text is exactly
 * what it's told. Editing the text makes it Custom, as in setup.
 */
function PersonalityField({ personality }: { personality: DispatcherPersonality }) {
  const [draft, setDraft] = useState<DispatcherPersonality>(personality);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only a change to what's saved resets the draft; other state broadcasts leave an edit alone.
  useEffect(() => { setDraft({ preset: personality.preset, text: personality.text }); }, [personality.preset, personality.text]);
  const changed = draft.text !== personality.text || draft.preset !== personality.preset;
  const empty = !draft.text.trim();

  const pick = (value: string) => {
    if (!isPersonalityPreset(value)) return;
    setDraft((d) => ({ preset: value, text: presetText(value, d.text) }));
  };
  const edit = (text: string) => setDraft({ preset: presetForText(text), text });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Main broadcasts the new state, which this field then shows.
      await window.clubhouse.dispatcher.setPersonality(draft);
    } catch (err) {
      // telemetry-exempt: shown under the field, which keeps the draft.
      setError(`Couldn’t save. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsField
        label="Personality"
        htmlFor="dispatcher-personality-preset"
        help={PERSONALITY_PRESET_LABELS[draft.preset].description}
      >
        <select
          id="dispatcher-personality-preset"
          className={SELECT_CLASS}
          value={draft.preset}
          disabled={saving}
          onChange={(e) => pick(e.target.value)}
          data-testid="dispatcher-personality-preset"
        >
          {DISPATCHER_PERSONALITY_PRESETS.map((preset) => <option key={preset} value={preset}>{PERSONALITY_PRESET_LABELS[preset].label}</option>)}
        </select>
      </SettingsField>
      <div className="pb-2" data-testid="dispatcher-personality-field">
        <label htmlFor="dispatcher-personality" className="block text-xs text-ctp-overlay1 mb-1">What it’s told</label>
        <textarea
          id="dispatcher-personality"
          className={`${settingsTextArea} min-h-[88px]`}
          value={draft.text}
          maxLength={PERSONALITY_TEXT_MAX}
          disabled={saving}
          onChange={(e) => edit(e.target.value)}
          aria-describedby="dispatcher-personality-help"
          data-testid="dispatcher-personality"
        />
        <p id="dispatcher-personality-help" className={`${settingsHelp} mt-1`}>
          {empty ? 'Empty text uses Concise.' : 'Added to its instructions exactly as written. Its chat follows it from its next start.'}
        </p>
        {changed && (
          <div className="flex items-center gap-2 mt-2">
            <Button kind="primary" disabled={saving} onClick={() => void save()} data-testid="dispatcher-personality-save">Save</Button>
            <Button kind="quiet" disabled={saving} onClick={() => setDraft(personality)} data-testid="dispatcher-personality-cancel">Cancel</Button>
          </div>
        )}
        {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-personality-error">{error}</p>}
      </div>
    </>
  );
}

function IdentitySection({ state, config }: { state: DispatcherState; config: DurableAgentConfig }) {
  const { saving, error, saveIdentity, run } = useDispatcherSave(state);
  const [name, setName] = useState(config.name);
  const nameSeen = useRef(config.name);
  const [showEmoji, setShowEmoji] = useState(false);
  const [cropping, setCropping] = useState<string | null>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const iconData = useIconData(config.icon);
  useEffect(() => {
    if (nameSeen.current === config.name) return;
    nameSeen.current = config.name;
    setName(config.name);
  }, [config.name]);

  const confirmName = async () => {
    const trimmed = cleanDispatcherName(name);
    if (!trimmed) { setName(config.name); return; }
    if (trimmed !== config.name && !(await saveIdentity({ name: trimmed }))) setName(config.name);
  };

  const pickImage = async () => {
    const dataUrl = await window.clubhouse.agent.pickIcon();
    if (dataUrl) setCropping(dataUrl);
  };
  const removeIcon = () => (config.emoji
    ? saveIdentity({ emoji: null })
    : run((p, i) => window.clubhouse.agent.removeIcon(p, i)));

  return (
    <SettingsSection title="Identity">
      <SettingsField label="Setup" help="Name, look, Behavior and personality one step at a time, with Try it out to hear how it sounds.">
        <Button onClick={openDispatcherSetup} data-testid="dispatcher-open-setup">Set up…</Button>
      </SettingsField>
      <SettingsField label="Name" htmlFor="dispatcher-name" help="Shows in the sidebar, in its chat and on your phone. Its internal agent appears as Dispatcher controller.">
        <input
          id="dispatcher-name"
          className={`${settingsInput} w-48`}
          value={name}
          maxLength={DISPATCHER_NAME_MAX}
          disabled={saving}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void confirmName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') { e.preventDefault(); setName(config.name); }
          }}
          data-testid="dispatcher-name"
        />
      </SettingsField>
      <SettingsField label="Color">
        <div role="radiogroup" aria-label="Color" className="flex gap-2">
          {AGENT_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={config.color === c.id}
              aria-label={c.label}
              disabled={saving}
              onClick={() => { if (c.id !== config.color) void saveIdentity({ color: c.id }); }}
              className={`w-[18px] h-[18px] rounded-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 focus-ring ${
                config.color === c.id ? 'outline outline-2 outline-offset-2 outline-ctp-text' : ''
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      </SettingsField>
      <SettingsField label="Icon" help="An image or emoji in place of its initials.">
        <div className="relative flex items-center gap-2">
          <AgentAvatar agent={avatarAgent(config)} size="xs" iconUrl={iconData} />
          <Button onClick={() => void pickImage()} disabled={saving}>Choose image…</Button>
          <Button kind="quiet" ref={emojiButton} onClick={() => setShowEmoji((v) => !v)} disabled={saving}>Emoji…</Button>
          {(config.emoji || (config.icon && iconData)) && (
            <Button kind="quiet" onClick={() => void removeIcon()} disabled={saving} data-testid="dispatcher-icon-remove">Remove</Button>
          )}
          {showEmoji && (
            <div className="absolute top-8 right-0 z-dropdown">
              <EmojiPicker
                onSelect={(emoji) => { setShowEmoji(false); void saveIdentity({ emoji }); }}
                onClose={() => setShowEmoji(false)}
              />
            </div>
          )}
        </div>
      </SettingsField>
      <PersonalityField personality={state.personality} />
      {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-identity-error">{error}</p>}
      {cropping && (
        <ImageCropDialog
          imageDataUrl={cropping}
          maskShape="circle"
          onConfirm={(cropped) => {
            setCropping(null);
            void run((p, i) => window.clubhouse.agent.saveIcon(p, i, cropped));
          }}
          onCancel={() => setCropping(null)}
        />
      )}
    </SettingsSection>
  );
}

/**
 * Behavior (#3045), the same setting as the composer chip: both show main's
 * state, so they stay in step. With the models chosen by hand (#3191) it
 * covers only how often it checks in, and Auto's note doesn't apply.
 */
export function BehaviorField({ behavior, modelsByHand = false }: { behavior: DispatcherBehaviorState; modelsByHand?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerName = useProviderName(behavior.provider);
  const note = modelsByHand ? null : behaviorAutoNote(behavior.auto, providerName);

  const change = async (value: string) => {
    if (!isDispatcherBehavior(value) || value === behavior.level) return;
    setSaving(true);
    setError(null);
    try {
      await window.clubhouse.dispatcher.setBehavior(value);
    } catch (err) {
      // telemetry-exempt: shown under the field, which keeps the saved level.
      setError(`Couldn’t change it. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsField
      label="Behavior"
      htmlFor="dispatcher-behavior"
      help={(
        <span className="flex flex-col gap-1.5">
          <span>
            {modelsByHand ? 'Covers how often it checks in. You choose its models below.' : 'Covers which models it uses and how often it checks in.'}
            {' '}{behaviorDescription(behavior.level, modelsByHand)}
          </span>
          {note && <span data-testid="dispatcher-behavior-auto-note">{note}</span>}
          {!modelsByHand && canSetUpAuto(behavior.auto) && (
            <span><Button onClick={openAutoSettings} data-testid="dispatcher-behavior-setup-auto">Set up Auto</Button></span>
          )}
          {error && <span className={settingsError} role="alert" data-testid="dispatcher-behavior-error">{error}</span>}
        </span>
      )}
    >
      <select
        id="dispatcher-behavior"
        className={SELECT_CLASS}
        value={behavior.level}
        disabled={saving}
        onChange={(e) => void change(e.target.value)}
        data-testid="dispatcher-behavior"
      >
        {DISPATCHER_BEHAVIORS.map((level) => <option key={level} value={level}>{DISPATCHER_BEHAVIOR_LABELS[level].label}</option>)}
      </select>
    </SettingsField>
  );
}

/** Sends a Choose models yourself change to main, which broadcasts the new state. */
function useModelsSave() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (update: DispatcherModelsUpdate) => {
    setSaving(true);
    setError(null);
    try {
      await window.clubhouse.dispatcher.setModels(update);
    } catch (err) {
      // telemetry-exempt: shown under the row, which keeps the saved pick.
      setError(`Couldn’t save. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, save };
}

type CliChoice = { id: string; displayName: string };

/**
 * One job's pick (#3191): provider, model, effort and context, each from what
 * that CLI lists for the folder its agent runs in. A choice a CLI doesn't
 * offer shows why in place of its control.
 */
export function RoleModelRow({ role, pick, path, cliChoices }: {
  role: DispatcherRole;
  pick: DispatcherRoleModel;
  path: string;
  cliChoices: CliChoice[];
}) {
  const { saving, error, save } = useModelsSave();
  const id = useId();
  const { options: models, loading: modelsLoading } = useModelOptions(pick.provider, path);
  const { levelsFor, loading: effortsLoading } = useModelEfforts(pick.provider, path);
  const levels = levelsFor(pick.model);
  const contextOptions = useContextWindowOptions(true, path, pick.provider, pick.model);
  // A saved pick the list doesn't have (yet) still shows as itself.
  const modelChoices = models.some((o) => o.id === pick.model) ? models : [...models, { id: pick.model, label: pick.model }];
  const providers = cliChoices.some((o) => o.id === pick.provider) ? cliChoices : [...cliChoices, { id: pick.provider, displayName: pick.provider }];
  const { label, help } = DISPATCHER_ROLE_LABELS[role];
  const send = (fields: Omit<Extract<DispatcherModelsUpdate, { role: DispatcherRole }>, 'role'>): void => { void save({ role, ...fields }); };

  return (
    <SettingsBlock>
      <div data-testid={`dispatcher-models-${role}`}>
        <div className="text-[13px] text-ctp-text">{label}</div>
        <p className={`${settingsHelp} mt-px mb-2`}>{help}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <label htmlFor={`${id}-provider`} className={settingsLabel}>Provider</label>
            <select
              id={`${id}-provider`}
              className={`${SELECT_CLASS} w-full`}
              value={pick.provider}
              disabled={saving}
              onChange={(e) => { if (e.target.value !== pick.provider) send({ provider: e.target.value }); }}
              data-testid={`dispatcher-models-${role}-provider`}
            >
              {providers.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-model`} className={settingsLabel}>Model</label>
            <select
              id={`${id}-model`}
              className={`${SELECT_CLASS} w-full`}
              value={pick.model}
              disabled={saving || modelsLoading}
              onChange={(e) => { if (e.target.value !== pick.model) send({ model: e.target.value }); }}
              data-testid={`dispatcher-models-${role}-model`}
            >
              {modelChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-effort`} className={settingsLabel}>Effort</label>
            <EffortSelect
              id={`${id}-effort`}
              value={pick.effort ?? ''}
              levels={levels}
              disabled={saving || effortsLoading || (levels.length === 0 && !pick.effort)}
              className={`${SELECT_CLASS} w-full`}
              onChange={(next) => send({ effort: next || null })}
              testId={`dispatcher-models-${role}-effort`}
            />
          </div>
          <div data-testid={`dispatcher-models-${role}-context`}>
            <label htmlFor={`${id}-context`} className={settingsLabel}>{contextOptions?.label ?? 'Context'}</label>
            <span className="text-xs" title={contextWindowHelp(contextOptions)}>
              <ContextWindowSelect
                id={`${id}-context`}
                options={contextOptions}
                value={pick.contextWindow ?? undefined}
                disabled={saving}
                className={`${SELECT_CLASS} w-full`}
                onChange={(next) => send({ contextWindow: next })}
              />
            </span>
          </div>
        </div>
        {!effortsLoading && levels.length === 0 && <p className={`${settingsHelp} mt-2`}>{effortHelp(levels, false)}</p>}
        {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid={`dispatcher-models-${role}-error`}>{error}</p>}
      </div>
    </SettingsBlock>
  );
}

/**
 * Choose models yourself (#3191): the switch, and one row per job while it's
 * on. Off, Behavior gives the models, as before.
 */
export function ChooseModelsField({ models, chatPath, workPath, cliChoices }: {
  models: DispatcherModelsState;
  chatPath: string | null;
  workPath: string | null;
  cliChoices: CliChoice[];
}) {
  const { saving, error, save } = useModelsSave();
  const paths: Record<DispatcherRole, string | null> = { chat: chatPath, work: workPath };
  return (
    <>
      <SettingsField
        label="Choose models yourself"
        help={models.byHand
          ? `You pick the model for each part of its work. ${DISPATCHER_MODELS_APPLY_NOTE}`
          : 'Pick the provider, model and effort for each part of its work, in place of Behavior’s.'}
      >
        <Toggle
          aria-label="Choose models yourself"
          checked={models.byHand}
          disabled={saving}
          onChange={(on) => void save({ byHand: on })}
          data-testid="dispatcher-models-by-hand"
        />
      </SettingsField>
      {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-models-error">{error}</p>}
      {models.byHand && DISPATCHER_ROLES.map((role) => {
        const pick = models[role];
        const path = paths[role];
        return pick && path ? <RoleModelRow key={role} role={role} pick={pick} path={path} cliChoices={cliChoices} /> : null;
      })}
    </>
  );
}

/** Today's usage split (#3040), read when the page opens. */
function useDispatcherUsage(): { usage: DispatcherUsageSplit | null; failed: boolean } {
  const [usage, setUsage] = useState<DispatcherUsageSplit | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.dispatcher.getUsage()).then(
      (next) => { if (alive) setUsage(next); },
      // telemetry-exempt: the usage rows say it couldn't be read.
      () => { if (alive) setFailed(true); },
    );
    return () => { alive = false; };
  }, []);
  return { usage, failed };
}

/** Usage today, on whichever providers it ran on: conversations, then background work. */
function UsageRows() {
  const { usage, failed } = useDispatcherUsage();
  const pending = failed ? 'Couldn’t read it.' : 'Reading';
  return (
    <>
      <SettingsField label="Conversations today" help="Your chats with it and the work you hand it." testId="dispatcher-usage-conversations">
        <span className="text-xs text-ctp-subtext1" data-testid="dispatcher-usage-conversations-value">{usage ? describeUsage(usage.conversations) : pending}</span>
      </SettingsField>
      <SettingsField label="Background work today" help="Check-ins and memory upkeep it runs on its own." testId="dispatcher-usage-background">
        <span className="text-xs text-ctp-subtext1" data-testid="dispatcher-usage-background-value">{usage ? describeUsage(usage.background) : pending}</span>
      </SettingsField>
    </>
  );
}

function BehaviorSection({ state, config }: { state: DispatcherState; config: DurableAgentConfig }) {
  const { saving, error, saveConfig } = useDispatcherSave(state);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledIds = useOrchestratorStore((s) => s.enabled);
  const loadOrchestrators = useOrchestratorStore((s) => s.loadSettings);
  useEffect(() => { void loadOrchestrators(); }, [loadOrchestrators]);
  const appMinutes = useAppIdleMinutes();
  const [switchTo, setSwitchTo] = useState<string | null>(null);

  const name = dispatcherName(state);
  const orchestrator = config.orchestrator ?? '';
  // The current CLI stays listed even when it has since been turned off for new agents.
  const cliChoices = allOrchestrators.filter((o) => enabledIds.includes(o.id) || o.id === orchestrator);
  const switchName = allOrchestrators.find((o) => o.id === switchTo)?.displayName ?? switchTo ?? '';
  const idle = normalizeIdleSleep(config.idleSleep);
  const idleValue = typeof idle === 'number' ? String(idle) : idle;
  const minutes: number[] = [...AGENT_IDLE_SLEEP_MINUTES];
  if (typeof idle === 'number' && !minutes.includes(idle)) minutes.push(idle);
  minutes.sort((a, b) => a - b);

  // A state from before #3191 has no models: Behavior's, as before.
  const models = state.models ?? DEFAULT_DISPATCHER_MODELS_STATE;
  const byHand = models.byHand;

  return (
    <SettingsSection title="Behavior">
      <BehaviorField behavior={state.behavior} modelsByHand={byHand} />
      <ChooseModelsField models={models} chatPath={state.chatPath} workPath={state.path} cliChoices={cliChoices} />
      {!byHand && <SettingsField label="Runs on" htmlFor="dispatcher-runs-on" help="Switching starts a fresh conversation. Its memory stays, so it picks up from what it remembers.">
        <select
          id="dispatcher-runs-on"
          className={SELECT_CLASS}
          value={orchestrator}
          disabled={saving}
          onChange={(e) => { if (e.target.value && e.target.value !== orchestrator) setSwitchTo(e.target.value); }}
          data-testid="dispatcher-runs-on"
        >
          {!orchestrator && <option value="">App default</option>}
          {cliChoices.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
        </select>
      </SettingsField>}
      <SettingsField label="Auto-sleep" htmlFor="dispatcher-auto-sleep" help="A message to it wakes it again.">
        <select
          id="dispatcher-auto-sleep"
          className={SELECT_CLASS}
          value={idleValue}
          disabled={saving}
          onChange={(e) => {
            const v = e.target.value;
            void saveConfig({ idleSleep: v === 'inherit' ? null : v === 'never' ? 'never' : normalizeIdleSleep(Number(v)) });
          }}
          data-testid="dispatcher-auto-sleep"
        >
          <option value="never">Never</option>
          <option value="inherit">App default ({formatIdleMinutes(appMinutes)})</option>
          {minutes.map((m) => <option key={m} value={String(m)}>After {formatIdleMinutes(m)}</option>)}
        </select>
      </SettingsField>
      <UsageRows />
      {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-save-error">{error}</p>}
      <ConfirmDestructiveAction
        open={switchTo !== null}
        title={`Run on ${switchName}?`}
        description={`${name} starts a fresh conversation on ${switchName} the next time it wakes. Its memory stays, so it picks up from what it remembers.`}
        confirmLabel="Switch"
        onCancel={() => setSwitchTo(null)}
        onConfirm={() => {
          const cli = switchTo;
          setSwitchTo(null);
          // A model means nothing to another CLI; Behavior sets the new one before its next start.
          if (cli) void saveConfig({ orchestrator: cli, model: 'default' });
        }}
      />
    </SettingsSection>
  );
}

function ResetSection({ state }: { state: DispatcherState }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = dispatcherName(state);

  const forget = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await window.clubhouse.dispatcher.forgetEverything();
      setDone(true);
    } catch (err) {
      // telemetry-exempt: shown under the button; memory is as it was or partly cleared, and trying again finishes it.
      setError(`Couldn’t forget everything. ${ipcErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Reset">
      <SettingsField
        label="Forget everything"
        help="Clears its notes on your agents and your work, and its timeline. Your agents, connections and Actions stay."
      >
        <Button kind="danger" disabled={busy} onClick={() => { setDone(false); setConfirming(true); }} data-testid="dispatcher-forget">
          Forget everything…
        </Button>
      </SettingsField>
      {done && <p className={`${settingsHelp} mt-1.5`} role="status" data-testid="dispatcher-forget-done">{name} starts over with an empty memory.</p>}
      {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-forget-error">{error}</p>}
      <ConfirmDestructiveAction
        open={confirming}
        title="Forget everything?"
        description={`${name} forgets its notes on your agents and your work, its timeline, and news waiting for the next check-in. This can’t be undone. Your agents, connections, Actions and its chat stay. To start the chat over too, use Clear chat in its menu.`}
        confirmLabel="Forget everything"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void forget()}
      />
    </SettingsSection>
  );
}

export function DispatcherSettingsView() {
  const { state, error: readError, retry } = useDispatcherRead();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const turn = async (on: boolean) => {
    setSwitching(true);
    setSwitchError(null);
    try {
      await window.clubhouse.dispatcher.setEnabled(on);
    } catch (err) {
      // telemetry-exempt: shown under the switch, which keeps the saved value.
      setSwitchError(`Couldn’t turn it ${on ? 'on' : 'off'}. ${ipcErrorMessage(err)}`);
    } finally {
      setSwitching(false);
    }
  };

  if (!state) {
    return (
      <SettingsPage title={TITLE} description={DESCRIPTION}>
        {readError ? (
          <div className="mt-[22px] flex items-center gap-3">
            <p className={settingsError} role="alert" data-testid="dispatcher-load-error">
              Couldn’t load the Dispatcher’s settings. {readError}
            </p>
            <Button onClick={retry}>Retry</Button>
          </div>
        ) : (
          <p className={`${settingsHelp} mt-[22px]`} role="status" data-testid="dispatcher-loading">Loading</p>
        )}
      </SettingsPage>
    );
  }

  const config = state.config;
  const name = dispatcherName(state);

  return (
    <SettingsPage title={TITLE} description={DESCRIPTION} testId="dispatcher-settings">
      {/* No heading: the page title already says Dispatcher. */}
      <section className="mt-[22px]">
        <SettingsField
          label="Turn on Dispatcher"
          help={(
            <span id="dispatcher-enabled-help">{dispatcherSwitchHelp(state)}</span>
          )}
        >
          {/* On the classic layout one that's still on can be turned off, not on (#2565). */}
          <Toggle
            aria-label="Turn on Dispatcher"
            aria-describedby="dispatcher-enabled-help"
            checked={state.enabled}
            disabled={switching || (state.classic && !state.enabled)}
            onChange={(on) => void turn(on)}
            data-testid="dispatcher-enabled"
          />
        </SettingsField>
        {switchError && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-enabled-error">{switchError}</p>}
        {state.running && !state.enabled && (
          <p className={`${settingsHelp} mt-2`} data-testid="dispatcher-still-running">
            It is still running. You can stop it from its view.
          </p>
        )}
        {state.path && <p className={`${settingsHelp} mt-2`} data-testid="dispatcher-folder">Its folder is {state.path}</p>}
      </section>

      {state.enabled && config && (
        <>
          <IdentitySection state={state} config={config} />
          <BehaviorSection state={state} config={config} />
          <ConnectedAgentsSection dispatcherName={name} />
          <LeadSection />
        </>
      )}
      {/* Its memory is kept while it's off, so it can be forgotten then too. */}
      {config && <ResetSection state={state} />}
    </SettingsPage>
  );
}
