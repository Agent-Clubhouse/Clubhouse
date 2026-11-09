/**
 * The Dispatcher's first-run setup (#3047), shown in its own view the first
 * time it is opened: three steps beside a live preview of how it will look
 * and sound.
 *
 * 1. Name and look: a name, a color and an optional image.
 * 2. Behavior and Runs on: Light, Standard or Thorough, and the provider. If
 *    Auto can't give the level its models there, "Set up Auto" is offered, as
 *    the composer chip and Settings do (#3045).
 * 3. Personality: presets fill the text, which is always shown and editable.
 *    Try it out asks the chosen model one sample question with that text and
 *    shows the real reply. It contacts no agent (dispatcher-setup.ts in main).
 *
 * "Set up later" keeps the defaults. Upgrading users see this once, prefilled
 * with what they have, with one line saying it now remembers things. What the
 * Dispatcher is and how agents connect is the app welcome's to teach (#2814),
 * so none of that is here.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { AGENT_COLORS } from '../../../shared/name-generator';
import type { Agent } from '../../../shared/types';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import {
  DISPATCHER_BEHAVIORS,
  DISPATCHER_BEHAVIOR_LABELS,
  behaviorAutoNote,
  canSetUpAuto,
  type DispatcherBehaviorAuto,
} from '../../../shared/dispatcher-behavior';
import {
  DISPATCHER_NAME_MAX,
  DISPATCHER_PERSONALITY_PRESETS,
  PERSONALITY_PRESET_EXAMPLES,
  PERSONALITY_PRESET_LABELS,
  PERSONALITY_TEXT_MAX,
  TRY_IT_OUT_QUESTION,
  presetForText,
  presetText,
} from '../../../shared/dispatcher-personality';
import { Button } from '../../components/Button';
import { ImageCropDialog } from '../../components/ImageCropDialog';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { AgentAvatar } from '../agents/AgentAvatar';
import { Row, inputClass, selectClass } from '../../chrome/pages/newAgentUi';
import { useProviderName } from './BehaviorChip';
import { openAutoSettings } from './dispatcherNav';
import { useDispatcherStore } from './dispatcherStore';
import {
  SETUP_STEPS,
  SETUP_STEP_TITLES,
  draftFromState,
  setupInput,
  tryKey,
  useSetupDraftStore,
  type SetupDraft,
} from './setupDraft';

export interface DispatcherSetupProps {
  state: DispatcherState;
  /** Opened again from the chat or its menu: the way out is Cancel, not Set up later. */
  reopened?: boolean;
  /** Called once setup is saved, put off or cancelled. */
  onClose: () => void;
}

