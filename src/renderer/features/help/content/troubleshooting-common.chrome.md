# Common issues

Quick fixes for problems people run into most.

## An agent won't start

Check these in order:

1. **Is the orchestrator installed?** In **Settings > Orchestrators & agents**, each orchestrator shows whether its CLI was found. If it wasn't, follow the setup prompt.
2. **Is it turned on?** Check its switch on the same page.
3. **Is it signed in?** Most orchestrators need an API key or a login. See the orchestrator's own docs.

## An agent says Needs you

It's waiting for you to approve something. Click it under **Needs you** at the top of the sidebar, read the request in the pane, and approve or deny it.

To be asked less, use headless mode or Free Agent Mode for quick agents.

## A plugin doesn't appear

1. **On for the app?** Check **Settings > Plugins**.
2. **On for this project?** Open the project's settings, pick **Plugins**, and turn it on.
3. **Where to look.** A project plugin shows up as a tab in the title bar. If the tabs don't fit, look in the **More** menu at the end. An app plugin shows up beside Canvas and Review, in that row's **More** menu, or as an icon in the sidebar footer.
4. **Compatible?** Look for version errors from `plugins:loader` in the logs.
5. **External plugin?** **Enable external plugins** under **External** in **Settings > Plugins** has to be on.

## Git isn't detected

A banner appears when the project has no `.git` folder. Click **git init** in the banner, or dismiss it if you don't need Git. Without Git there are no worktrees or branch tracking.

## Clubhouse is slow

**Settings > About** shows your build. If it says x64 on an Apple Silicon Mac, it's running under Rosetta. Install the arm64 build instead.

## Updates aren't arriving

1. Look for an error in **Settings > Updates**.
2. Click **Check now**.
3. Check your connection, firewall and proxy.

## The terminal isn't responding

1. **Status says Error?** The agent crashed. Stop it and start it again.
2. **No output?** The process may be hung. Stop it from the row menu, then start it again.
3. **Can scroll but can't type?** Press `⇧⌘T` to focus the terminal again.
4. **Slow to draw?** A very long output buffer can do that. Restart the agent to clear it.

## Models are missing

Models come from the orchestrator. Update its CLI, check your API key, and look at its status in **Settings > Orchestrators & agents**.

## The command palette doesn't open

- Make sure the Clubhouse window is focused, not a popped-out window's native field.
- Look for a conflict in **Settings > Keyboard shortcuts**.
- Click an empty part of the window and press `⌘K` again.

## A project or agent seems to be missing

- **The sidebar is hidden.** Press `⌘B`.
- **The project is collapsed.** Click the arrow beside its name.
- **The project is idle.** Projects you haven't used for a while fold into one row at the bottom of the sidebar. Click it to see them.
- **The agent is sleeping or finished.** Sleeping agents fold into **N sleeping**, and finished quick agents into **N finished quick agents**, under the project.
- **You're on another host.** If the host row at the top says a satellite's name, switch back to **Local**.

## The config changes dialog keeps appearing

It means the agent's setup has drifted from the project defaults while Clubhouse mode is on. Choose **Keep for this agent** to keep its own setup, or **Save to Clubhouse** to make its changes the new defaults.

## Still stuck?

Report it at [github.com/Agent-Clubhouse/Clubhouse/issues](https://github.com/Agent-Clubhouse/Clubhouse/issues), with:

- the steps that cause it;
- the log, from **Settings > Logging** with the level set to Debug while you reproduce it;
- your Clubhouse version, from **Settings > About**.
