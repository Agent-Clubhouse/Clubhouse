# The Dispatcher

The Dispatcher is one agent for the whole app. You talk to it in plain words, and it keeps track of your agents and projects, gets work going across them, checks in, and remembers what you decided. It's at the top of the sidebar, above your projects, and it's on by default.

"Dispatcher" is its working name. You can give it your own name, look and personality.

Your **chat** uses that name. **Dispatcher controller** is its internal agent that carries out hand-offs and holds its connections and permissions. That fixed label appears on connections, messages to other agents, Actions and diagnostic conversation titles. You still talk to it in one chat. In the restart dialog, interrupting the controller can interrupt hand-offs; it resumes when next needed.

## Getting started

The first time you open it, a short setup walks you through three steps, with a preview of how it will look and sound:

1. **Name and look.** A name, a color, and an image or emoji. The name shows in the sidebar, in its chat and on your phone.
2. **Behavior.** Light, Standard or Thorough, and **Runs on**, the provider it uses. If your Auto mapping doesn't cover that provider yet, **Set up Auto** opens it.
3. **Personality.** Friendly, Concise or Detailed fill in the text it's told, or pick Custom and write your own. The text is always shown and you can edit it. **Try it out** asks the chosen model one sample question with that personality and shows the real reply. No agent is involved.

**Set up later** starts it with its name, Standard and Concise, and a line above its chat offers setup again. Upgrading from an earlier version, you see setup once, filled in with what you had.

In its first conversation it introduces itself: how many agents it can reach, what it does, and that it remembers. Suggestions with the introduction are built from your connected agents, and always include a schedule example, an agent example and **What else can you do?** That last one answers with a plain list made from its real permissions, grouped as your agents, new agents and connections, schedules and follow-ups, projects and settings, and keeping track.

## Talking with it

Its chat is your conversation with the Dispatcher. You never see tool calls, task ids or reply instructions there.

- **Agents' news** reaches you once, in the Dispatcher's words, with the agent named. When an agent has a question for you, answer it right there in the chat. What the Dispatcher and your agents say to each other along the way stays in each agent's own chat.
- **What shows right away:** news that needs you, or that answers something you asked. Routine news waits for the next check-in, and some is never shown.
- **Check-ins** sum up what changed since the last one, and appear only when something did.
- **One long conversation.** It keeps one chat going and compacts it as it grows. **Clear chat** in its menu starts the conversation over, after asking. Clearing the chat never touches its memory.

A message from one of your agents wakes it if it's asleep, so it doesn't need to stay running. Check-ins and upkeep wake it too.

Its composer has one **Behavior** chip in place of the model and permission pickers.

## Behavior

One setting covers which models it uses and how often it works on its own:

| | Light | Standard | Thorough |
|---|---|---|---|
| Models | The fast tier | Balanced | The strongest for its work, balanced for chat |
| Check-ins | None | Occasionally | Frequently |
| Memory upkeep | Nightly | Nightly, and after a long quiet stretch | Nightly, and after each quiet stretch |

Clubhouse turns each level into models for your provider through the Auto mapping, and keeps tuning what each level means. Change it from the chip or in **Settings > Dispatcher**; both show the same setting.

### Choose models yourself

To pick the models instead, turn on **Choose models yourself** in **Settings > Dispatcher**, under Behavior. It shows two rows, **Talking with you** and **Working in the background**, each with a provider, model, effort and, where the provider offers it, context. The two can use different providers. Behavior then sets only how often it checks in and keeps up its memory, and the chip says the models are yours.

A new model or effort applies at once where the provider allows it, otherwise at its next start. A new provider or context applies at its next start. Turn the switch off to let Behavior choose again: it goes back to the provider and context it had before, and your picks are kept for next time. While the switch is on, change its provider here rather than from your phone's provider change. Going through setup again turns it off, since setup picks one provider.

## Memory

It keeps memory as plain markdown files in `~/.clubhouse/dispatcher/memory/`, so any provider can read it and it survives a provider switch:

- a short index it reads at every start,
- a page for each connected agent, with the agent's own card at the top and the Dispatcher's notes under it,
- a timeline where detail fades with age, days rolling into weeks and weeks into months,
- a page for each piece of work, marked confirmed or unconfirmed with where it came from.

It searches its memory and your agents' transcripts when it needs something older. Upkeep runs on its own: it rolls up the timeline, fixes links that moved and sets aside stale unconfirmed notes. There's no view or editor for memory in the app.

**Forget everything** is at the bottom of **Settings > Dispatcher**. After you confirm, it clears its memory and any news waiting for the next check-in. Your agents, connections, Actions, settings and its chat stay. To start the chat over too, use **Clear chat**.

## Your agents

An agent connects to the Dispatcher with the switch on its **Dispatcher card** in Details, titled with the Dispatcher's name. Agents that orchestrate are connected by default. When an agent connects, Clubhouse asks it for a short card: what it's for, when to reach it and what it owns. The card shows "Asking what it does…" until it answers. You can edit the card, and your edit replaces what the agent wrote. See **Orchestrated helpers** for the card in full.

**Settings > Dispatcher** lists every agent that can connect, across all your projects, with the same switch. **Card** opens that agent with its Dispatcher card open.

An agent can ask to be told when something happens, for example "tell me when main is pushed". That becomes an Action the agent owns, which messages it. The Dispatcher follows your agents the same way. See **Actions**.

## What it can do

By default it can read, message, wake, put to sleep, reset, rename and set up the agents connected to it, create agents in any project, make and remove connections, and create and run Actions. It asks you first before it adds or opens a project, changes project defaults or changes app settings. Its Clubhouse permissions, under **Permissions** on any agent's Dispatcher card, set each of these to Off, Ask first or Allow. It never sets an agent's access above its own.

When it links two of your orchestrators, you can say what each may do to the other, for example "let them see each other's status, message and wake each other, nothing else". It sets those switches on the link and reads them back to check. A new link it makes can read, message and wake, with **Clear** and **Compact** off. It never changes switches you set yourself, and never lets one agent put another to sleep. The link's switches are on each agent's **Connections** card under **Manage**.

For a team of agents, ask the Dispatcher to list group projects or open the group project directory. In the directory, create a group project, review who joins, and add it to a canvas if useful. Choose the **Group project lead** built-in role block for an agent you want to coordinate, then give that member the lead grant for the group project. Add the **Group projects** block to participating agents so they know how to use the board. See **Group projects** for scope, membership and notices.

Permission prompts stay with the agent that asked, and an agent's message never counts as your approval. Requests that ask first wait in **Needs you**.

## Settings

**Settings > Dispatcher** has, from top to bottom:

- **Turn on Dispatcher.** On by default. Turning it off stops it and keeps its folder and memory. It needs the new layout: on the Classic layout it can be turned off, not on.
- **Identity:** **Set up…** to go through setup again, its name, color, icon and personality.
- **Behavior:** the level, **Choose models yourself**, **Runs on**, auto-sleep, and what it used today, split into conversations and background work. Switching **Runs on** starts a fresh conversation on the new provider; its memory stays, so it picks up from what it remembers. With **Choose models yourself** on, each row has its own provider in place of **Runs on**.
- **Connected agents.**
- **Reset:** **Forget everything**.

## On your phone

With Annex paired, the Dispatcher shows on your phone under its name, with the same chat: your messages and its replies, without tool rows.
