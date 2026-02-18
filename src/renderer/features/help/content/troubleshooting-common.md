# Common Issues

This page covers frequently encountered problems in Clubhouse and how to resolve them. For each issue, the symptoms are described first, followed by the likely cause and the steps to fix it.

## Agent Won't Start

**Symptoms:** You click to start or resume an agent, but nothing happens, or the agent immediately enters an error state.

**Possible causes and fixes:**

1. **Orchestrator not installed.** Open **Settings > Orchestrators** and check the status indicator for the orchestrator your project is configured to use. If the indicator is red, the orchestrator CLI binary was not found on your system. Install the required CLI tool and restart Clubhouse, or click the setup prompt in the orchestrator settings.
2. **API keys not configured.** Most orchestrators require an API key to communicate with the AI model provider. Verify that your API key is set up correctly according to the orchestrator's documentation. Some orchestrators use environment variables (e.g., `ANTHROPIC_API_KEY`), while others use configuration files.
3. **Orchestrator disabled.** Ensure the orchestrator is enabled in **Settings > Orchestrators**. If it is disabled, agents using that orchestrator cannot start.

## Agent Stuck on Permission

**Symptoms:** An agent appears to be running but is not making progress. The agent's status ring shows an orange indicator.

**Fix:** The orange ring means the agent is waiting for you to **approve or deny a permission request**. Open the agent's terminal view to see the pending request. The agent cannot proceed until you respond. Common permission requests include file writes, shell command execution, and access to sensitive directories.

If you want agents to run with fewer interruptions, check whether the orchestrator supports an auto-approve mode for certain low-risk operations.

## Plugin Not Appearing

**Symptoms:** A plugin you expect to see is missing from the Explorer Rail or the Project Rail.

**Possible causes and fixes:**

1. **Plugin not enabled at app level.** Open **Settings > Plugins** and verify the plugin is enabled globally.
2. **Plugin not enabled at project level.** Even if a plugin is enabled globally, project-scoped plugins must also be enabled for the specific project. Open the project's settings and check the plugin list.
3. **Incompatible API version.** If the plugin was built for an older version of the Clubhouse plugin API, it may fail to load. Check **Settings > Logging** for error messages from the `plugins:loader` namespace. The plugin author may need to update the plugin for compatibility.

## Git Not Detected

**Symptoms:** A yellow warning banner appears at the top of the project view stating that Git is not detected.

**Fix:** This means the project folder does not contain a `.git` directory. You have two options:

1. **Initialize Git.** Click the **"git init"** button in the yellow banner. Clubhouse will run `git init` in the project folder and enable full Git integration.
2. **Dismiss the banner.** If you intentionally work without Git, dismiss the warning. Note that some features -- such as Git worktrees for durable agents, branch tracking, and file status indicators -- will not be available.

## Slow Performance

**Symptoms:** The application feels sluggish, animations stutter, or terminal output renders slowly.

**Possible cause:** You may be running the **x64 (Intel) build** of Clubhouse on an Apple Silicon Mac via Rosetta 2 translation. This significantly degrades performance.

**How to check:** Open the **About** page (accessible from the application menu or the Project Rail). The About page displays your system architecture. If it shows that you are running x64 on an arm64 system, you are using the wrong build.

**Fix:** Download the **arm64 (Apple Silicon) build** of Clubhouse from the official download page and install it. The native arm64 build provides substantially better performance on Apple Silicon hardware.

## Updates Not Working

**Symptoms:** Clubhouse does not update automatically, or the update process appears stuck.

**Possible causes and fixes:**

1. **Check update status.** Open **Settings > Updates**. The settings page displays the current update state, including any error messages. Common errors include network timeouts and failed signature verification.
2. **Manual check.** Click the **"Check now"** button to force an immediate update check.
3. **Internet connectivity.** Ensure your machine has a working internet connection. Clubhouse downloads updates from a remote server and cannot proceed without network access.
4. **Firewall or proxy.** If you are behind a corporate firewall or proxy, update downloads may be blocked. Check with your network administrator.

## Terminal Not Responding

**Symptoms:** The terminal view for an agent is frozen or not displaying new output.

**Possible causes and fixes:**

1. **Agent in error state.** Check the agent's status indicator. If the ring is red, the agent has crashed. Try stopping and restarting the agent.
2. **Hung process.** The agent's underlying orchestrator process may be stuck. Use the **Kill** or **Stop** button to terminate the agent, then restart it.
3. **Large output buffer.** If the agent has produced an extremely large volume of terminal output, the renderer may struggle. Stopping and restarting the agent clears the buffer.

## Missing Models

**Symptoms:** The model picker shows fewer models than expected, or no models at all.

**Possible causes and fixes:**

1. **Models come from the orchestrator.** The model list is provided by the orchestrator CLI, not by Clubhouse itself. If models are missing, the issue is on the orchestrator side.
2. **Outdated orchestrator CLI.** Newer models may require a newer version of the orchestrator CLI. Update the CLI to the latest version.
3. **Invalid or expired API keys.** Some models are gated behind specific API key tiers or account permissions. Verify that your API key is valid and that your account has access to the models you expect.
4. **Orchestrator not responding.** If the orchestrator binary is not running correctly, it may fail to report its model list. Check **Settings > Orchestrators** for status indicators.
