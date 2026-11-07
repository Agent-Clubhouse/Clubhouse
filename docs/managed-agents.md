# Clubhouse-managed agents

Epic: #2819. Sub-issues: #2893 (New agent), #2894 (parts library), #2895 (builder), #2896 (delivery), #2897 (shared edits), #2898 (templates), #2899 (helpers), #2900 (MCP tools), #2901 (retirement), #2902 (built-in content).

## Model

- **Agent parts** are asset catalog entries of kind `block`, `skill` or `mcp` (`src/main/services/asset-catalog`). Built-in parts are installed by Clubhouse at startup and are read-only. Custom parts are the person's.
- **A managed agent** has `managed: ManagedAgentSetup` on its durable config: the ordered block ids, skill ids, MCP ids, and the template it came from. Its settings (CLI, model, Free Agent Mode, orchestration) are the ordinary agent settings.
- **By reference.** A setup holds ids, so an edit to a part reaches every agent using it when that agent's next session starts.
- **Fork** makes a new custom part with the same content and records `forkedFrom`. Forking from an agent switches that agent to the copy. "Back to shared" switches it back.
- **Templates** are unlinked starting points. Built-in templates live in code (`managed-agents/builtins.ts`). Custom templates live in `<app data>/managed-agents/state.json` with part descriptions and fork origins.

## Delivery

`spawnAgentInner` (`agent-system.ts`) calls `deliverForSpawn` for a managed agent before the start, for both runtimes and every CLI:

- **Instructions:** the blocks are joined in order with a blank line between them, wildcards are filled, and the result is written with `provider.writeInstructions`. Clubhouse adds nothing else.
- **Skills:** each skill folder is written whole into `<worktree>/<configDir>/<skillsDir>/<skillName>`. A manifest file lists the folders Clubhouse wrote, so a later start removes only those.
- **MCP:** JSON-format CLIs get their servers written to the worktree MCP file, and the Clubhouse bridge is injected into it afterwards. All CLIs get the same servers through `resolveProjectMcpServers` / `resolveAgentMcpServers`: launch flags in the terminal, SDK options in chat.
- Managed agents never take the Clubhouse Mode materialize path, and get no persona layer in orchestration policy.

The service remembers each running session's delivered fingerprint. `statusFor` compares it with the current setup to drive the "Setup changed" bar. `restartManagedAgent` stops the agent and resumes its last session, or starts a new conversation when asked or when the CLI changed.

## Decision log

Decisions made while building, for the maintainer to revisit. Newest last.

| # | Decision | Why | Revisit if |
|---|---|---|---|
| D1 | Built on main, not on the frozen v0 (#2884). v0 pieces are ported where useful. | #2884 waits on a guided review, and most of its UI is replaced by this design. | #2884 lands first: rebase, keep this model. |
| D2 | A setup lives on the agent config (`agents.json`). Parts live in the catalog. Templates, descriptions and fork origins live in `managed-agents/state.json`. | Agent config already persists, watches and broadcasts changes. The catalog's block payload has no room for a description. | Parts need to travel with a project. |
| D3 | Built-in templates are code, not catalog assets. | They hold references only. The catalog's template kind carries the linked-template machinery we dropped. | Templates need revisions. |
| D4 | A fork is a new `user` asset plus `forkedFrom` in managed state. It is not the catalog's `copy` source. | The catalog's `copyAsset` makes the copy agent-owned. Parts here are app-wide. | |
| D5 | The built-in Clubhouse MCP part decides the bridge. Saving a setup sets `mcpOverride` to whether it's listed. | It's the one switch the launch code already reads. | |
| D6 | Unmanaged "Clubhouse features off" is `clubhouseFeatures: false`, which also sets `mcpOverride: false`. The UI PR also skips hooks. | Off means a plain CLI. | |
| D7 | Restart resumes. Instruction, skill and MCP files are rewritten before every start, including resume. Whether a resumed CLI session re-reads its instructions file is unverified per CLI. Chat resume sends no system prompt. | The agreed behavior is that Restart resumes the conversation. | A CLI doesn't re-read on resume: show "Restart with a new conversation" more prominently for that CLI. |
| D8 | Built-in role blocks start from today's persona files, without front matter. | #2902 will rewrite them. The ids stay stable. | |
| D9 | "Changes waiting" is computed against an in-memory record of what each running session got. | An app restart re-delivers anyway. | |
| D10 | Conditional wildcards (`@@If`) are still processed until #2901 removes them. | Built-in text from personas still uses them. | |
| D11 | Catalog writes from the Dispatcher are refused today. #2900 widens this for the Dispatcher only. | The catalog guard refuses agent surfaces. | |
| D12 | The managed UI ships behind a preview-only experimental flag (`managedAgents`) while it lands, and graduates when the epic's acceptance passes. | Half a feature shouldn't reach stable builds. | |
| D13 | Setup changes write no settings-audit row yet. | The audit inventory is pinned by a test, so this is a follow-up. | |
