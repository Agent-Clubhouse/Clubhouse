import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-clubhouse' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { VoiceManager } from './voice-manager';
import { VoiceInfo } from '../../../shared/types';
import * as fs from 'fs';

const TEST_VOICES: VoiceInfo[] = [
  { voiceId: 'voice-a', voiceName: 'Alice', language: 'en' },
  { voiceId: 'voice-b', voiceName: 'Bob', language: 'en' },
  { voiceId: 'voice-c', voiceName: 'Carol', language: 'en' },
];

describe('VoiceManager', () => {
  let manager: VoiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure load() in constructor finds no existing file
    vi.mocked(fs.existsSync).mockReturnValue(false);
    manager = new VoiceManager();
  });

  it('assigns different voices to different agents', () => {
    const v1 = manager.assignVoice('agent-1', TEST_VOICES);
    const v2 = manager.assignVoice('agent-2', TEST_VOICES);
    expect(v1.voiceId).not.toBe(v2.voiceId);
  });

  it('returns same voice for same agent on subsequent calls', () => {
    const v1 = manager.assignVoice('agent-1', TEST_VOICES);
    const v2 = manager.assignVoice('agent-1', TEST_VOICES);
    expect(v1.voiceId).toBe(v2.voiceId);
  });

  it('wraps around when voices exhausted', () => {
    manager.assignVoice('a1', TEST_VOICES);
    manager.assignVoice('a2', TEST_VOICES);
    manager.assignVoice('a3', TEST_VOICES);
    const v4 = manager.assignVoice('a4', TEST_VOICES);
    expect(v4.voiceId).toBeDefined();
  });

  it('getVoiceForAgent returns assigned voice', () => {
    manager.assignVoice('agent-1', TEST_VOICES);
    const voice = manager.getVoiceForAgent('agent-1');
    expect(voice).toBeDefined();
    expect(voice!.voiceId).toBe('voice-a');
  });

  it('getVoiceForAgent returns undefined for unknown agent', () => {
    const voice = manager.getVoiceForAgent('unknown');
    expect(voice).toBeUndefined();
  });

  it('setVoice manually overrides assignment', () => {
    manager.assignVoice('agent-1', TEST_VOICES);
    manager.setVoice('agent-1', {
      voiceId: 'voice-c',
      voiceName: 'Carol',
      backend: 'piper-local',
    });
    const voice = manager.getVoiceForAgent('agent-1');
    expect(voice).toBeDefined();
    expect(voice!.voiceId).toBe('voice-c');
    expect(voice!.voiceName).toBe('Carol');
  });

  it('throws when no voices available', () => {
    expect(() => manager.assignVoice('agent-1', [])).toThrow('No voices available to assign');
  });

  it('persists assignments via writeFileSync', () => {
    manager.assignVoice('agent-1', TEST_VOICES);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
    const [writtenPath, data] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
    expect(writtenPath).toContain('voice-assignments.json');
    const parsed = JSON.parse(data);
    expect(parsed['agent-1']).toBeDefined();
    expect(parsed['agent-1'].voiceId).toBe('voice-a');
  });
});
