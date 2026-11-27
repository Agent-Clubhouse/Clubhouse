# Coming from classic

If you used Clubhouse before 1.0, this page says where things went. Your projects and agents are still here.

## What moved

| Before | Now |
|--------|-----|
| The rail of projects and the agent column | The sidebar. See [Navigation and layout](#help:navigation). |
| **Free Agent Mode** | **Access** on each agent. Off became Ask first, and on became Auto or Full access, matching what you had. |
| Personas and Clubhouse Mode | Managed agents and their parts, in **Settings > Managed agents** |
| Orchestrator settings | **Settings > Agents & CLIs** |
| Annex and Annex control | One page, **Settings > Annex Network** |
| Blueprints | The builder and templates in **Settings > Managed agents** |

New pages in Settings include **Managed agents**, **Smart routing**, **Usage**, **Dispatcher** and **Actions**.

## Agents that used personas or Clubhouse Mode

They switched to managed at their next start and kept what they had. Each one's **General > Setup** says where Clubhouse kept its earlier files. Plain agents stayed plain. Switch one later with **Switch to managed** in its **General > Setup**, or several at once in **Settings > Managed agents > Switch agents**.

The Clubhouse MCP server now always runs, for every agent.

## What's gone

| Feature | What happened to its data |
|---------|---------------------------|
| Home view | Nothing was stored. The sidebar replaces it. |
| Hub, Lounge, KanBoss and Bug Report plugins | Removed, with their data. Files git tracks in a project, such as a committed board, stay. |
| Provider profiles | Each CLI uses the account it's signed in to on this computer. Your old profiles file is kept as it was, and past sessions stay in history. |
| Plugin API 0.5 and 0.6 | Plugins need API 0.7, 0.8 or 0.9. |
| Blueprints | Removed. A project's saved blueprints folder is deleted unless git tracks it. |

## Legacy project defaults

Agent defaults a project saved before managed agents are kept as they were, read-only, under **Legacy defaults** in the project's settings. Nothing is lost. A new agent gets them only when you tick **Copy this project's legacy defaults**, and managed agents never do. **Import as parts** turns them into library parts.

## The classic layout

**Classic layout** is in **Settings > Display & UI**, under **Layout**. It takes effect after a restart. The classic layout will go away in a future update.

See also [Navigation and layout](#help:navigation), [Durable agents](#help:agents-durable)
