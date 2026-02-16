import React, { useEffect, useCallback, useState, useRef, useSyncExternalStore } from 'react';
import type { PluginAPI, VoiceDownloadProgress } from '../../../../../shared/plugin-types';
import { voiceState } from '../state';
import { TranscriptView } from './TranscriptView';
import { PTTButton } from './PTTButton';
import { queueAudio, cancelPlayback, cleanup as cleanupPlayback } from '../audio-playback';

function useVoiceState() {
  const subscribe = useCallback((cb: () => void) => voiceState.subscribe(cb), []);
  const getAgent = useCallback(() => voiceState.selectedAgent, []);
  const getModelsReady = useCallback(() => voiceState.modelsReady, []);
  const getSessionActive = useCallback(() => voiceState.sessionActive, []);
  const getStatus = useCallback(() => voiceState.status, []);

  return {
    selectedAgent: useSyncExternalStore(subscribe, getAgent),
    modelsReady: useSyncExternalStore(subscribe, getModelsReady),
    sessionActive: useSyncExternalStore(subscribe, getSessionActive),
    status: useSyncExternalStore(subscribe, getStatus),
  };
}

export function VoiceSession({ api }: { api: PluginAPI }) {
  const { selectedAgent, modelsReady, sessionActive, status } = useVoiceState();
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<VoiceDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  // Check models on mount
  useEffect(() => {
    const checkModels = async () => {
      try {
        const models = await api.voice.checkModels();
        const allReady = models.every((m) => m.ready);
        voiceState.setModelsReady(allReady);
      } catch {
        voiceState.setModelsReady(false);
      }
    };
    checkModels();
  }, [api]);

  // Listen for turn chunks (text + audio streaming)
  useEffect(() => {
    const chunkSub = api.voice.onTurnChunk((chunk) => {
      if (chunk.text) {
        voiceState.appendToLastAssistant(chunk.text);
      }
      if (chunk.audio && chunk.audio.byteLength > 0) {
        voiceState.setStatus('speaking');
        queueAudio(chunk.audio);
      }
    });

    const completeSub = api.voice.onTurnComplete(() => {
      voiceState.setStatus('idle');
    });

    return () => {
      chunkSub.dispose();
      completeSub.dispose();
    };
  }, [api]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupPlayback();
      if (voiceState.sessionActive) {
        apiRef.current.voice.endSession();
        voiceState.setSessionActive(false);
      }
    };
  }, []);

  // Start session when agent is selected
  useEffect(() => {
    if (!selectedAgent || !modelsReady) return;

    const startSession = async () => {
      try {
        setError(null);
        const cwd = selectedAgent.worktreePath || api.context.projectPath || '';
        await api.voice.startSession(
          selectedAgent.id,
          cwd,
          selectedAgent.model,
        );
        voiceState.setSessionActive(true);
        voiceState.clearTranscript();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start session');
      }
    };

    startSession();

    return () => {
      api.voice.endSession();
      voiceState.setSessionActive(false);
      cancelPlayback();
    };
  }, [selectedAgent, modelsReady, api]);

  const handleDownloadModels = useCallback(async () => {
    setDownloading(true);
    setError(null);

    const progressSub = api.voice.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      await api.voice.downloadModels();
      voiceState.setModelsReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      progressSub.dispose();
      setDownloading(false);
      setDownloadProgress(null);
    }
  }, [api]);

  const handleRecordingComplete = useCallback(async (pcm: Float32Array) => {
    try {
      voiceState.setStatus('transcribing');

      // Transcribe audio
      const text = await api.voice.transcribe(pcm.buffer as ArrayBuffer);

      if (!text.trim()) {
        voiceState.setStatus('idle');
        return;
      }

      // Add user message to transcript
      voiceState.addTranscriptEntry({
        role: 'user',
        text: text.trim(),
        timestamp: Date.now(),
      });

      // Create placeholder for assistant response
      voiceState.addTranscriptEntry({
        role: 'assistant',
        text: '',
        timestamp: Date.now(),
      });

      // Send to Claude
      voiceState.setStatus('thinking');
      await api.voice.sendTurn(text.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice turn failed');
      voiceState.setStatus('idle');
    }
  }, [api]);

  // No agent selected — show placeholder
  if (!selectedAgent) {
    return React.createElement('div', {
      className: 'flex-1 flex items-center justify-center text-ctp-subtext0 text-sm bg-ctp-base',
    }, 'Select an agent from the sidebar to start a voice conversation.');
  }

  // Models not ready — show download prompt
  if (!modelsReady) {
    return React.createElement('div', {
      className: 'flex-1 flex flex-col items-center justify-center gap-4 bg-ctp-base px-6',
    },
      React.createElement('div', { className: 'text-center' },
        React.createElement('h3', { className: 'text-sm font-medium text-ctp-text mb-1' }, 'Voice Models Required'),
        React.createElement('p', { className: 'text-xs text-ctp-subtext0' },
          'Whisper (speech-to-text) and Piper (text-to-speech) models need to be downloaded (~200MB total).',
        ),
      ),
      downloading
        ? React.createElement('div', { className: 'w-full max-w-xs' },
            React.createElement('div', { className: 'text-xs text-ctp-subtext0 mb-1 text-center' },
              downloadProgress
                ? `Downloading ${downloadProgress.model}... ${downloadProgress.percent}%`
                : 'Starting download...',
            ),
            React.createElement('div', { className: 'w-full h-1.5 bg-ctp-surface0 rounded-full overflow-hidden' },
              React.createElement('div', {
                className: 'h-full bg-ctp-blue transition-all duration-300',
                style: { width: `${downloadProgress?.percent || 0}%` },
              }),
            ),
          )
        : React.createElement('button', {
            className: 'px-4 py-2 text-sm bg-ctp-blue text-ctp-base rounded-lg hover:bg-ctp-blue/80 transition-colors',
            onClick: handleDownloadModels,
          }, 'Download Models'),
      error && React.createElement('p', { className: 'text-xs text-ctp-red' }, error),
    );
  }

  // Voice session UI
  const agentLabel = selectedAgent.emoji
    ? `${selectedAgent.emoji} ${selectedAgent.name}`
    : selectedAgent.name;

  const statusLabel =
    status === 'listening' ? 'Listening...' :
    status === 'transcribing' ? 'Transcribing...' :
    status === 'thinking' ? 'Thinking...' :
    status === 'speaking' ? 'Speaking...' :
    'Ready';

  const statusColor =
    status === 'listening' ? 'text-ctp-red' :
    status === 'transcribing' ? 'text-ctp-yellow' :
    status === 'thinking' ? 'text-ctp-yellow' :
    status === 'speaking' ? 'text-ctp-green' :
    'text-ctp-subtext0';

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-base' },
    // Header
    React.createElement('div', {
      className: 'flex items-center justify-between px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
    },
      React.createElement('div', { className: 'flex items-center gap-2' },
        React.createElement('span', {
          className: 'w-2 h-2 rounded-full',
          style: { backgroundColor: selectedAgent.color },
        }),
        React.createElement('span', { className: 'text-xs font-medium text-ctp-text' },
          `Voice — ${agentLabel}`,
        ),
        React.createElement('span', { className: `text-xs ${statusColor}` }, statusLabel),
      ),
      React.createElement('button', {
        className: 'px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
        onClick: () => {
          cancelPlayback();
          api.voice.endSession();
          voiceState.setSelectedAgent(null);
          voiceState.setSessionActive(false);
          voiceState.clearTranscript();
          voiceState.setStatus('idle');
        },
        title: 'End voice session',
      }, 'End'),
    ),

    // Transcript
    React.createElement(TranscriptView),

    // Error display
    error && React.createElement('div', {
      className: 'px-3 py-2 text-xs text-ctp-red bg-ctp-red/10 border-t border-ctp-surface0',
    }, error),

    // PTT button
    React.createElement('div', {
      className: 'border-t border-ctp-surface0 bg-ctp-mantle',
    },
      React.createElement(PTTButton, {
        onRecordingComplete: handleRecordingComplete,
        disabled: !sessionActive,
      }),
    ),
  );
}
