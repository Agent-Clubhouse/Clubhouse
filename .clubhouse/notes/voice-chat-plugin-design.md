# Voice Chat Plugin — Design Doc

Status: Scoped, waiting on plugin model
Last updated: 2026-02-12

## Core Concept

1:1 voice conversation with a durable agent. User speaks, agent hears (via STT), thinks, responds (via TTS). Multi-turn, persistent context. Implemented as a **plugin** to the Clubhouse app.

Voice chat creates **quick agents** under a durable parent — same model, same config inheritance, same completion cards. The only difference is I/O: voice in, voice out, with a text transcript.

## Pipeline

```
PTT → Mic capture → Whisper.cpp STT → text
  → claude -p --resume → streaming JSON
  → sentence split → Piper TTS → speaker
```

## Decided Architecture

### Agent Model: Voice = Quick Agents

- Voice chat spawns quick agents under a durable parent
- Inherits durable's quick agent config (system prompt, allowed tools, model, etc.)
- No expectation of shared session with the terminal — separate context, same workspace
- Completion creates a `CompletedQuickAgent` ghost card like any other quick agent
- Mission = first spoken utterance; summary = accumulated from conversation

### Multi-Turn: Serial `claude -p --resume` with Warm Pool

Each spoken turn spawns a short-lived `claude -p` process. Conversation continuity via `--resume`:

```
Voice panel opens
  → Pre-warm: spawn claude -p --output-format stream-json (no prompt, waits on stdin)

User speaks → STT → text
  → Pipe text to warm process's stdin
  → Stream response → sentence split → TTS playback
  → Capture session_id from streaming output
  → Pre-warm next: spawn claude -p --resume <id> --output-format stream-json (waits on stdin)

User speaks again → STT → text
  → Pipe to already-warm process
  → Stream → TTS
  → Pre-warm next
```

- `--resume` preserves full conversation history across turns
- Warm pool eliminates process startup latency (turns 2+)
- Turn 1 pre-warmed when voice panel opens
- Perceived latency = STT time + Claude thinking (no process startup in critical path)

### STT: Whisper.cpp

- Library: `@kutalia/whisper-node-addon` (prebuilt Node bindings)
- Model: `small.en` (~150MB, good accuracy) or `base.en` (~75MB, faster/lighter)
- Accepts raw PCM audio, ~1-3s latency per utterance
- Runs in main process
- Models stored in `~/.clubhouse/voice-models/`

### TTS: Piper

- Piper binary as persistent subprocess
- `--output-raw` pipes S16LE PCM to stdout
- Model: `en_GB-vctk-medium` — 109 speaker IDs for per-agent voice variety
- ~200-500ms latency per sentence
- Binary ~15MB + model ~75MB
- Stored in `~/.clubhouse/voice-models/`

### Audio Playback

- Web Audio API in renderer
- Convert S16LE PCM → float32 → AudioContext
- Stream sentence-by-sentence for low perceived latency

### Model Downloads

- Download on first use (not bundled with app)
- Check for models on first Voice button click
- Show download progress dialog if missing
- Store in `~/.clubhouse/voice-models/`
- Future: settings UI to pick models

### Permissions

- Inherit parent durable's quick agent settings (`allowedTools`, permissions config)
- If a tool needs permission beyond what's pre-configured, show a visual approval button in the voice transcript panel
- Pause response streaming until approved

## UI

### Entry Point

Plugin-defined — will integrate with the plugin model being built by another agent. Likely a button/action available when viewing a durable agent.

### Voice Panel

- Overlay/panel on the durable agent view (not a separate tab)
- Full text transcript: scrollable chat log showing user utterances + agent responses
- PTT button (push-to-talk)
- Visual tool-use indicators during agent work ("Reading file...", "Running command...")
- Status indicator: listening / transcribing / thinking / speaking / idle

### Completion

- "End Voice Chat" → creates `CompletedQuickAgent` ghost card
- Same UI as any other completed quick agent

## Input Mode

- PTT (push-to-talk) for v1
- Always-on deferred to v2 (needs VAD + echo cancellation)

## Electron Concerns

- Mic permission: `NSMicrophoneUsageDescription` in Info.plist
- Check `systemPreferences.askForMediaAccess('microphone')` before starting
- Graceful "mic access required" message if denied

## Streaming TTS Strategy

- Accumulate `content_block_delta` events from streaming JSON
- Split on sentence-ending punctuation (`. ` `! ` `? ` or newline) with small buffer
- Feed each complete sentence to Piper immediately
- ~200-500ms latency per sentence after first tokens arrive

## Not In Scope (v1)

- Always-on mic (VAD + echo cancellation)
- Parler TTS / GPU-based voices (3.5GB+ models, Python dep)
- Voice during terminal simultaneously (visually one or the other)
- Saving transcript beyond the completion card
- Multi-voice / multi-agent voice sessions
- Text fallback (type instead of speak) — trivial to add later

## Files That Would Change

Dependent on plugin model architecture, but roughly:

**Main process (new services):**
- `stt-service.ts` — Whisper.cpp wrapper
- `tts-service.ts` — Piper subprocess manager
- `voice-agent.ts` — manages claude -p lifecycle, warm pool, session resume
- `model-downloader.ts` — download/verify Whisper + Piper models

**Renderer (new):**
- `voiceChatStore.ts` — session state, transcript, PTT state, warm pool status
- `VoiceChatPanel.tsx` — main overlay UI
- `TranscriptView.tsx` — chat log
- `PTTButton.tsx` — push-to-talk control

**Shared:**
- IPC channels for voice namespace
- Types for voice session, transcript entries

**Existing (minor changes):**
- Preload: expose voice API
- Agent store: voice quick agent variant handling
- Info.plist: mic permission string

## Dependencies (New)

- `@kutalia/whisper-node-addon` — Whisper.cpp Node bindings
- Piper binary (downloaded, not npm)
- Whisper model files (downloaded)
- Piper voice model files (downloaded)

## Open Questions for Later

1. Can `claude -p` reliably read follow-up prompts from stdin after being spawned with no initial prompt? Needs testing.
2. What's the exact streaming JSON format for session_id extraction? Need to check `--output-format stream-json` docs.
3. Should each durable agent get a consistent Piper speaker ID (mapped from agent ID → speaker 0-108)? Fun but cosmetic.
4. How to handle mid-response interruption (user speaks while agent is still talking)?
5. Plugin registration API — depends on the plugin model design.
