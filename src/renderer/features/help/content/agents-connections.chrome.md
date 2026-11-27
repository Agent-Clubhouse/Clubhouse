# Connections

A connection links two agents so they can work together through Clubhouse. Each direction is set on its own, and says what the sending agent may do to the other one.

A line on a canvas is one way to make a connection. Connections also come from helpers and their orchestrator, from the Dispatcher, from agents that connect themselves, and from you on the Connections card. However it was made, the connection and its switches are the same.

## What each direction allows

Each direction has a switch for each thing the sender may do.

| Switch | Lets the sender | On for a new connection |
|--------|-----------------|-------------------------|
| **See status** | See whether the other agent is working, idle or asleep | Yes |
| **Read output** | Read what the other agent wrote | Yes |
| **Check it is reachable** | Check that the other agent can be reached | Yes |
| **Send messages** | Send it a message | Yes |
| **Send files** | Send it files | Yes |
| **Clear its context** | Clear its conversation | No |
| **Compact its context** | Compact its conversation | No |
| **Wake it** | Wake it while it's asleep, so a message can reach it | Yes |

The connections Clubhouse makes for you start the same way, so a helper can't clear or compact its orchestrator until you turn that on.

A switch never gives more than the sender's own Clubhouse permissions allow. An agent with **Send messages** on still needs its Clubhouse permission to message connected agents, and a permission set to **Ask first** still asks you.

**Wake it** is set on this computer. A connection saved before the switch existed has it off until you turn it on. Connections with the Dispatcher, and between a helper and its orchestrator, have no **Wake it** switch, because they wake each other with their own tools.

## Adding a connection

1. Open the agent's **Details** and expand **Connections**.
2. Click **Add connection** and choose a target. The picker lists agents on **This computer** by project, agents on **Other computers**, **Dispatchers** and **Group projects**. A target that's already connected shows **Connected**.
3. Choose **One way** or **Two way**, and set the switches for each direction.
4. Click **Add connection**. The new connection opens in its editor.

Choosing a group project makes the agent a member of it. See [Group projects](#help:group-projects).

On a canvas, drag from an agent's **Drag to connect** handle to another card.

## The Connections card

Each row is one connected agent. It says whether the connection goes both ways or one way, and whether the other agent is a helper, an orchestrator or the Dispatcher. Hover a row to see where the connection came from.

- **Edit** opens the connection's editor, with a column for each direction and the list of where it came from.
- **Open** goes to the other agent, or to the group project's workspace.

In the editor, a direction that isn't connected yet offers **Make two-way**. Each source of the connection has **Remove**, which says what removing it does. While another source remains, the agents stay connected. A line drawn on a canvas is removed on its canvas.

## Telling each side when to reach the other

At the bottom of the editor, **Guidance** holds instructions for one direction at a time. They tell the sender when and how to use its tools toward the other agent. Guidance changes what the tools say, not what they allow. Save each direction with **Save direction**, then restart the sender's session or reload its tools to pick up the change.

## On other computers

With Annex Network, an agent can connect to agents on your other computers. Those show on the card under **On other computers**.

While a computer is offline, messages and files to its agents wait and go in order when it's back. Other calls to it are refused until then.

See also [Canvas](#help:canvas), [Durable agents](#help:agents-durable), [Orchestrated helpers](#help:agents-orchestrated-helpers)
