# Canvas

A canvas is a board for laying out agents and the things they work with, and for seeing how they're connected. A line between two cards is a connection. See [Connections](#help:agents-connections).

Open **Canvas** in the sidebar for canvases across your projects, or the **Canvas** tab of a project for that project's canvases. The Canvas plugin needs to be on for the project. Press `⌘K` and type `#` to jump to one.

## Adding to a canvas

Right-click an empty spot and choose from **Add to canvas**.

| Item | What it is |
|------|------------|
| **Agent** | One of your agents, with its status. Open it from the card. |
| **Browser** | A web page agents can be given access to |
| **File viewer** | A file from a project |
| **Git diff** | An agent's or a project's changes |
| **Group project** | A group project's board |
| **Sticky note** | A note for yourself |
| **Terminal** | A terminal in a project folder |
| **Anchor** and **Zone** | A fixed point, and an area that groups cards |

The pickers list projects in the same order as the sidebar.

## Connecting on a canvas

Drag from an agent's **Drag to connect** handle to another card. You can connect an agent to another agent, a browser, a group project or a zone. By default, a line you draw between two agents connects them both ways. The Canvas plugin's settings can turn that off.

Click a line to see and change it.

- **Both directions** turns the other direction on or off.
- **Tool permissions** sets what each direction may do. For two agents this opens the same editor as the **Connections** card.
- **Set instructions** tells the sender when to reach the other side.
- **Disconnect** removes the line.

A connection can also come from somewhere else, such as an orchestrator and its helpers. Removing the line on the canvas leaves those, and the Connections card shows what's still there.

## Group project boards

A group project's card on a canvas and its workspace show the same board. **Open group project** on the card opens the workspace on its **Board**, and **Back to Canvas** returns you. Connecting an agent to a group project card makes the agent a member. See [Group projects](#help:group-projects).

An agent on another computer can be in a group project whose board its host left out. Its **Canvases** card then offers **Preview board (read-only)**.

See also [Connections](#help:agents-connections), [Group projects](#help:group-projects)
