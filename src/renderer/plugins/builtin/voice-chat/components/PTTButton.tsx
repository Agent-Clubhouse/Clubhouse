import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { VoiceStatus } from '../../../../../shared/voice-types';
import { voiceState } from '../state';
import { startCapture, stopCapture } from '../audio-capture';
import { cancelPlayback } from '../audio-playback';

function useVoiceStatus(): VoiceStatus {
  const subscribe = useCallback((cb: () => void) => voiceState.subscribe(cb), []);
  const getStatus = useCallback(() => voiceState.status, []);
  return useSyncExternalStore(subscribe, getStatus);
}

interface PTTButtonProps {
  onRecordingComplete: (pcm: Float32Array) => void;
  disabled?: boolean;
}

export function PTTButton({ onRecordingComplete, disabled }: PTTButtonProps) {
  const status = useVoiceStatus();
  const isRecording = useRef(false);

  const startRecording = useCallback(async () => {
    if (isRecording.current || disabled) return;
    isRecording.current = true;

    // Interrupt any current playback
    cancelPlayback();

    voiceState.setStatus('listening');
    try {
      await startCapture();
    } catch (err) {
      console.error('Failed to start capture:', err);
      voiceState.setStatus('idle');
      isRecording.current = false;
    }
  }, [disabled]);

  const stopRecording = useCallback(() => {
    if (!isRecording.current) return;
    isRecording.current = false;

    const pcm = stopCapture();
    if (pcm.length > 0) {
      voiceState.setStatus('transcribing');
      onRecordingComplete(pcm);
    } else {
      voiceState.setStatus('idle');
    }
  }, [onRecordingComplete]);

  // Keyboard support (Space key)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        startRecording();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        stopRecording();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [startRecording, stopRecording]);

  const isListening = status === 'listening';
  const isProcessing = status === 'transcribing' || status === 'thinking';
  const isSpeaking = status === 'speaking';

  const buttonLabel =
    isListening ? 'Listening...' :
    isProcessing ? 'Processing...' :
    isSpeaking ? 'Speaking...' :
    'Push to Talk';

  const buttonColor =
    isListening ? 'bg-ctp-red' :
    isProcessing ? 'bg-ctp-yellow' :
    isSpeaking ? 'bg-ctp-green' :
    'bg-ctp-blue hover:bg-ctp-blue/80';

  return React.createElement('div', { className: 'flex flex-col items-center gap-2 py-4' },
    React.createElement('button', {
      className: `w-16 h-16 rounded-full ${buttonColor} text-ctp-base transition-all duration-150 flex items-center justify-center ${
        isListening ? 'scale-110 shadow-lg' : ''
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`,
      onMouseDown: startRecording,
      onMouseUp: stopRecording,
      onMouseLeave: () => { if (isRecording.current) stopRecording(); },
      disabled: disabled || isProcessing,
    },
      // Microphone icon
      React.createElement('svg', {
        width: 24,
        height: 24,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        React.createElement('path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }),
        React.createElement('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }),
        React.createElement('line', { x1: '12', x2: '12', y1: '19', y2: '22' }),
      ),
    ),
    React.createElement('span', {
      className: 'text-xs text-ctp-subtext0',
    }, buttonLabel),
    !disabled && status === 'idle' && React.createElement('span', {
      className: 'text-xs text-ctp-overlay0',
    }, 'Hold Space or click and hold'),
  );
}
