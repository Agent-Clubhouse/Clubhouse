import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISPATCHER_PERSONALITY,
  DISPATCHER_NAME_MAX,
  PERSONALITY_PRESET_TEXT,
  PERSONALITY_TEXT_MAX,
  cleanDispatcherName,
  normalizeDispatcherPersonality,
  personalityInstructions,
  presetForText,
  presetText,
  tryItOutPrompt,
} from './dispatcher-personality';
import { cleanSetupInput, cleanTryItOutRequest, normalizeSetupState } from './dispatcher-setup';
import { DEFAULT_DISPATCHER_NAME } from './dispatcher-name';

describe('dispatcher personality', () => {
  it('defaults to Concise', () => {
    expect(DEFAULT_DISPATCHER_PERSONALITY).toEqual({ preset: 'concise', text: PERSONALITY_PRESET_TEXT.concise });
    expect(normalizeDispatcherPersonality(undefined)).toBe(DEFAULT_DISPATCHER_PERSONALITY);
    expect(normalizeDispatcherPersonality({ preset: 'friendly', text: '' })).toBe(DEFAULT_DISPATCHER_PERSONALITY);
  });

  it('keeps text as written, trimmed and capped, and reads an unknown preset as Custom', () => {
    expect(normalizeDispatcherPersonality({ preset: 'loud', text: '  Line one\r\nLine two  ' })).toEqual({ preset: 'custom', text: 'Line one\nLine two' });
    expect(normalizeDispatcherPersonality({ preset: 'custom', text: 'x'.repeat(PERSONALITY_TEXT_MAX + 50) }).text).toHaveLength(PERSONALITY_TEXT_MAX);
  });

  it('fills a preset\'s text, keeps the text for Custom, and knows an edited preset is Custom', () => {
    expect(presetText('detailed', 'mine')).toBe(PERSONALITY_PRESET_TEXT.detailed);
    expect(presetText('custom', 'mine')).toBe('mine');
    expect(presetForText(PERSONALITY_PRESET_TEXT.friendly)).toBe('friendly');
    expect(presetForText(`${PERSONALITY_PRESET_TEXT.friendly} And jokes.`)).toBe('custom');
  });

  it('cleans a name to one capped line, falling back to the default name in instructions', () => {
    expect(cleanDispatcherName('  Ro\nsie  ')).toBe('Ro sie');
    expect(cleanDispatcherName('x'.repeat(80))).toHaveLength(DISPATCHER_NAME_MAX);
    expect(personalityInstructions('  ', DEFAULT_DISPATCHER_PERSONALITY)).toContain(`Your name is ${DEFAULT_DISPATCHER_NAME}.`);
  });

  it('puts the text into the instructions exactly as written, and the prompt on one line', () => {
    const personality = { preset: 'custom' as const, text: 'Short.\nNo emoji.' };
    expect(personalityInstructions('Rosie', personality)).toContain('Short.\nNo emoji.');
    const prompt = tryItOutPrompt('Rosie', personality);
    expect(prompt).not.toContain('\n');
    expect(prompt).toContain('Short. No emoji.');
  });

  it('uses plain copy: no em dashes in what the user or the model reads', () => {
    for (const text of Object.values(PERSONALITY_PRESET_TEXT)) expect(text).not.toContain('—');
    expect(personalityInstructions('Rosie', DEFAULT_DISPATCHER_PERSONALITY)).not.toContain('—');
  });
});

describe('dispatcher setup input', () => {
  const good = { name: ' Rosie ', color: 'rose', provider: 'codex-cli', behavior: 'thorough', personality: { preset: 'friendly', text: 'Hi' } };

  it('cleans what setup sends', () => {
    expect(cleanSetupInput(good)).toEqual({ name: 'Rosie', color: 'rose', provider: 'codex-cli', behavior: 'thorough', personality: { preset: 'friendly', text: 'Hi' } });
    expect(cleanSetupInput({ ...good, image: null }).image).toBeNull();
    expect(cleanSetupInput({ ...good, image: 'data:image/png;base64,AA' }).image).toBe('data:image/png;base64,AA');
  });

  it('refuses what can\'t be saved, with a plain reason', () => {
    expect(() => cleanSetupInput({ ...good, name: '  ' })).toThrow('Give it a name.');
    expect(() => cleanSetupInput({ ...good, behavior: 'max' })).toThrow('Light, Standard or Thorough');
    expect(() => cleanSetupInput({ ...good, provider: '' })).toThrow('runs on');
    expect(() => cleanSetupInput({ ...good, image: 'file:///etc/passwd' })).toThrow('image');
    expect(() => cleanTryItOutRequest({ provider: 'x', behavior: 'nope' })).toThrow();
  });

  it('reads a saved setup state, or nothing', () => {
    expect(normalizeSetupState({ status: 'later', upgrade: true })).toEqual({ status: 'later', upgrade: true });
    expect(normalizeSetupState({ status: 'sometime' })).toBeNull();
    expect(normalizeSetupState(undefined)).toBeNull();
  });
});
