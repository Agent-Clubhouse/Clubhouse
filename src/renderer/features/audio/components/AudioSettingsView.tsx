import { useEffect } from 'react';
import { useAudioStore } from '../../../stores/audioStore';

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={`
        relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
        ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
        ${checked ? 'bg-indigo-500' : 'bg-surface-2'}
      `}
    >
      <span
        className={`
          absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform duration-200
          ${checked ? 'translate-x-4' : 'translate-x-0'}
        `}
      />
    </button>
  );
}

export function AudioSettingsView() {
  const { settings, loadSettings, saveSettings } = useAudioStore();

  useEffect(() => { loadSettings(); }, [loadSettings]);

  if (!settings) {
    return <div className="p-6 text-ctp-subtext0 text-sm">Loading audio settings...</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-ctp-text">Audio & Voice</h2>
        <p className="text-sm text-ctp-subtext0 mt-1">
          Configure speech-to-text, text-to-speech, and voice settings.
        </p>
      </div>

      {/* Master enable */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-ctp-text">Enable Audio</div>
          <div className="text-xs text-ctp-subtext0">
            Enable voice input/output for agents
          </div>
        </div>
        <Toggle checked={settings.enabled} onChange={(v) => saveSettings({ enabled: v })} />
      </div>

      {!settings.enabled ? (
        <div className="text-sm text-ctp-subtext0 italic">Enable audio to configure voice settings.</div>
      ) : (
        <div className="space-y-6">
          {/* STT Backend */}
          <div>
            <label className="text-sm font-medium text-ctp-text block mb-1">Speech-to-Text Backend</label>
            <select
              value={settings.sttBackend}
              onChange={(e) => saveSettings({ sttBackend: e.target.value })}
              className="w-full bg-surface-0 border border-surface-2 rounded px-3 py-2 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue"
            >
              <option value="whisper-local">Whisper (Local)</option>
              <option value="parakeet-local">Parakeet (Local)</option>
              <option value="openai-cloud">OpenAI Whisper (Cloud)</option>
            </select>
          </div>

          {/* TTS Backend */}
          <div>
            <label className="text-sm font-medium text-ctp-text block mb-1">Text-to-Speech Backend</label>
            <select
              value={settings.ttsBackend}
              onChange={(e) => saveSettings({ ttsBackend: e.target.value })}
              className="w-full bg-surface-0 border border-surface-2 rounded px-3 py-2 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue"
            >
              <option value="piper-local">Piper (Local)</option>
              <option value="openai-cloud">OpenAI TTS (Cloud)</option>
            </select>
          </div>

          {/* Activation Mode */}
          <div>
            <label className="text-sm font-medium text-ctp-text block mb-1">Activation Mode</label>
            <select
              value={settings.activationMode}
              onChange={(e) => saveSettings({ activationMode: e.target.value as 'push-to-talk' | 'vad' })}
              className="w-full bg-surface-0 border border-surface-2 rounded px-3 py-2 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue"
            >
              <option value="push-to-talk">Push to Talk</option>
              <option value="vad">Voice Activity Detection (VAD)</option>
            </select>
          </div>

          {/* VAD Sensitivity - only shown when VAD is active */}
          {settings.activationMode === 'vad' && (
            <div>
              <label className="text-sm font-medium text-ctp-text block mb-1">
                VAD Sensitivity: {((settings.vadSensitivity ?? 0.5) * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0"
                max="100"
                value={(settings.vadSensitivity ?? 0.5) * 100}
                onChange={(e) => saveSettings({ vadSensitivity: Number(e.target.value) / 100 })}
                className="w-full accent-indigo-500"
              />
              <div className="flex justify-between text-xs text-ctp-subtext0 mt-1">
                <span>Less sensitive</span>
                <span>More sensitive</span>
              </div>
            </div>
          )}

          {/* Routing Mode */}
          <div>
            <label className="text-sm font-medium text-ctp-text block mb-1">Voice Routing</label>
            <select
              value={settings.routingMode}
              onChange={(e) => saveSettings({ routingMode: e.target.value as 'focused' | 'smart' })}
              className="w-full bg-surface-0 border border-surface-2 rounded px-3 py-2 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue"
            >
              <option value="focused">Focused Agent Only</option>
              <option value="smart">Smart Routing (name + context matching)</option>
            </select>
          </div>

          {/* TTS Filter */}
          <div>
            <div className="text-sm font-medium text-ctp-text mb-3">What Gets Spoken</div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-ctp-text">Agent Responses</div>
                  <div className="text-xs text-ctp-subtext0">Conversational replies from agents</div>
                </div>
                <Toggle
                  checked={settings.ttsFilter.speakResponses}
                  onChange={(v) => saveSettings({ ttsFilter: { ...settings.ttsFilter, speakResponses: v } })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-ctp-text">Tool Summaries</div>
                  <div className="text-xs text-ctp-subtext0">Brief descriptions of tool actions</div>
                </div>
                <Toggle
                  checked={settings.ttsFilter.speakToolSummaries}
                  onChange={(v) => saveSettings({ ttsFilter: { ...settings.ttsFilter, speakToolSummaries: v } })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-ctp-text">Errors</div>
                  <div className="text-xs text-ctp-subtext0">Error messages and failures</div>
                </div>
                <Toggle
                  checked={settings.ttsFilter.speakErrors}
                  onChange={(v) => saveSettings({ ttsFilter: { ...settings.ttsFilter, speakErrors: v } })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-ctp-text">Status Changes</div>
                  <div className="text-xs text-ctp-subtext0">Agent status updates (started, stopped, etc.)</div>
                </div>
                <Toggle
                  checked={settings.ttsFilter.speakStatus}
                  onChange={(v) => saveSettings({ ttsFilter: { ...settings.ttsFilter, speakStatus: v } })}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
