import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioStore } from '../../../stores/audioStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useAudioCapture } from './useAudioCapture';

export function usePushToTalk() {
  const [isActive, setIsActive] = useState(false);
  const activeRef = useRef(false);
  const { startCapture, stopCapture } = useAudioCapture();
  const settings = useAudioStore((s) => s.settings);
  const { setRecording, setTranscribing } = useAudioStore();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!settings?.enabled || settings.activationMode !== 'push-to-talk') return;

      // Don't trigger when typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;

      const keybind = settings.globalKeybind || 'Space';
      if (e.code !== keybind && e.key !== keybind) return;

      if (activeRef.current) return; // already recording
      e.preventDefault();
      activeRef.current = true;
      setIsActive(true);
      setRecording(true);
      startCapture();
    },
    [settings, startCapture, setRecording],
  );

  const handleKeyUp = useCallback(
    async (e: KeyboardEvent) => {
      if (!activeRef.current) return;

      const keybind = settings?.globalKeybind || 'Space';
      if (e.code !== keybind && e.key !== keybind) return;

      e.preventDefault();
      activeRef.current = false;
      setIsActive(false);
      setRecording(false);
      stopCapture();

      // Trigger transcription
      setTranscribing(true);
      try {
        const agents = Object.values(useAgentStore.getState().agents);
        const focusedAgentId = useAgentStore.getState().activeAgentId;
        const result = await window.clubhouse.audio.stopRecording(
          agents,
          focusedAgentId,
        );
        if (result?.text) {
          // Send transcribed text to the target agent's terminal
          window.clubhouse.pty.write(result.agentId, result.text + '\n');
        }
      } catch (err) {
        console.error('Transcription failed:', err);
      } finally {
        setTranscribing(false);
      }
    },
    [settings, stopCapture, setRecording, setTranscribing],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  return { isActive };
}
