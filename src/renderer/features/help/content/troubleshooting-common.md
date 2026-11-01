# Common Issues

Quick fixes for frequently encountered problems.

## Agent Won't Start

**Check these in order:**
1. **Orchestrator installed?** — **Settings > Orchestrators & Agents** — look for a green checkmark. Red = not found; follow the setup prompt.
2. **API keys configured?** — Most orchestrators need an API key (e.g., `ANTHROPIC_API_KEY` env var). See orchestrator docs.
3. **Orchestrator enabled?** — Ensure it's toggled on in **Settings > Orchestrators & Agents**.

## Agent Stuck (Orange Ring)

The orange ring means the agent is **waiting for permission approval**. Open the agent's CLI view, review the request, and click **Approve** or **Deny**.

To reduce interruptions: enable headless mode or Free Agent mode for quick agents.

## Plugin Not Appearing

1. **App-level enabled?** — **Settings > Plugins** — toggle on.
2. **Project-level enabled?** — **Project Settings > Plugins** — toggle on for this project.
3. **API version compatible?** Check the `core:plugins` diagnostic lines for version mismatch errors.
4. **External plugins enabled?** — **Allow external plugins** in **Settings > Plugins** must be on.

## Git Not Detected

Yellow banner = no `.git` directory found. Options:
- Click **git init** in the banner to initialize
- Dismiss if you don't need Git (worktrees and branch tracking won't be available)

## Slow Performance

**Check:** **Settings > About** — if it shows x64 on Apple Silicon, you're running under Rosetta.

**Fix:** Download and install the **arm64 (Apple Silicon)** build for significantly better performance.

## Updates Not Working

1. Check status in **Settings > Updates** for error messages
2. Click **Check now** to force a manual check
3. Verify internet connectivity and firewall/proxy settings

## CLI View Not Responding

1. **Red ring?** — Agent crashed. Stop and restart.
2. **No output?** — Process may be hung. Use **Kill/Stop**, then restart.
3. **Rendering slow?** — Large output buffer. Restart the agent to clear it.

## Missing Models

Models come from the orchestrator, not Clubhouse. If models are missing:
- Update your orchestrator CLI to the latest version
- Verify API keys are valid with the required permissions
- Check **Settings > Orchestrators & Agents** for status indicators

## Command Palette Not Opening

If `Cmd+K` doesn't work:
- Ensure focus is on the Clubhouse window (not a pop-out's native input)
- Check **Settings > Keyboard Shortcuts** for conflicts
- Try `Cmd+K` from a non-text-input area first

## Clubhouse Mode Dialog Keeps Appearing

The Config Changes dialog appears when an agent's config has drifted from project defaults. To stop it:
- Click **Keep for this agent** to lock the agent to its own config
- Or **Save to Clubhouse** to sync changes back to defaults

## Still Stuck?

Report issues at [github.com/Agent-Clubhouse/Clubhouse/issues](https://github.com/Agent-Clubhouse/Clubhouse/issues). Include:
- Steps to reproduce
- Log output: in **Settings > Logging**, set the level to Debug and reproduce the problem. Then share the newest `telemetry-*.jsonl` file after checking it. **Logging & Diagnostics** explains how to remove the diagnostic lines.
- Clubhouse version (**Settings > About**)
