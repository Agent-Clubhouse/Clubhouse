import { create } from 'zustand';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { DEFAULT_DISPATCHER_NAME, type DispatcherState } from '../../../shared/dispatcher-types';
import { DEFAULT_DISPATCHER_BEHAVIOR, type DispatcherBehavior } from '../../../shared/dispatcher-behavior';
import { DEFAULT_DISPATCHER_PERSONALITY, type DispatcherPersonality } from '../../../shared/dispatcher-personality';
import type { DispatcherSetupInput, TryItOutResult } from '../../../shared/dispatcher-setup';

/**
 * The Dispatcher's setup (#3047) as the user fills it in. Kept in a store, not
 * the component, so "Set up Auto" can open Settings > Smart selection and coming back
 * carries on where the user was. Nothing is saved until Finish.
 */

export const SETUP_STEPS = ['look', 'behavior', 'personality'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const SETUP_STEP_TITLES: Readonly<Record<SetupStep, string>> = {
  look: 'Name and look',
  behavior: 'Behavior',
  personality: 'Personality',
};

export interface SetupDraft {
  name: string;
  color: string;
  /** A new image (data URL), null to remove the one it has, or undefined to keep it. */
  image: string | null | undefined;
  provider: string;
  behavior: DispatcherBehavior;
  personality: DispatcherPersonality;
}

/** Setup prefilled with what the Dispatcher has now: its name, look, provider, Behavior and personality. */
export function draftFromState(state: DispatcherState | null, fallbackProvider: string): SetupDraft {
  return {
    name: state?.config?.name || DEFAULT_DISPATCHER_NAME,
    color: state?.config?.color || AGENT_COLORS[0].id,
    image: undefined,
    provider: state?.behavior?.provider || state?.config?.orchestrator || fallbackProvider,
    behavior: state?.behavior?.level ?? DEFAULT_DISPATCHER_BEHAVIOR,
    personality: state?.personality ?? DEFAULT_DISPATCHER_PERSONALITY,
  };
}

/** What Finish sends. An image left as it was isn't sent. */
export function setupInput(draft: SetupDraft): DispatcherSetupInput {
  return {
    name: draft.name.trim(),
    color: draft.color,
    ...(draft.image !== undefined && { image: draft.image }),
    provider: draft.provider,
    behavior: draft.behavior,
    personality: draft.personality,
  };
}

/** Try it out's last reply, with what it was asked under, so the preview can say when it no longer matches. */
export interface TriedReply {
  result: TryItOutResult;
  /** The provider, Behavior and personality text it ran with. */
  key: string;
}

export function tryKey(draft: Pick<SetupDraft, 'provider' | 'behavior' | 'personality' | 'name'>): string {
  return JSON.stringify([draft.provider, draft.behavior, draft.personality.text, draft.name.trim()]);
}

interface SetupDraftStore {
  /** Null until setup first opens this session. */
  draft: SetupDraft | null;
  step: SetupStep;
  tried: TriedReply | null;
  start: (draft: SetupDraft) => void;
  update: (changes: Partial<SetupDraft>) => void;
  setStep: (step: SetupStep) => void;
  setTried: (tried: TriedReply | null) => void;
  reset: () => void;
}

export const useSetupDraftStore = create<SetupDraftStore>((set) => ({
  draft: null,
  step: 'look',
  tried: null,
  start: (draft) => set({ draft, step: 'look', tried: null }),
  update: (changes) => set((s) => (s.draft ? { draft: { ...s.draft, ...changes } } : s)),
  setStep: (step) => set({ step }),
  setTried: (tried) => set({ tried }),
  reset: () => set({ draft: null, step: 'look', tried: null }),
}));
