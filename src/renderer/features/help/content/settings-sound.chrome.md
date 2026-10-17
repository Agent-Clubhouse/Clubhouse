# Sound

Sounds live on the **Notifications & alerts** page: open Settings with `⌘,` and pick **Notifications & alerts**, then scroll to **Sounds**.

## Event sounds

Each event has its own row: the pack its sound comes from, a volume slider, **Preview**, and a switch to turn it off.

| Event | Plays when |
|-------|------------|
| **Agent finished** | An agent completes its task |
| **Error** | An agent hits an error |
| **Permission request** | An agent is waiting for your approval |
| **Permission granted** and **Permission denied** | You answer a permission request |
| **Agent wake** and **Agent sleep** | A durable agent wakes or goes to sleep |
| **Agent focus** | You switch to an agent |
| **General notification** | Any other notification |

Mix sounds from different packs, or use **Apply all** on a pack card to take every sound from it.

## Sound packs

A pack is a folder of audio files, one per event. Supported formats are `.mp3`, `.wav` and `.ogg`.

| Source | Notes |
|--------|-------|
| **OS default** | Your system's notification sound |
| **Your own** | Put files in `~/.clubhouse/sounds/<pack-name>/`, or click **Import sound pack** and pick a folder. You can delete these. |
| **From plugins** | Marked as plugin packs. You can't delete these here. |

## Per project

A project can use a different pack. Open its settings, pick **Notifications & alerts**, and set **Sound pack override**.
