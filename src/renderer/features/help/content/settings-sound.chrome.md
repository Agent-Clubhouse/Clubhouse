# Sound

Sounds live on the **Notifications & alerts** page: open Settings with `⌘,` and pick **Notifications & alerts**, then scroll to **Sounds**.

## Event sounds

Each event has its own row: the pack its sound comes from (or **System default**), a volume slider, **Preview**, and a switch to turn it off.

| Event | Plays when |
|-------|------------|
| **Agent Finished** | An agent completes its task |
| **Error** | An agent hits an error |
| **Permission Request** | An agent is waiting for your approval |
| **Permission Granted** and **Permission Denied** | You answer a permission request |
| **Agent Wake** and **Agent Sleep** | A durable agent wakes or goes to sleep |
| **Agent Focus** | You switch to an agent |
| **General Notification** | Any other notification |

Mix sounds from different packs, or click **Apply to all** on a pack to take every sound from it. **Reset to system sounds** puts every event back on the system default.

## Sound packs

A pack is a folder of audio files, one per event. Supported formats are `.mp3`, `.wav` and `.ogg`. Packs come from two places:

- **Your own.** Put files in `~/.clubhouse/sounds/<pack-name>/`, or click **Import pack…** and pick a folder. You can delete these.
- **Plugins.** These are marked **From a plugin**, and you can't delete them here.

## Per project

A project can use different sounds. Open its settings, pick **Notifications & alerts**, and use **Sound pack override**. Until you change it, the project uses the global sounds.
