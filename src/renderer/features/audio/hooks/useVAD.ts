import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioStore } from '../../../stores/audioStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useAudioCapture } from './useAudioCapture';

const SILENCE_TIMEOUT_MS = 1500;
const ANALYSIS_INTERVAL_MS = 100;

export function useVAD() {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const { startCapture, stopCapture } = useAudioCapture();
  const settings = useAudioStore((s) => s.settings);
  const { setRecording, setTranscribing } = useAudioStore();

  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakingRef = useRef(false);

  const getThreshold = useCallback(() => {
    const sensitivity = settings?.vadSensitivity ?? 0.5;
    // Map 0.0-1.0 sensitivity to RMS threshold (higher sensitivity = lower threshold)
    return 0.01 + (1 - sensitivity) * 0.04;
  }, [settings?.vadSensitivity]);

  const stopListening = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (contextRef.current) {
      contextRef.current.close();
      contextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    analyserRef.current = null;
    speakingRef.current = false;
    setIsListening(false);
    setIsSpeaking(false);
  }, []);

  const handleSilence = useCallback(async () => {
    if (!speakingRef.current) return;
    speakingRef.current = false;
    setIsSpeaking(false);
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
      console.error('VAD transcription failed:', err);
    } finally {
      setTranscribing(false);
    }
  }, [stopCapture, setRecording, setTranscribing]);

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });

      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      streamRef.current = stream;
      contextRef.current = context;
      analyserRef.current = analyser;
      setIsListening(true);

      const dataArray = new Float32Array(analyser.fftSize);

      intervalRef.current = setInterval(() => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(dataArray);

        // Calculate RMS
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const threshold = getThreshold();

        if (rms > threshold) {
          // Speech detected
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }

          if (!speakingRef.current) {
            speakingRef.current = true;
            setIsSpeaking(true);
            setRecording(true);
            startCapture();
          }
        } else if (speakingRef.current) {
          // Silence while speaking — start countdown
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              silenceTimerRef.current = null;
              handleSilence();
            }, SILENCE_TIMEOUT_MS);
          }
        }
      }, ANALYSIS_INTERVAL_MS);
    } catch (err) {
      console.error('Failed to start VAD:', err);
      setIsListening(false);
    }
  }, [getThreshold, startCapture, setRecording, handleSilence]);

  // Auto-start/stop based on settings
  useEffect(() => {
    if (settings?.enabled && settings.activationMode === 'vad') {
      startListening();
    } else {
      stopListening();
    }

    return () => {
      stopListening();
    };
  }, [settings?.enabled, settings?.activationMode, startListening, stopListening]);

  return { isListening, isSpeaking };
}
