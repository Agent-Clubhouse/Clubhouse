# Sound & Audio

Configure notification sounds with sound packs, per-event controls, and per-project overrides.

## Sound Packs

A sound pack is a set of audio files for notification events. Types:

| Source | Description |
|--------|-------------|
| **OS Default** | System notification sounds |
| **User-created** | Import a folder of audio files from `~/.clubhouse/sounds/` |
| **Plugin-provided** | Packs contributed by plugins (cannot be deleted) |

Supported formats: `.mp3`, `.wav`, `.ogg`

## Per-Event Controls

Four sound events, each with independent settings:

| Event | Triggers When |
|-------|--------------|
| **Agent Finished** | An agent completes its mission |
| **Error** | An agent encounters a fatal error |
| **Permission Request** | An agent is waiting for approval |
| **General Notification** | Other notification events |

For each event:
- **Enable/disable** toggle
- **Volume slider** (0–100%)
- **Preview button** — plays the sound at current settings

## Per-Project Overrides

Each project can use a different sound pack: **Project Settings > Sound Pack**.

## Managing Packs

- Import folders from `~/.clubhouse/sounds/`
- Delete user-created packs from Settings
- Plugin-provided packs show a "Plugin" badge and cannot be removed

**Access:** **Settings > Sound**