export function DispatcherSetup({ state, reopened = false, onClose }: DispatcherSetupProps) {
  const { draft, step, start, update, setStep, reset } = useSetupDraftStore();
  const enabledIds = useOrchestratorStore((s) => s.enabled);
  const loadOrchestrators = useOrchestratorStore((s) => s.loadSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { void loadOrchestrators(); }, [loadOrchestrators]);
  // Prefilled once per opening; coming back from Settings > Smart selection keeps what was filled in.
  useEffect(() => {
    if (!useSetupDraftStore.getState().draft) start(draftFromState(state, enabledIds[0] ?? ''));
  }, [state, enabledIds, start]);
  useEffect(() => { headingRef.current?.focus(); }, [step]);

  if (!draft) return null;

  const index = SETUP_STEPS.indexOf(step);
  const last = index === SETUP_STEPS.length - 1;
  const savedName = state.config?.name || draft.name;
  const nameMissing = !draft.name.trim();

  const finish = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await window.clubhouse.dispatcher.completeSetup(setupInput(draft));
      useDispatcherStore.getState().setState(next);
      reset();
      onClose();
    } catch (err) {
      // telemetry-exempt: shown above the buttons, and nothing was changed.
      setError(`Couldn’t save the setup. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const later = async () => {
    if (reopened) {
      reset();
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await window.clubhouse.dispatcher.setSetupStatus('later');
      useDispatcherStore.getState().setState(next);
      reset();
      onClose();
    } catch (err) {
      // telemetry-exempt: shown above the buttons; setup stays open.
      setError(`Couldn’t skip setup. ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-ctp-base" data-testid="dispatcher-setup" data-step={step}>
      <div className="max-w-[960px] mx-auto px-6 py-8 flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <p className="text-xs text-ctp-overlay1" data-testid="dispatcher-setup-progress">Step {index + 1} of {SETUP_STEPS.length}</p>
          <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ctp-text outline-none">
            {SETUP_STEP_TITLES[step]}
          </h1>
          {state.setup?.upgrade && step === 'look' && (
            <p className="text-[13px] text-ctp-subtext0" data-testid="dispatcher-setup-upgrade-note">
              {savedName} now remembers what you decide and who is doing what.
            </p>
          )}
        </header>

        <div className="flex flex-col lg:flex-row gap-8 items-start">
          <div className="flex-1 min-w-0 w-full">
            {step === 'look' && <LookStep draft={draft} update={update} />}
            {step === 'behavior' && <BehaviorStep draft={draft} update={update} currentProvider={state.behavior.provider} modelsByHand={!!state.models?.byHand} />}
            {step === 'personality' && <PersonalityStep draft={draft} update={update} />}
          </div>
          <SetupPreview draft={draft} chatAgentId={state.chatAgentId} emoji={state.config?.emoji ?? undefined} />
        </div>

        {error && <p className="text-[13px] text-ctp-error" role="alert" data-testid="dispatcher-setup-error">{error}</p>}
        <footer className="flex items-center gap-2 border-t border-surface-0 pt-4">
          <Button kind="quiet" onClick={() => void later()} disabled={saving} data-testid="dispatcher-setup-later">
            {reopened ? 'Cancel' : 'Set up later'}
          </Button>
          <span className="flex-1" />
          {index > 0 && (
            <Button onClick={() => setStep(SETUP_STEPS[index - 1])} disabled={saving} data-testid="dispatcher-setup-back">Back</Button>
          )}
          {last ? (
            <Button kind="primary" onClick={() => void finish()} disabled={saving || nameMissing} data-testid="dispatcher-setup-finish">
              {saving ? 'Saving' : 'Finish'}
            </Button>
          ) : (
            <Button kind="primary" onClick={() => setStep(SETUP_STEPS[index + 1])} disabled={nameMissing} data-testid="dispatcher-setup-next">Next</Button>
          )}
        </footer>
      </div>
    </div>
  );
}

interface StepProps {
  draft: SetupDraft;
  update: (changes: Partial<SetupDraft>) => void;
}

