import type { PluginManifest } from '../../../../shared/plugin-types';

const MIC_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;

export const manifest: PluginManifest = {
  id: 'voice-chat',
  name: 'Voice Chat',
  version: '0.1.0',
  description: 'Push-to-talk voice conversations with durable agents using Whisper STT and Piper TTS.',
  author: 'Clubhouse',
  engine: { api: 0.5 },
  scope: 'project',
  permissions: ['voice', 'agents', 'notifications'],
  contributes: {
    tab: { label: 'Voice', icon: MIC_ICON, layout: 'sidebar-content' },
    help: {
      topics: [
        {
          id: 'voice-chat',
          title: 'Voice Chat',
          content:
            '## Voice Chat\n\n' +
            'Have voice conversations with your durable agents using push-to-talk.\n\n' +
            '### Getting Started\n' +
            '1. Open the **Voice** tab from the explorer rail\n' +
            '2. Select a sleeping durable agent from the sidebar\n' +
            '3. On first use, voice models will be downloaded (~200MB)\n' +
            '4. Hold the **Push to Talk** button and speak\n' +
            '5. Release to send — the agent will respond with synthesized speech\n\n' +
            '### Controls\n' +
            '| Action | Input |\n' +
            '|--------|-------|\n' +
            '| Push to talk | Hold **Space** or click and hold the mic button |\n' +
            '| Release to send | Release **Space** or mouse button |\n' +
            '| Interrupt playback | Start a new recording while agent is speaking |\n' +
            '| End session | Click **End** in the header bar |\n\n' +
            '### How It Works\n' +
            '- **Speech-to-text**: Your speech is transcribed locally using Whisper (no audio leaves your machine)\n' +
            '- **Agent interaction**: The transcribed text is sent to Claude in the agent\'s worktree context\n' +
            '- **Text-to-speech**: Responses are spoken back using Piper with a consistent voice per agent\n' +
            '- **Multi-turn**: Context is maintained across the entire conversation via `--resume`\n\n' +
            '### Agent Selection\n' +
            '- **Sleeping agents** are ready for voice immediately\n' +
            '- **Running agents** can be selected but their current session will be ended first (confirmation required)\n' +
            '- Each agent gets a consistent TTS voice based on its ID\n',
        },
        {
          id: 'voice-chat-troubleshooting',
          title: 'Voice Chat Troubleshooting',
          content:
            '## Voice Chat Troubleshooting\n\n' +
            '### Microphone Access\n' +
            'Voice Chat requires microphone permission. If the browser blocks access:\n' +
            '- Check that Clubhouse has microphone permission in **System Settings > Privacy & Security > Microphone**\n' +
            '- Ensure no other application is exclusively using the microphone\n' +
            '- Try restarting the application after granting permission\n\n' +
            '### Model Download Issues\n' +
            '- Models are stored in `~/.clubhouse/voice-models/`\n' +
            '- Total download size is approximately 200MB (Whisper ~141MB, Piper voice ~75MB)\n' +
            '- If a download fails partway, retry — partial downloads are automatically cleaned up\n' +
            '- Check your internet connection if downloads stall\n\n' +
            '### No Audio Playback\n' +
            '- Verify your system audio output is working\n' +
            '- Check that the browser/app is not muted\n' +
            '- TTS runs at 22050Hz sample rate — ensure your audio device supports this\n\n' +
            '### Transcription Quality\n' +
            '- Whisper uses the `base.en` model — optimized for English\n' +
            '- Speak clearly and minimize background noise for best results\n' +
            '- Very short utterances (< 1 second) may not transcribe reliably\n',
        },
      ],
    },
  },
};
