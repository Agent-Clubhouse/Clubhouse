import { describe, it, expect } from 'vitest';
import { shouldSpeak } from './tts-filter';
import { TTSFilter } from '../../../shared/types';

const allOn: TTSFilter = { speakResponses: true, speakToolSummaries: true, speakErrors: true, speakStatus: true };
const allOff: TTSFilter = { speakResponses: false, speakToolSummaries: false, speakErrors: false, speakStatus: false };

describe('shouldSpeak', () => {
  it('speaks responses when enabled', () => {
    expect(shouldSpeak('Hello', 'response', allOn)).toBe(true);
  });
  it('suppresses responses when disabled', () => {
    expect(shouldSpeak('Hello', 'response', allOff)).toBe(false);
  });
  it('speaks errors when enabled', () => {
    expect(shouldSpeak('Error!', 'error', allOn)).toBe(true);
  });
  it('suppresses tool summaries when disabled', () => {
    expect(shouldSpeak('Edited file', 'tool_summary', { ...allOn, speakToolSummaries: false })).toBe(false);
  });

  // Extra tests: empty/whitespace text
  it('returns false for empty text regardless of filter', () => {
    expect(shouldSpeak('', 'response', allOn)).toBe(false);
  });
  it('returns false for whitespace-only text regardless of filter', () => {
    expect(shouldSpeak('   ', 'response', allOn)).toBe(false);
    expect(shouldSpeak('\t\n', 'error', allOn)).toBe(false);
  });

  // Extra test: status_change kind
  it('speaks status changes when enabled', () => {
    expect(shouldSpeak('Agent started', 'status_change', allOn)).toBe(true);
  });
  it('suppresses status changes when disabled', () => {
    expect(shouldSpeak('Agent started', 'status_change', allOff)).toBe(false);
  });

  // Extra test: unknown kind returns false
  it('returns false for unknown kind', () => {
    expect(shouldSpeak('Hello', 'unknown_kind' as any, allOn)).toBe(false);
  });
});
