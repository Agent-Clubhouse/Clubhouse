# Handoffs

A handoff moves a task, with its files, from one agent to another agent or to another computer's Dispatcher, which picks an agent there. The receiver has to agree first. When it accepts, Clubhouse checks the files, copies them and applies them into a fresh worktree on the receiving side.

It isn't the same as a helper finishing work for its orchestrator. That stays on this computer and needs no agreement.

## Who can offer and accept

Two Clubhouse permissions control handoffs, on the **Clubhouse permissions** page in each agent's settings:

- **Offer handoffs:** the agent may offer its work to another agent or computer.
- **Accept handoffs and apply work:** the agent may agree to receive work and have it applied.

Both are **Off** for agents and **Ask first** for the Dispatcher. Set either to **Ask first** or **Allow** per agent. A handoff between two agents also needs a connection between them, unless the receiver is a Dispatcher. Clubhouse never creates that connection itself.

A computer's Dispatcher can accept an offer for another agent there, or for a new helper:

- An existing agent must itself have **Accept handoffs and apply work** set to **Allow** for the sender. **Ask first** isn't enough here, because the Dispatcher can't answer another agent's question for it. The Dispatcher also needs a connection to that agent, with waking and messaging it allowed.
- A new helper gets your helper template's permissions and a normal connection to the Dispatcher.

An agent offered work directly accepts it through its own setting, **Ask first** or **Allow**.

To receive handoffs from other computers in your Annex Network, turn on **Accept handoffs from other computers** in Settings, Annex Network. Each computer checks its own permissions.

## The prepare-handoff skill

An agent that may offer handoffs gets the built-in **prepare-handoff** skill at its next start. It loses the skill once that permission is Off again. Ask the agent to hand the work off, and the skill walks it through:

1. Writing a brief: the goal, what's done, what's left, how to check it, and open questions.
2. Choosing a mode: **branch** sends an exact pushed branch, **worktree** sends a snapshot of tracked and untracked files.
3. Checking what would be sent, including any ignored files it really needs, such as test fixtures.
4. Resolving anything that looks like a secret by leaving the file out. Values are never copied into the brief.
5. Preparing the exact set of files, within your size limits.
6. Optionally checking which computer has room.
7. Making the offer, telling you its id, and following up.

Managed agents get the skill. A plain agent keeps its own skills folder, so it doesn't.

## What is checked

Files that look like they hold a secret block the handoff until they're left out. Only you can allow a specific file, under **Handoff secret exceptions** in that project's settings, and the receiving computer checks again with its own exceptions. Size limits are yours too: by default 1 GiB in total and 256 MiB per file.
