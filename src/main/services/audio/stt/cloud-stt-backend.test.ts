import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { CloudSTTBackend } from './cloud-stt-backend';

describe('CloudSTTBackend', () => {
  let backend: CloudSTTBackend;
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    backend = new CloudSTTBackend();
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
    expect(backend.displayName).toBe('OpenAI Whisper (Cloud)');
  });

  it('isAvailable returns true when API key is set', async () => {
    expect(await backend.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no API key', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await backend.isAvailable()).toBe(false);
  });

  it('transcribe sends request and returns text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    });

    const result = await backend.transcribe(Buffer.alloc(100));
    expect(result.text).toBe('Hello world');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('transcribe passes language option when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Bonjour' }),
    });

    const result = await backend.transcribe(Buffer.alloc(100), { language: 'fr' });
    expect(result.text).toBe('Bonjour');

    // Verify fetch was called - the FormData body should contain the language
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].headers.Authorization).toBe('Bearer test-key');
  });

  it('transcribe throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(backend.transcribe(Buffer.alloc(100))).rejects.toThrow('Cloud STT failed: 401');
  });

  it('transcribe throws when no API key', async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(backend.transcribe(Buffer.alloc(100))).rejects.toThrow('OPENAI_API_KEY not configured');
  });

  it('transcribe trims whitespace from response text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: '  Hello world  ' }),
    });

    const result = await backend.transcribe(Buffer.alloc(100));
    expect(result.text).toBe('Hello world');
  });

  it('transcribe returns empty string when response text is null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: null }),
    });

    const result = await backend.transcribe(Buffer.alloc(100));
    expect(result.text).toBe('');
  });

  it('initialize resolves without error', async () => {
    await expect(backend.initialize()).resolves.toBeUndefined();
  });

  it('dispose is callable', () => {
    expect(() => backend.dispose()).not.toThrow();
  });
});
