import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioStore } from '../../../stores/audioStore';

export function useAudioPlayback() {
  const [isPlaying, setIsPlaying] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<AudioBuffer[]>([]);
  const playingRef = useRef(false);

  const getContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      contextRef.current = new AudioContext({ sampleRate: 22050 });
    }
    return contextRef.current;
  }, []);

  const playNext = useCallback(() => {
    if (queueRef.current.length === 0) {
      playingRef.current = false;
      setIsPlaying(false);
      useAudioStore.getState().setSpeaking(false);
      return;
    }

    playingRef.current = true;
    setIsPlaying(true);
    const buffer = queueRef.current.shift()!;
    const ctx = getContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = playNext;
    source.start();
  }, [getContext]);

  useEffect(() => {
    const unsub = window.clubhouse.audio.onSpeakAudio((audioData: Buffer) => {
      try {
        const ctx = getContext();
        // Assume raw PCM Int16 mono at 22050Hz from Piper
        const int16 = new Int16Array(
          audioData.buffer,
          audioData.byteOffset,
          audioData.byteLength / 2,
        );
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 0x8000;
        }

        const audioBuffer = ctx.createBuffer(1, float32.length, 22050);
        audioBuffer.getChannelData(0).set(float32);
        queueRef.current.push(audioBuffer);

        if (!playingRef.current) {
          playNext();
        }
      } catch (err) {
        console.error('Failed to process audio chunk:', err);
      }
    });

    return () => {
      unsub();
    };
  }, [getContext, playNext]);

  const cancelPlayback = useCallback(() => {
    queueRef.current = [];
    if (contextRef.current && contextRef.current.state !== 'closed') {
      contextRef.current.close();
      contextRef.current = null;
    }
    playingRef.current = false;
    setIsPlaying(false);
    useAudioStore.getState().setSpeaking(false);
    window.clubhouse.audio.cancelSpeech();
  }, []);

  return { isPlaying, cancelPlayback };
}
