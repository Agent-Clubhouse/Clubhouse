import React, { useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import type { VoiceTranscriptEntry } from '../../../../../shared/voice-types';
import { voiceState } from '../state';

function useTranscript(): VoiceTranscriptEntry[] {
  const subscribe = useCallback((cb: () => void) => voiceState.subscribe(cb), []);
  const getTranscript = useCallback(() => voiceState.transcript, []);
  return useSyncExternalStore(subscribe, getTranscript);
}

export function TranscriptView() {
  const transcript = useTranscript();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  if (transcript.length === 0) {
    return React.createElement('div', {
      className: 'flex-1 flex items-center justify-center text-ctp-subtext0 text-sm',
    }, 'Hold the button and speak to start a conversation.');
  }

  return React.createElement('div', { className: 'flex-1 overflow-y-auto px-4 py-3 space-y-3' },
    transcript.map((entry, i) =>
      React.createElement('div', {
        key: i,
        className: `flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`,
      },
        React.createElement('div', {
          className: `max-w-[80%] px-3 py-2 rounded-lg text-sm ${
            entry.role === 'user'
              ? 'bg-ctp-blue text-ctp-base rounded-br-sm'
              : 'bg-ctp-surface0 text-ctp-text rounded-bl-sm'
          }`,
        },
          React.createElement('p', { className: 'whitespace-pre-wrap' }, entry.text),
          React.createElement('span', {
            className: `block mt-1 text-xs ${
              entry.role === 'user' ? 'text-ctp-base/60' : 'text-ctp-subtext0'
            }`,
          }, new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        ),
      ),
    ),
    React.createElement('div', { ref: bottomRef }),
  );
}
