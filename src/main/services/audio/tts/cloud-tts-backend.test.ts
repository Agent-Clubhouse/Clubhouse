import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { CloudTTSBackend } from './cloud-tts-backend';

describe('CloudTTSBackend', () => {
  let backend: CloudTTSBackend;
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    backend = new CloudTTSBackend();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('has correct id and displayName', () => {
    expect(backend.id).toBe('openai-cloud');
    expect(backend.displayName).toBe('OpenAI TTS (Cloud)');
  });

  it('isAvailable returns true when API key is set', async () => {
    expect(await backend.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no API key', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await backend.isAvailable()).toBe(false);
  });

  it('listVoices returns 6 OpenAI voices', async () => {
    const voices = await backend.listVoices();
    expect(voices.length).toBe(6);
    expect(voices.map((v) => v.voiceId)).toContain('alloy');
    expect(voices.map((v) => v.voiceId)).toContain('nova');
  });

  it('listVoices includes gender metadata', async () => {
    const voices = await backend.listVoices();
    const nova = voices.find((v) => v.voiceId === 'nova');
    expect(nova?.gender).toBe('female');
    const echo = voices.find((v) => v.voiceId === 'echo');
    expect(echo?.gender).toBe('male');
    const alloy = voices.find((v) => v.voiceId === 'alloy');
    expect(alloy?.gender).toBe('neutral');
  });

  it('synthesize sends request and returns buffer', async () => {
    const audioData = new ArrayBuffer(1000);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioData,
    });

    const voice = { voiceId: 'nova', voiceName: 'Nova', backend: 'openai-cloud' as const };
    const result = await backend.synthesize('Hello', voice);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(1000);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('synthesize sends correct JSON body', async () => {
    const audioData = new ArrayBuffer(100);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioData,
    });

    const voice = { voiceId: 'nova', voiceName: 'Nova', backend: 'openai-cloud' as const, speed: 1.5 };
    await backend.synthesize('Hello world', voice);

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.model).toBe('tts-1');
    expect(body.input).toBe('Hello world');
    expect(body.voice).toBe('nova');
    expect(body.speed).toBe(1.5);
    expect(body.response_format).toBe('pcm');
  });

  it('synthesize uses default speed of 1.0', async () => {
    const audioData = new ArrayBuffer(100);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioData,
    });

    const voice = { voiceId: 'alloy', voiceName: 'Alloy', backend: 'openai-cloud' as const };
    await backend.synthesize('Test', voice);

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.speed).toBe(1.0);
  });

  it('synthesize throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });

    const voice = { voiceId: 'nova', voiceName: 'Nova', backend: 'openai-cloud' as const };
    await expect(backend.synthesize('Hello', voice)).rejects.toThrow('Cloud TTS failed: 429');
  });

  it('synthesize throws when no API key', async () => {
    delete process.env.OPENAI_API_KEY;
    const voice = { voiceId: 'nova', voiceName: 'Nova', backend: 'openai-cloud' as const };
    await expect(backend.synthesize('Hello', voice)).rejects.toThrow('OPENAI_API_KEY not configured');
  });

  it('synthesizeStream yields audio buffer', async () => {
    const audioData = new ArrayBuffer(500);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioData,
    });

    const voice = { voiceId: 'alloy', voiceName: 'Alloy', backend: 'openai-cloud' as const };
    const chunks: Buffer[] = [];
    for await (const chunk of backend.synthesizeStream('Test', voice)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(500);
  });

  it('initialize resolves without error', async () => {
    await expect(backend.initialize()).resolves.toBeUndefined();
  });

  it('dispose is callable', () => {
    expect(() => backend.dispose()).not.toThrow();
  });
});