function LookStep({ draft, update }: StepProps) {
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const nameMissing = !draft.name.trim();

  const pickImage = () => {
    setPickError(null);
    void window.clubhouse.agent.pickIcon()
      .then((url: string | null) => { if (url) setCropUrl(url); })
      // telemetry-exempt: shown under the image row.
      .catch((err: unknown) => setPickError(`Couldn’t open the image. ${ipcErrorMessage(err)}`));
  };

  return (
    <div className="flex flex-col" data-testid="dispatcher-setup-look">
      <Row
        label="Name"
        htmlFor="dispatcher-setup-name"
        help={nameMissing
          ? <span className="text-ctp-error" id="dispatcher-setup-name-error">Give it a name.</span>
          : 'Shown in the sidebar, the chat, on your phone and to your agents.'}
      >
        <input
          id="dispatcher-setup-name"
          data-testid="dispatcher-setup-name"
          value={draft.name}
          maxLength={DISPATCHER_NAME_MAX}
          onChange={(e) => update({ name: e.target.value })}
          aria-invalid={nameMissing || undefined}
          aria-describedby={nameMissing ? 'dispatcher-setup-name-error' : undefined}
          className={`${inputClass} w-[240px]`}
          spellCheck={false}
          autoComplete="off"
        />
      </Row>
      <Row label="Color">
        <div role="radiogroup" aria-label="Color" className="inline-flex flex-wrap items-center gap-1.5">
          {AGENT_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={draft.color === c.id}
              aria-label={c.label}
              title={c.label}
              onClick={() => update({ color: c.id })}
              className={`w-5 h-5 rounded-full flex items-center justify-center cursor-pointer focus-ring ${draft.color === c.id ? 'border-[1.5px] border-ctp-text' : ''}`}
              data-testid={`dispatcher-setup-color-${c.id}`}
            >
              <span className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: c.hex }} />
            </button>
          ))}
        </div>
      </Row>
      <Row label="Image" help={pickError ? <span className="text-ctp-error" role="alert">{pickError}</span> : 'Optional. Shown in place of the initials.'}>
        <Button onClick={pickImage} data-testid="dispatcher-setup-image">{draft.image ? 'Change…' : 'Choose…'}</Button>
        {typeof draft.image === 'string' && (
          <Button kind="quiet" onClick={() => update({ image: null })} data-testid="dispatcher-setup-image-remove">Remove</Button>
        )}
        {draft.image === undefined && <KeepImageRemove update={update} />}
      </Row>
      {cropUrl && (
        <ImageCropDialog
          imageDataUrl={cropUrl}
          maskShape="circle"
          onConfirm={(url) => { setCropUrl(null); update({ image: url }); }}
          onCancel={() => setCropUrl(null)}
        />
      )}
    </div>
  );
}

/** Remove for an image it already has, before any change in setup. */
function KeepImageRemove({ update }: Pick<StepProps, 'update'>) {
  const chatAgentId = useDispatcherStore((s) => s.state?.chatAgentId ?? null);
  const hasImage = useAgentStore((s) => !!(chatAgentId && s.agentIcons[chatAgentId]));
  if (!hasImage) return null;
  return <Button kind="quiet" onClick={() => update({ image: null })} data-testid="dispatcher-setup-image-remove">Remove</Button>;
}

