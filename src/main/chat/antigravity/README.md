# Antigravity ACP chat driver

Native chat for Antigravity CLI over `agy acp` (#3797). It runs the
provider-neutral ACP driver (`../acp`) with Antigravity's launch spec. It
isn't registered here; the provider integration registers it once the gates
in `../acp/README.md` close. Driver id `antigravity_acp`, `optIn` until the
real-login checks (#3802) pass.

Sources, read 2026-11-23: https://antigravity.google/docs/ide/extensions/acp/,
https://antigravity.google/docs/cli/acp/ and https://antigravity.google/docs/cli/reference/.

| File | What it does |
|---|---|
| `launch.ts` | `agy acp` arguments, the level policy, the claims and the sign-in hint |
| `driver.ts` | `createAntigravityAcpDriver`: the neutral driver plus the Clubhouse MCP bridge with an explicit environment |
| `mcp.ts` | The seam to the provider's MCP module (bridge builder, server planner) |
| `index.ts` | `antigravityAcpDriver()`, wired to the real MCP module |
| `GATE-effort.md` | Registration gate 3, the approved effort-only design |

## Launch

`agy acp --log-file <Clubhouse log dir>/antigravity-acp-<time>-<id>.log`, run
in the agent's worktree. Full access adds `--dangerously-skip-permissions`,
so changing to or from it needs a restart. These flags are not used:
`--sandbox` (no execution-policy mapping for this provider, which is refused
upstream), `--add-dir` (no start option carries extra folders yet), and
`--process-per-session` (no HTTP MCP servers are passed).

## Claims (documented behaviour ACP can't advertise)

- `questions`: "clients that support ACP elicitation forms show a native form".
- `steer`: "Sending a prompt while a turn runs steers that turn instead of
  starting a new one". How each `session/prompt` is answered isn't
  documented. The neutral driver ends the turn on the last answer, which is
  an assumption until #3802 V13. The conformance test runs the #3804 suite
  under three answer orders (both end together, the first ends as the steer
  joins, the steer is refused).

Everything else comes from the session: models and thinking levels exactly as
its config options offer them, images and embedded resources per
`promptCapabilities`, slash commands, context usage once `usage_update`
arrives, and resume (`session/resume`, else `session/load`). `login` stays
`terminal`, `systemPrompt` false (instructions go through `AGENTS.md`), and
`subagents` `none`.

## Levels

Plan → `plan`, Ask first → `default`, Auto-accept edits → `accept-edits`,
each only when the session offers that mode id (the ACP pages don't document
the ids). Auto has no mode: Clubhouse can't check the sandbox, version and
account conditions it needs, so a start at Auto is refused. Full access is
the launch flag. `liveLevels` never includes it.

## Clubhouse MCP

The bridge goes in `session/new`, `session/load` and `session/resume` as a
stdio server named `clubhouse`. Its agent id, nonce and port are in the ACP
`env` field, because whether agy passes its own environment on to stdio MCP
children isn't documented (V3). The entry travels only over the ACP pipe.
The start is refused when the bridge isn't ready, or when a project server
or the person's global Antigravity MCP config defines `clubhouse` (chat-spawn
checks this). The agent has the Clubhouse MCP only once the bridge has
authenticated with this launch's nonce, within `BRIDGE_FENCE_DEADLINE_MS`
(30s, unmeasured: if agy starts stdio servers only on first use, every start
is refused, and V3 settles that). Otherwise the start is refused before any
message is sent. For chat, the workspace `.agents/mcp_config.json` gets no
bridge entry, so the session sees one `clubhouse` server.

## Sign-in

`Authentication required` (-32000) during setup fails the start with
"Run `agy` in a terminal to sign in, or `agy acp --login` over SSH."
Clubhouse never calls `authenticate` and never sets `GEMINI_API_KEY`.

## A failed start

No terminal opens by itself (`chatFailsExplicitly`, chat-spawn returns
`'failed'`). The agent shows the reason with **Retry chat** and **Open in
terminal**. Neither sends anything: the unsent first message is the agent's
chat draft, kept in the composer until the person sends it. **Copy
message** copies it on request. Open in terminal saves the agent's runtime
as terminal, as the Chat / CLI switch does, and starts it with no first
message. A start that failed after its session started may have delivered
the first message, so that message isn't put back.

After a prompt was accepted, a turn settles as failed only when agy reports
a failure. A lost connection leaves it unknown. Nothing is retried.

## Stop

The composer's Stop (Esc) interrupts the turn (`session/cancel`) and keeps
the session. The agent's Stop (row menu, toolbar, Annex) closes the session
and ends the process. That is the only way out for an agent that has stopped
reading its input but keeps running (`../acp/stdio-liveness.test.ts`).

## What the tests prove

`driver.test.ts` and `antigravity.conformance.test.ts` run against the
in-memory scripted ACP agent, built from the ACP schema and not from agy.
They prove the launch spec, the MCP seam, the claims and the lifecycle under
each steer answer order. The Windows `.exe` case stubs the platform, so it
proves spawn resolution, not a native run (V12). Real agy behaviour is
#3802.
