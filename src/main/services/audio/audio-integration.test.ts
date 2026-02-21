/**
 * Audio Pipeline Integration Test
 *
 * Exercises the AudioService coordinator with mocked STT/TTS engines but real
 * VoiceManager, VoiceRouter, TTS filter, and Output Parser to verify the
 * subsystems work together correctly end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Module mocks (must precede imports of modules that use them) ---

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-clubhouse-integration' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => {
    throw new Error('not found');
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

// --- Imports ---

import { AudioService } from './audio-service';
import { AgentOutputParser } from './output-parser';
import { shouldSpeak } from './tts-filter';
import type { STTEngine } from './stt/stt-engine';
import type { TTSEngine } from './tts/tts-engine';
import type { Agent, VoiceInfo, AudioSettings } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Helpers: mock engines & test data
// ---------------------------------------------------------------------------

const VOICE_POOL: VoiceInfo[] = [
  { voiceId: 'v-alice', voiceName: 'Alice', language: 'en', gender: 'female' },
  { voiceId: 'v-bob', voiceName: 'Bob', language: 'en', gender: 'male' },
  { voiceId: 'v-carol', voiceName: 'Carol', language: 'en', gender: 'neutral' },
];

function createMockSTT(transcription = 'Hello world'): STTEngine {
  return {
    id: 'whisper-local',
    displayName: 'Mock Whisper',
    initialize: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
    transcribe: vi.fn(async () => ({ text: transcription, durationMs: 120 })),
    dispose: vi.fn(),
  };
}

function createMockTTS(): TTSEngine {
  return {
    id: 'piper-local',
    displayName: 'Mock Piper',
    initialize: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
    listVoices: vi.fn(async () => VOICE_POOL),
    synthesize: vi.fn(async (_text: string, _voice) => Buffer.from('fake-audio-data')),
    synthesizeStream: vi.fn(async function* () {
      yield Buffer.from('chunk');
    }),
    dispose: vi.fn(),
  };
}

function makeAgent(overrides: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    projectId: 'proj-1',
    kind: 'durable',
    status: 'running',
    color: '#aaa',
    ...overrides,
  };
}

const AGENTS: Agent[] = [
  makeAgent({ id: 'atlas', name: 'Atlas', color: 'blue', mission: 'Fix the authentication bug in login.ts' }),
  makeAgent({ id: 'nova', name: 'Nova', color: 'green', mission: 'Write tests for the payment module' }),
  makeAgent({ id: 'spark', name: 'Spark', color: 'red', mission: 'Refactor the database layer' }),
];

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('Audio Pipeline Integration', () => {
  let service: AudioService;
  let stt: STTEngine;
  let tts: TTSEngine;

  /** Helper: enable audio and optionally override settings. */
  function enableAudio(overrides: Partial<AudioSettings> = {}): void {
    const base = service.getSettings();
    service.updateSettings({ ...base, enabled: true, ...overrides });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    stt = createMockSTT();
    tts = createMockTTS();

    service = new AudioService();
    service.registerSTTEngine(stt);
    service.registerTTSEngine(tts);
  });

  // -------------------------------------------------------------------------
  // Flow A: STT -> Transcription
  // -------------------------------------------------------------------------

  describe('STT -> Transcription flow', () => {
    it('feeds audio data through STT and returns transcribed text in focused mode', async () => {
      enableAudio({ routingMode: 'focused' });

      service.onRecordingData(Buffer.from('audio-chunk-1'));
      service.onRecordingData(Buffer.from('audio-chunk-2'));

      const result = await service.onRecordingStop(AGENTS, 'atlas');

      expect(stt.transcribe).toHaveBeenCalledTimes(1);
      // The buffer passed to transcribe should be the concatenation of both chunks
      const receivedBuf = (stt.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Buffer;
      expect(receivedBuf.length).toBe(
        Buffer.from('audio-chunk-1').length + Buffer.from('audio-chunk-2').length,
      );

      // In focused mode with a focusedAgentId, routes directly to that agent
      expect(result.agentId).toBe('atlas');
      expect(result.text).toBe('Hello world');
      expect(result.confidence).toBe(1.0);
    });

    it('clears the recording buffer after transcription', async () => {
      enableAudio();
      service.onRecordingData(Buffer.from('data'));
      await service.onRecordingStop(AGENTS, 'atlas');

      // Second stop with no new data should return empty
      const result = await service.onRecordingStop(AGENTS, 'atlas');
      expect(result.text).toBe('');
      expect(stt.transcribe).toHaveBeenCalledTimes(1); // not called again
    });
  });

  // -------------------------------------------------------------------------
  // Flow B: Agent Output -> TTS Synthesis
  // -------------------------------------------------------------------------

  describe('Agent Output -> TTS flow', () => {
    it('synthesizes speech for a response and assigns a voice from the pool', async () => {
      enableAudio();

      const audio = await service.onAgentOutput('atlas', 'The fix is ready.', 'response');

      expect(audio).toBeInstanceOf(Buffer);
      expect(tts.synthesize).toHaveBeenCalledTimes(1);

      // Verify the voice assigned came from the pool
      const [, voice] = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(VOICE_POOL.map((v) => v.voiceId)).toContain(voice.voiceId);
    });

    it('reuses the same voice on subsequent calls for the same agent', async () => {
      enableAudio();

      await service.onAgentOutput('atlas', 'First message.', 'response');
      await service.onAgentOutput('atlas', 'Second message.', 'response');

      expect(tts.listVoices).toHaveBeenCalledTimes(1); // only called once for assignment
      const call1Voice = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const call2Voice = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls[1][1];
      expect(call1Voice.voiceId).toBe(call2Voice.voiceId);
    });

    it('does not call TTS when audio is disabled', async () => {
      // Audio is disabled by default
      const result = await service.onAgentOutput('atlas', 'Hello', 'response');
      expect(result).toBeNull();
      expect(tts.synthesize).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Flow C: Voice Assignment - multiple agents get unique voices
  // -------------------------------------------------------------------------

  describe('Voice Assignment flow', () => {
    it('assigns unique voices to different agents', async () => {
      enableAudio();

      await service.onAgentOutput('atlas', 'Hello from Atlas.', 'response');
      await service.onAgentOutput('nova', 'Hello from Nova.', 'response');
      await service.onAgentOutput('spark', 'Hello from Spark.', 'response');

      const voices = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[1].voiceId as string,
      );

      // All three agents should have been assigned distinct voices
      const uniqueVoices = new Set(voices);
      expect(uniqueVoices.size).toBe(3);

      // All assigned voices should come from the pool
      for (const vid of uniqueVoices) {
        expect(VOICE_POOL.map((v) => v.voiceId)).toContain(vid);
      }
    });

    it('wraps around voice assignment when pool is exhausted', async () => {
      enableAudio();

      // Exhaust all 3 voices in the pool
      await service.onAgentOutput('a1', 'msg', 'response');
      await service.onAgentOutput('a2', 'msg', 'response');
      await service.onAgentOutput('a3', 'msg', 'response');

      // 4th agent should wrap around (LRU reuse)
      await service.onAgentOutput('a4', 'msg', 'response');

      const fourthVoice = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls[3][1];
      expect(VOICE_POOL.map((v) => v.voiceId)).toContain(fourthVoice.voiceId);
    });
  });

  // -------------------------------------------------------------------------
  // Flow D: TTS Filter
  // -------------------------------------------------------------------------

  describe('TTS Filter flow', () => {
    it('filters out tool summaries when speakToolSummaries is false', async () => {
      enableAudio({
        ttsFilter: {
          speakResponses: true,
          speakToolSummaries: false,
          speakErrors: true,
          speakStatus: false,
        },
      });

      const result = await service.onAgentOutput('atlas', 'Editing file.ts', 'tool_summary');
      expect(result).toBeNull();
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('speaks tool summaries when speakToolSummaries is true', async () => {
      enableAudio({
        ttsFilter: {
          speakResponses: true,
          speakToolSummaries: true,
          speakErrors: true,
          speakStatus: true,
        },
      });

      const result = await service.onAgentOutput('atlas', 'Editing file.ts', 'tool_summary');
      expect(result).toBeInstanceOf(Buffer);
      expect(tts.synthesize).toHaveBeenCalledTimes(1);
    });

    it('filters out errors when speakErrors is false', async () => {
      enableAudio({
        ttsFilter: {
          speakResponses: true,
          speakToolSummaries: false,
          speakErrors: false,
          speakStatus: false,
        },
      });

      const result = await service.onAgentOutput('atlas', 'Something went wrong', 'error');
      expect(result).toBeNull();
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('speaks errors when speakErrors is true', async () => {
      enableAudio({
        ttsFilter: {
          speakResponses: true,
          speakToolSummaries: false,
          speakErrors: true,
          speakStatus: false,
        },
      });

      const result = await service.onAgentOutput('atlas', 'Something went wrong', 'error');
      expect(result).toBeInstanceOf(Buffer);
    });

    it('filters out status changes when speakStatus is false', async () => {
      enableAudio({
        ttsFilter: {
          speakResponses: true,
          speakToolSummaries: false,
          speakErrors: true,
          speakStatus: false,
        },
      });

      const result = await service.onAgentOutput('atlas', 'Agent sleeping', 'status_change');
      expect(result).toBeNull();
    });

    it('filters out empty text regardless of filter settings', async () => {
      enableAudio({
        ttsFilter: {
          speakResponses: true,
          speakToolSummaries: true,
          speakErrors: true,
          speakStatus: true,
        },
      });

      const result = await service.onAgentOutput('atlas', '   ', 'response');
      expect(result).toBeNull();
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('shouldSpeak integrates with the real tts-filter module', () => {
      // Verify the standalone shouldSpeak function works as expected
      // (integration sanity: AudioService delegates to this function)
      const filter = {
        speakResponses: true,
        speakToolSummaries: false,
        speakErrors: true,
        speakStatus: false,
      };
      expect(shouldSpeak('Hello', 'response', filter)).toBe(true);
      expect(shouldSpeak('Editing file', 'tool_summary', filter)).toBe(false);
      expect(shouldSpeak('Error!', 'error', filter)).toBe(true);
      expect(shouldSpeak('Agent started', 'status_change', filter)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Flow E: Smart Routing (VoiceRouter integration)
  // -------------------------------------------------------------------------

  describe('Smart Routing flow', () => {
    it('routes to named agent in smart mode', async () => {
      const namedSTT = createMockSTT('Hey Atlas, check the tests');
      service.registerSTTEngine(namedSTT);
      enableAudio({ routingMode: 'smart' });

      service.onRecordingData(Buffer.from('audio'));
      const result = await service.onRecordingStop(AGENTS, null);

      expect(result.agentId).toBe('atlas');
      expect(result.text).toBe('check the tests');
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('routes to second agent when name matches', async () => {
      const namedSTT = createMockSTT('Nova, deploy the service');
      service.registerSTTEngine(namedSTT);
      enableAudio({ routingMode: 'smart' });

      service.onRecordingData(Buffer.from('audio'));
      const result = await service.onRecordingStop(AGENTS, null);

      expect(result.agentId).toBe('nova');
      expect(result.text).toBe('deploy the service');
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('falls back to focused agent in smart mode when no name match', async () => {
      const genericSTT = createMockSTT('do something');
      service.registerSTTEngine(genericSTT);
      enableAudio({ routingMode: 'smart' });

      service.onRecordingData(Buffer.from('audio'));
      const result = await service.onRecordingStop(AGENTS, 'nova');

      expect(result.agentId).toBe('nova');
      expect(result.confidence).toBe(0.5);
    });

    it('falls back to first agent when no name match and no focused agent', async () => {
      const genericSTT = createMockSTT('do something');
      service.registerSTTEngine(genericSTT);
      enableAudio({ routingMode: 'smart' });

      service.onRecordingData(Buffer.from('audio'));
      const result = await service.onRecordingStop(AGENTS, null);

      expect(result.agentId).toBe('atlas'); // first agent
      expect(result.confidence).toBe(0.3);
    });

    it('uses focused mode bypass when routingMode is focused and agent is set', async () => {
      enableAudio({ routingMode: 'focused' });

      service.onRecordingData(Buffer.from('audio'));
      const result = await service.onRecordingStop(AGENTS, 'spark');

      // In focused mode, should route directly without VoiceRouter
      expect(result.agentId).toBe('spark');
      expect(result.text).toBe('Hello world');
      expect(result.confidence).toBe(1.0);
    });

    it('routes by context keywords in smart mode', async () => {
      // Atlas's mission: "Fix the authentication bug in login.ts"
      // Mission words (>3 chars): ["authentication", "login.ts"]
      // Transcription must share >= 2 of those exact words for context match.
      // Use agents with cleaner mission text for reliable context matching.
      const contextAgents: Agent[] = [
        makeAgent({ id: 'zeta', name: 'Zeta', color: 'red', mission: 'refactor authentication service' }),
        makeAgent({ id: 'omega', name: 'Omega', color: 'blue', mission: 'update database migrations' }),
      ];
      // "authentication" and "service" both >3 chars and both in Zeta's mission
      const contextSTT = createMockSTT('there is a problem with authentication service');
      service.registerSTTEngine(contextSTT);
      enableAudio({ routingMode: 'smart' });

      service.onRecordingData(Buffer.from('audio'));
      const result = await service.onRecordingStop(contextAgents, null);

      expect(result.agentId).toBe('zeta');
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.confidence).toBeLessThan(0.95);
    });
  });

  // -------------------------------------------------------------------------
  // Flow F: Output Parser -> TTS Integration
  // -------------------------------------------------------------------------

  describe('Output Parser -> TTS integration', () => {
    it('parses raw agent output and classifies lines for TTS filtering', async () => {
      enableAudio({
        ttsFilter: {
          speakResponses: true,
          speakToolSummaries: false,
          speakErrors: true,
          speakStatus: false,
        },
      });

      const parser = new AgentOutputParser();

      // Simulate raw agent output with mixed content
      const rawOutput = [
        'I found the issue in the code.\n',
        'Editing src/auth.ts\n',
        'Error: missing semicolon\n',
        'The fix has been applied.\n',
      ].join('');

      const segments = parser.feed(rawOutput);

      // Verify parsing classified lines correctly
      expect(segments.length).toBe(4);
      expect(segments[0]).toEqual({ text: 'I found the issue in the code.', kind: 'response' });
      expect(segments[1]).toEqual({ text: 'Editing src/auth.ts', kind: 'tool_summary' });
      expect(segments[2]).toEqual({ text: 'Error: missing semicolon', kind: 'error' });
      expect(segments[3]).toEqual({ text: 'The fix has been applied.', kind: 'response' });

      // Now feed each segment through the AudioService pipeline
      const results: (Buffer | null)[] = [];
      for (const seg of segments) {
        results.push(await service.onAgentOutput('atlas', seg.text, seg.kind));
      }

      // Responses (indices 0, 3) and errors (index 2) should produce audio
      expect(results[0]).toBeInstanceOf(Buffer); // response - spoken
      expect(results[1]).toBeNull(); // tool_summary - filtered out
      expect(results[2]).toBeInstanceOf(Buffer); // error - spoken
      expect(results[3]).toBeInstanceOf(Buffer); // response - spoken

      expect(tts.synthesize).toHaveBeenCalledTimes(3);
    });

    it('strips ANSI escape sequences before classification', () => {
      const parser = new AgentOutputParser();
      const ansiOutput = '\x1b[32mI found the issue.\x1b[0m\n\x1b[31mError: bad thing\x1b[0m\n';
      const segments = parser.feed(ansiOutput);

      expect(segments.length).toBe(2);
      expect(segments[0].text).toBe('I found the issue.');
      expect(segments[0].kind).toBe('response');
      expect(segments[1].text).toBe('Error: bad thing');
      expect(segments[1].kind).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // Flow G: End-to-End Round Trip
  // -------------------------------------------------------------------------

  describe('End-to-End round trip', () => {
    it('STT transcription -> smart route -> agent output -> TTS synthesis', async () => {
      // Step 1: Set up STT to return text that names an agent
      const namedSTT = createMockSTT('Hey Nova, fix the payment tests');
      service.registerSTTEngine(namedSTT);
      enableAudio({ routingMode: 'smart' });

      // Step 2: Feed audio and get routed transcription
      service.onRecordingData(Buffer.from('recorded-audio-data'));
      const routeResult = await service.onRecordingStop(AGENTS, null);

      expect(routeResult.agentId).toBe('nova');
      expect(routeResult.text).toBe('fix the payment tests');

      // Step 3: Simulate the agent responding (the app would send text to agent
      //         and receive a response, which triggers onAgentOutput)
      const audio = await service.onAgentOutput(
        routeResult.agentId,
        'I have fixed the payment test suite.',
        'response',
      );

      expect(audio).toBeInstanceOf(Buffer);
      expect(tts.synthesize).toHaveBeenCalledTimes(1);

      // Verify the voice was assigned to Nova
      const [spokenText, assignedVoice] = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(spokenText).toBe('I have fixed the payment test suite.');
      expect(assignedVoice.voiceId).toBeDefined();
      expect(VOICE_POOL.map((v) => v.voiceId)).toContain(assignedVoice.voiceId);
    });

    it('multiple agents respond with unique voices in a multi-agent conversation', async () => {
      enableAudio({ routingMode: 'smart' });

      // Agent 1 speaks
      const audio1 = await service.onAgentOutput('atlas', 'I found the bug.', 'response');
      expect(audio1).toBeInstanceOf(Buffer);

      // Agent 2 speaks
      const audio2 = await service.onAgentOutput('nova', 'Tests are passing now.', 'response');
      expect(audio2).toBeInstanceOf(Buffer);

      // Agent 3 speaks
      const audio3 = await service.onAgentOutput('spark', 'Database migrated.', 'response');
      expect(audio3).toBeInstanceOf(Buffer);

      // Verify each agent got a unique voice
      const assignedVoices = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[1].voiceId as string,
      );
      expect(new Set(assignedVoices).size).toBe(3);

      // Agent 1 speaks again - same voice
      await service.onAgentOutput('atlas', 'Deploying now.', 'response');
      const atlasVoiceSecond = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls[3][1].voiceId;
      expect(atlasVoiceSecond).toBe(assignedVoices[0]);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('Lifecycle', () => {
    it('initializes all registered engines', async () => {
      await service.initialize();
      expect(stt.initialize).toHaveBeenCalledTimes(1);
      expect(tts.initialize).toHaveBeenCalledTimes(1);
    });

    it('disposes all registered engines', () => {
      service.dispose();
      expect(stt.dispose).toHaveBeenCalledTimes(1);
      expect(tts.dispose).toHaveBeenCalledTimes(1);
    });
  });
});