function BehaviorStep({ draft, update, currentProvider, modelsByHand }: StepProps & { currentProvider: string | null; modelsByHand: boolean }) {
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledIds = useOrchestratorStore((s) => s.enabled);
  const providerName = useProviderName(draft.provider);
  const [auto, setAuto] = useState<DispatcherBehaviorAuto>({ ready: true });

  useEffect(() => {
    if (!draft.provider) return;
    let live = true;
    window.clubhouse.dispatcher.checkBehavior(draft.provider, draft.behavior)
      .then((result) => { if (live) setAuto(result); })
      // telemetry-exempt: with no answer the step says nothing about Auto.
      .catch(() => { if (live) setAuto({ ready: true }); });
    return () => { live = false; };
  }, [draft.provider, draft.behavior]);

  // What it runs on now stays listed even if it was since turned off for new agents.
  const choices = allOrchestrators.filter((o) => enabledIds.includes(o.id) || o.id === currentProvider || o.id === draft.provider);
  const note = behaviorAutoNote(auto, providerName);
  const switching = !!currentProvider && draft.provider !== currentProvider;

  return (
    <div className="flex flex-col gap-4" data-testid="dispatcher-setup-behavior">
      <div role="radiogroup" aria-label="Behavior" className="flex flex-col gap-1">
        {DISPATCHER_BEHAVIORS.map((level) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={draft.behavior === level}
            onClick={() => update({ behavior: level })}
            className={`flex items-start gap-2.5 px-3 py-2 rounded-md text-left focus-ring ${draft.behavior === level ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
            data-testid={`dispatcher-setup-behavior-${level}`}
          >
            <span className={`mt-0.5 w-3 h-3 rounded-full flex-shrink-0 ${draft.behavior === level ? 'border-[3.5px] border-ctp-accent' : 'border-[1.5px] border-surface-2'}`} />
            <span className="flex flex-col">
              <span className="text-[13px] text-ctp-text">{DISPATCHER_BEHAVIOR_LABELS[level].label}</span>
              <span className="text-xs text-ctp-overlay1">{DISPATCHER_BEHAVIOR_LABELS[level].description}</span>
            </span>
          </button>
        ))}
      </div>
      <Row
        label="Runs on"
        htmlFor="dispatcher-setup-provider"
        help={switching ? 'It starts a fresh conversation on the new provider. What it remembers stays.' : 'The provider for its chat and its work. Change it anytime in Settings.'}
      >
        <select
          id="dispatcher-setup-provider"
          className={selectClass}
          value={draft.provider}
          onChange={(e) => update({ provider: e.target.value })}
          data-testid="dispatcher-setup-provider"
        >
          {!draft.provider && <option value="">Choose a provider</option>}
          {choices.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
        </select>
      </Row>
      {/* Setup picks one provider and a Behavior, so finishing it turns Choose models yourself off (#3191). */}
      {modelsByHand && (
        <p className="text-xs text-ctp-subtext0" data-testid="dispatcher-setup-models-by-hand">
          You chose its models yourself. Finishing setup lets Behavior choose them again. Your picks stay in Settings for next time.
        </p>
      )}
      {note && (
        <div className="flex flex-col gap-1.5" data-testid="dispatcher-setup-auto">
          <p className="text-xs text-ctp-subtext0">{note}</p>
          {canSetUpAuto(auto) && (
            <span><Button onClick={openAutoSettings} data-testid="dispatcher-setup-auto-button">Set up Auto</Button></span>
          )}
        </div>
      )}
    </div>
  );
}

function PersonalityStep({ draft, update }: StepProps) {
  const groupId = useId();
  const { tried, setTried } = useSetupDraftStore();
  const [trying, setTrying] = useState(false);
  const providerName = useProviderName(draft.provider);

  const pick = (preset: SetupDraft['personality']['preset']) => {
    update({ personality: { preset, text: presetText(preset, draft.personality.text) } });
  };
  const edit = (text: string) => {
    update({ personality: { preset: presetForText(text), text } });
  };

  const tryIt = async () => {
    const key = tryKey(draft);
    setTrying(true);
    try {
      const result = await window.clubhouse.dispatcher.tryPersonality({
        name: draft.name,
        provider: draft.provider,
        behavior: draft.behavior,
        personality: draft.personality,
      });
      setTried({ result, key });
    } catch (err) {
      // telemetry-exempt: shown in the preview as the reason there is no reply.
      setTried({ result: { ok: false, error: `Couldn’t get a reply. ${ipcErrorMessage(err)}` }, key });
    } finally {
      setTrying(false);
    }
  };

  const empty = !draft.personality.text.trim();

  return (
    <div className="flex flex-col gap-4" data-testid="dispatcher-setup-personality">
      <div role="radiogroup" aria-label="Personality" className="grid grid-cols-2 gap-1.5">
        {DISPATCHER_PERSONALITY_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={draft.personality.preset === preset}
            onClick={() => pick(preset)}
            className={`flex flex-col px-3 py-2 rounded-md border text-left focus-ring ${draft.personality.preset === preset ? 'border-ctp-accent bg-surface-0' : 'border-surface-1 hover:bg-surface-0/60'}`}
            data-testid={`dispatcher-setup-preset-${preset}`}
          >
            <span className="text-[13px] text-ctp-text">{PERSONALITY_PRESET_LABELS[preset].label}</span>
            <span className="text-xs text-ctp-overlay1">{PERSONALITY_PRESET_LABELS[preset].description}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${groupId}-text`} className="text-[13px] text-ctp-subtext1">What it’s told</label>
        <textarea
          id={`${groupId}-text`}
          value={draft.personality.text}
          maxLength={PERSONALITY_TEXT_MAX}
          onChange={(e) => edit(e.target.value)}
          rows={5}
          className="px-2 py-1.5 rounded-md border border-surface-1 bg-ctp-crust text-[13px] text-ctp-text leading-relaxed focus-ring resize-y"
          aria-describedby={`${groupId}-help`}
          data-testid="dispatcher-setup-personality-text"
        />
        <p id={`${groupId}-help`} className="text-xs text-ctp-overlay1">
          {empty ? 'Empty text uses Concise.' : 'Added to its instructions exactly as written. Edit it here or later in Settings.'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => void tryIt()} disabled={trying || !draft.provider || empty} data-testid="dispatcher-setup-try">
          {trying ? 'Trying' : 'Try it out'}
        </Button>
        <span className="text-xs text-ctp-overlay1" role="status" data-testid="dispatcher-setup-try-status">
          {trying ? `Asking ${providerName}` : tried ? '' : `Asks ${providerName} one sample question. No agent is involved.`}
        </span>
      </div>
    </div>
  );
}

/** How it will look and sound, updated as the user goes. */
function SetupPreview({ draft, chatAgentId, emoji }: { draft: SetupDraft; chatAgentId: string | null; emoji?: string }) {
  const currentIcon = useAgentStore((s) => (chatAgentId ? s.agentIcons[chatAgentId] : undefined));
  const tried = useSetupDraftStore((s) => s.tried);
  const providerName = useProviderName(draft.provider);
  const iconUrl = draft.image === undefined ? currentIcon : draft.image ?? undefined;
  const name = draft.name.trim() || 'Your Dispatcher';
  // An image replaces an emoji; without either, its color and initials show.
  const agent = {
    id: 'dispatcher-setup-preview', name, color: draft.color, kind: 'durable', status: 'sleeping',
    ...(iconUrl ? { icon: 'preview' } : draft.image === undefined && emoji ? { emoji } : {}),
  } as unknown as Agent;

  const current = tried && tried.key === tryKey(draft) ? tried : null;
  const example = PERSONALITY_PRESET_EXAMPLES[draft.personality.preset];

  let reply: React.ReactNode;
  if (current?.result.ok === true) {
    reply = <p className="text-[13px] text-ctp-text whitespace-pre-wrap" data-testid="dispatcher-setup-reply">{current.result.text}</p>;
  } else if (current && current.result.ok === false) {
    reply = <p className="text-[13px] text-ctp-error" role="alert" data-testid="dispatcher-setup-reply-error">{current.result.error}</p>;
  } else if (example) {
    reply = (
      <>
        <p className="text-[13px] text-ctp-text" data-testid="dispatcher-setup-example">{example}</p>
        <p className="text-[11px] text-ctp-overlay1">An example. Try it out for a real reply.</p>
      </>
    );
  } else {
    reply = <p className="text-[13px] text-ctp-overlay1" data-testid="dispatcher-setup-example">Try it out to hear how it sounds.</p>;
  }

  return (
    <aside aria-label="Preview" className="w-full lg:w-[340px] flex-shrink-0 rounded-lg border border-surface-0 bg-ctp-mantle p-4 flex flex-col gap-4" data-testid="dispatcher-setup-preview">
      <div className="flex items-center gap-3">
        <AgentAvatar agent={agent} size="lg" iconUrl={iconUrl} />
        <div className="flex flex-col min-w-0">
          <span className="text-[15px] font-semibold text-ctp-text truncate" data-testid="dispatcher-setup-preview-name">{name}</span>
          <span className="text-xs text-ctp-overlay1">
            {DISPATCHER_BEHAVIOR_LABELS[draft.behavior].label} on {providerName}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="self-end max-w-[85%] rounded-lg bg-surface-0 px-3 py-2 text-[13px] text-ctp-text">{TRY_IT_OUT_QUESTION}</div>
        <div className="flex items-start gap-2">
          <AgentAvatar agent={agent} size="2xs" iconUrl={iconUrl} />
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-xs font-medium text-ctp-subtext1">{name}</span>
            {reply}
          </div>
        </div>
      </div>
    </aside>
  );
}
