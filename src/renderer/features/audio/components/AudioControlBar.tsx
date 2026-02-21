import { useCallback, useEffect } from 'react';
import { useAudioStore } from '../../../stores/audioStore';
import { useAgentStore } from '../../../stores/agentStore';

export function AudioControlBar() {
  const { settings, recording, transcribing, speaking, speakingAgentId, micPermission, setRecording, setTranscribing, loadSettings, checkMicPermission } = useAudioStore();
  const agents = useAgentStore((s) => Object.values(s.agents));
  const speakingAgent = agents.find((a) => a.id === speakingAgentId);

  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { checkMicPermission(); }, [checkMicPermission]);

  if (!settings?.enabled) return null;

  const micDenied = micPermission === 'denied';

  const handleMouseDown = useCallback(() => {
    if (micDenied) return;
    if (settings.activationMode !== 'push-to-talk') return;
    setRecording(true);
  }, [micDenied, settings?.activationMode, setRecording]);

  const handleMouseUp = useCallback(() => {
    if (!recording) return;
    setRecording(false);
    setTranscribing(true);
  }, [recording, setRecording, setTranscribing]);

  return (
    <div className="flex items-center gap-2 px-2">
      {/* Mic button */}
      <button
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        disabled={micDenied}
        className={`
          w-7 h-7 rounded-full flex items-center justify-center transition-all
          ${micDenied
            ? 'bg-ctp-red/20 text-ctp-red cursor-not-allowed'
            : recording
            ? 'bg-red-500 text-white animate-pulse cursor-pointer'
            : transcribing
            ? 'bg-ctp-yellow text-white cursor-pointer'
            : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer'
          }
        `}
        title={
          micDenied ? 'Microphone access denied. Go to System Settings > Privacy & Security > Microphone to grant access.'
            : recording ? 'Recording... Release to send'
            : transcribing ? 'Transcribing...'
            : `Hold to talk (${settings.globalKeybind || 'Space'})`
        }
      >
        {micDenied ? (
          /* Mic-off / warning icon */
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.12 1.5-.35 2.18" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        ) : transcribing ? (
          <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        )}
      </button>

      {/* Speaking indicator */}
      {speaking && speakingAgent && (
        <div className="flex items-center gap-1.5 text-xs text-ctp-subtext0">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: speakingAgent.color }}
          />
          <span>{speakingAgent.name}</span>
          <div className="flex gap-0.5 items-end h-3">
            <div className="w-0.5 bg-ctp-subtext0 rounded-full animate-pulse" style={{ height: '40%', animationDelay: '0ms' }} />
            <div className="w-0.5 bg-ctp-subtext0 rounded-full animate-pulse" style={{ height: '70%', animationDelay: '150ms' }} />
            <div className="w-0.5 bg-ctp-subtext0 rounded-full animate-pulse" style={{ height: '50%', animationDelay: '300ms' }} />
          </div>
        </div>
      )}

      {/* Quick mute */}
      <button
        onClick={() => useAudioStore.getState().saveSettings({ enabled: false })}
        className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
        title="Mute audio"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      </button>
    </div>
  );
}
