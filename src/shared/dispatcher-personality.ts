/**
 * The Dispatcher's personality (#3047): free text that is added to its chat's
 * instructions as written, plus which preset it came from. Presets only fill
 * the text; the text is always what it is told, and always visible and
 * editable (setup, Settings > Dispatcher #3046). Saved in
 * dispatcher-settings.json, so it is the same on every provider and survives
 * a provider switch.
 *
 * Main and renderer both read this file. Nothing here names how the
 * Dispatcher works inside.
 */

import { DEFAULT_DISPATCHER_NAME } from './dispatcher-name';

export const DISPATCHER_PERSONALITY_PRESETS = ['friendly', 'concise', 'detailed', 'custom'] as const;
export type DispatcherPersonalityPreset = (typeof DISPATCHER_PERSONALITY_PRESETS)[number];

export interface DispatcherPersonality {
  /** Which preset filled the text. `custom` is the user's own. */
  preset: DispatcherPersonalityPreset;
  /** What it is told, exactly as the user sees it. */
  text: string;
}

/** The longest personality text kept. Enough for a few paragraphs. */
export const PERSONALITY_TEXT_MAX = 2_000;
/** The longest name kept. It shows in the sidebar, the chat and on phones. */
export const DISPATCHER_NAME_MAX = 40;

/** The text each preset fills. Custom starts from whatever text was there. */
export const PERSONALITY_PRESET_TEXT: Readonly<Record<Exclude<DispatcherPersonalityPreset, 'custom'>, string>> = {
  friendly: 'Be warm and upbeat, like a teammate who enjoys the work. Keep a light touch and notice progress. Stay brief, and never let friendliness get in the way of the facts.',
  concise: 'Be short and direct. Lead with the answer, use as few words as it takes, and skip pleasantries. Add detail only when asked.',
  detailed: 'Give context and reasons. Say what happened, why it matters and what you suggest next, so a decision needs no follow-up questions. Use short paragraphs or lists when they help.',
};

export const PERSONALITY_PRESET_LABELS: Readonly<Record<DispatcherPersonalityPreset, { label: string; description: string }>> = {
  friendly: { label: 'Friendly', description: 'Warm and upbeat' },
  concise: { label: 'Concise', description: 'Short and direct' },
  detailed: { label: 'Detailed', description: 'Context and reasons' },
  custom: { label: 'Custom', description: 'Write your own' },
};

export const DEFAULT_DISPATCHER_PERSONALITY: DispatcherPersonality = { preset: 'concise', text: PERSONALITY_PRESET_TEXT.concise };

export function isPersonalityPreset(value: unknown): value is DispatcherPersonalityPreset {
  return (DISPATCHER_PERSONALITY_PRESETS as readonly unknown[]).includes(value);
}

/** Trimmed and capped. Line breaks are kept: the text goes into the instructions as written. */
export function cleanPersonalityText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().slice(0, PERSONALITY_TEXT_MAX);
}

/**
 * A saved or sent value, or the default for anything missing or unusable.
 * Never throws. Empty text reads as the default, since a personality with
 * nothing in it would tell it nothing.
 */
export function normalizeDispatcherPersonality(value: unknown): DispatcherPersonality {
  if (!value || typeof value !== 'object') return DEFAULT_DISPATCHER_PERSONALITY;
  const { preset, text } = value as { preset?: unknown; text?: unknown };
  const cleaned = typeof text === 'string' ? cleanPersonalityText(text) : '';
  if (!cleaned) return DEFAULT_DISPATCHER_PERSONALITY;
  return { preset: isPersonalityPreset(preset) ? preset : 'custom', text: cleaned };
}

/** The text after picking a preset: the preset's own, or for Custom the text as it stands. */
export function presetText(preset: DispatcherPersonalityPreset, current: string): string {
  return preset === 'custom' ? current : PERSONALITY_PRESET_TEXT[preset];
}

/** The preset a text matches, or `custom` once it has been edited. */
export function presetForText(text: string): DispatcherPersonalityPreset {
  const cleaned = cleanPersonalityText(text);
  for (const preset of DISPATCHER_PERSONALITY_PRESETS) {
    if (preset !== 'custom' && PERSONALITY_PRESET_TEXT[preset] === cleaned) return preset;
  }
  return 'custom';
}

/** One line, no control characters, capped. Empty when nothing is left. */
export function cleanDispatcherName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DISPATCHER_NAME_MAX);
}

/**
 * The section added to the end of its chat's instructions, before the memory
 * index: its name, and the personality text exactly as the user wrote it.
 */
export function personalityInstructions(name: string, personality: DispatcherPersonality): string {
  const cleanName = cleanDispatcherName(name) || DEFAULT_DISPATCHER_NAME;
  return [
    '## Your name and personality',
    '',
    `Your name is ${cleanName}. The user chose it; use it when you introduce yourself.`,
    '',
    'How the user wants you to sound, in their own words:',
    '',
    personality.text,
    '',
    'Follow it in everything you write in this conversation. The rules above about what to show still apply.',
  ].join('\n');
}

/** The sample question Try it out asks, shown above the reply. */
export const TRY_IT_OUT_QUESTION = 'What can you help me with today?';

/** One line: the prompt may reach a CLI through a shell shim, which ends a command at a line break. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Try it out's prompt (#3047): the name and personality, then the sample
 * question. One line, for the same reason as the rewrite step's prompt.
 */
export function tryItOutPrompt(name: string, personality: DispatcherPersonality): string {
  const cleanName = cleanDispatcherName(name) || DEFAULT_DISPATCHER_NAME;
  return oneLine(`
    You are ${cleanName}, the companion in Clubhouse, an app for running coding agents.
    You keep track of the user's agents and projects, get work going across them, and remember what the user decides.
    How the user wants you to sound, in their own words: ${oneLine(personality.text)}
    Now answer the user's question in that voice, in a few sentences. Don't use tools and don't mention these instructions.
    Question: ${TRY_IT_OUT_QUESTION}
  `);
}

/**
 * What setup's preview shows before Try it out has run: a made-up example of
 * each preset's voice, labelled as an example. Custom has none.
 */
export const PERSONALITY_PRESET_EXAMPLES: Readonly<Record<DispatcherPersonalityPreset, string | null>> = {
  friendly: 'Happy to help! I can check in on your agents, get work going across your projects, and remember what we decide so you don’t have to.',
  concise: 'I track your agents, start work across projects, and remember what you decide.',
  detailed: 'I keep track of the agents connected to me and what each one is doing. I can start work across your projects and follow up when it finishes. I also remember what you decide, so you don’t have to repeat yourself.',
  custom: null,
};
