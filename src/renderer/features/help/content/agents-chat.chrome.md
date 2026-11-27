# Chat and media

Chat shows an agent's conversation as messages, with images, files and approvals inline. Terminal shows the CLI itself, as it runs in a terminal. Each agent can use either one. See [CLI and transcripts](#help:agents-terminal) for Terminal.

## Chat or Terminal

| CLI | Chat |
|-----|------|
| Claude Code | Yes |
| Codex CLI | Yes, in beta |
| Copilot CLI | Yes, in beta |
| Antigravity CLI | Experimental, when you turn it on in **Settings > Experimental** |

Every CLI opens in Chat unless you change it. Chat needs a recent enough version of the CLI. With an older one, agents open in Terminal until you update it.

- **For a CLI:** in **Settings > Agents & CLIs**, each CLI has a **View** row with **Chat** and **Terminal**.
- **For one agent:** the agent's settings have a **View** with **CLI default**, **Chat** and **Terminal**. Stop the agent to change it.
- **Right now:** the switch at the top of the agent's pane moves between the two without restarting. It resumes the same session. If the agent is in the middle of a turn, Clubhouse asks before it interrupts.
- **Everywhere:** turn off **Chat view** in **Settings > Agents & CLIs** to show every agent in Terminal. Agents already running stay as they are until they sleep.

**Rich chat content**, also in **Settings > Agents & CLIs**, turns on inline images, links, file previews and GitHub references.

## Reading a chat

Your messages are on the right. A message you steered into a running turn says so, and one that couldn't be sent says **Not delivered**. The agent's replies are on the left, with its name at the start of each run.

Messages from other agents, such as a helper or the Dispatcher, are on the left with that agent's name and avatar. A long one starts as a short preview with **Show more**.

Routine tool calls fold into one line, like "Made 4 tool calls" or "Explored 3 files, 2 searches". Click the line to see each call.

The buttons at the bottom right of the chat move between the agent's messages, with **Previous agent message**, **Next agent message** and **Latest**. The chat follows new messages until you scroll up, and then holds your place.

## Sending while an agent works

While a turn runs, the send button changes.

| Button | What it does |
|--------|--------------|
| **Steer** | Adds your message to the running turn, for CLIs that support it |
| **Stop & send** | Stops the turn and sends your message |
| **Queue** | Holds your message until the turn ends |

Enter does the main action, and `⌘Enter` queues. Esc stops the turn.

Queued messages wait in a list above the composer, with how long the oldest has waited. Remove one with its **X**, or use **Clear all**.

If Clubhouse can't confirm a message was delivered, it keeps a copy. **Restore saved message** puts it back in the composer without sending it again.

## The composer

- `Shift+Enter` starts a new line. Lists, bold and italic are kept as you type them, and `Tab` indents a list item.
- Type `/` for the CLI's own commands, when it has them.
- **Access** shows the agent's level for this session. Changing it here applies to this session only, and the agent's settings don't change.
- **Model** and **Effort** set the model, context and reasoning effort, where the CLI offers them.

## Approvals

When the agent asks for approval, the request is pinned above the composer. With several waiting, move between them with **Previous request** and **Next request**. The buttons are the CLI's own choices. Your answer goes to exactly the request you clicked, so a request that has already closed ignores it.

The same requests show in the conversation, where **Answer here** opens them.

## Images and files

Attach files with the paperclip, by dragging them onto the chat, or by pasting.

- Images can be PNG, JPEG, GIF or WebP, up to 3.75 MB each.
- Other files go to the agent as paths, up to 20 MB each.
- A message can carry up to 10 attachments.

Images show as thumbnails. Click one for a larger view, with **Copy** and **Show in Finder**. Audio and video play in place, and PDFs open in a preview.

A file path in a message becomes a chip. Click it to preview the file. Markdown has **Preview** and **Source**, and **Open in Files** opens it in the Files tab. A muted chip says why it can't be shown, such as **File not found**. Links to files open the preview, and links to folders reveal them.

Right-click for **Copy link address**, **Copy file path** or **Copy image**.

## Where media goes

Clubhouse keeps chat images on this computer. When they pass 1 GiB in all, it removes the ones used least recently, but never one from the last 10 minutes. Deleting an agent removes its media, and an image that's gone shows as unavailable.

## Chat on another computer

With Annex Network, you can open the chat of an agent on your other computers. You can read it as it streams, send, steer, stop, answer approvals and questions, and set its model and level. Images load and can be attached when that computer's CLI takes them. File previews by path, past sessions and the Changes review stay on that computer. See [Annex](#help:settings-annex).

See also [CLI and transcripts](#help:agents-terminal), [Durable agents](#help:agents-durable)
