# Antigravity CLI version policy and diagnostics

Issue #3800, epic #3785. Evidence read 2026-11-23 from the public changelog at https://antigravity.google/docs/changelog/ (CLI stream, newest entry v1.5.13, 2026-11-19). Each quote below is verbatim from that page. Nothing here was checked against a running `agy`.

Source files kept outside the repository (not committed, 1.5 MB changelog page): the fetched pages and their extracted text, with SHA-256 digests recorded with the report that introduced this file.

## What the changelog documents

The CLI changelog and the ACP extension changelog are separate streams on one page. Only the CLI stream applies to `agy`.

| Version | Date | Entry | Why Clubhouse cares |
|---|---|---|---|
| 1.5.0 | 2026-11-04 | "Added acp to agy --help : agy acp runs the CLI as an Agent Client Protocol (ACP) server over stdio, so editors can use it as their agent, with images and embedded file context in prompts, steering a running turn by sending another prompt, default , accept-edits , and plan session modes, session/resume restoring a session without replaying its history, each session keeping its own model and thinking level, and Google sign-in from a terminal with agy acp --login for editors connected over SSH or without a browser." | `agy acp` does not exist before this. |
| 1.5.1 | 2026-11-05 | "Fixed several agy acp session bugs: closing, reloading, or resuming a session while a prompt runs now ends that prompt as cancelled instead of leaving it hanging, cancelling a prompt no longer also stops the next prompt sent right after it, session/update notifications no longer arrive after the session/prompt reply for that prompt, and permission requests and question forms now close when they are answered elsewhere or their prompt ends, instead of blocking later prompts or receiving their answers." | Cancel, close and update ordering. The lifecycle suite (#3804) assumes a turn settles once. |
| 1.5.4 | 2026-11-10 | "Fixed agy acp turns hanging when a tool call needed a second permission approval, such as a command that asks again after its first approval; the editor now receives a new permission request instead of the turn waiting forever." | A turn that never settles. |
| 1.5.8 | 2026-11-13 | "Added context window usage updates to agy acp sessions, so editors such as JetBrains AI Chat can show how much of the model's context window the conversation is using; the value is sent when a session starts or is reloaded, after each model call, and after a model or thinking level change." | The `usage: 'context'` capability. |
| 1.5.10 | 2026-11-17 | "Fixed agy acp holding back what the agent did after a turn ended: when a background task or subagent finishes and wakes the agent, its replies, tool calls, and permission requests now reach the editor right away instead of at your next prompt, so the agent no longer waits on a permission request the editor never showed." | A permission request Clubhouse never shows is a hang. |
| 1.5.10 | 2026-11-17 | "Fixed agy acp leaving a session's subagents and background tasks, such as dev servers, running after the editor canceled a prompt or closed the session, where they could keep working and wake the conversation again; canceling or closing now stops them, and closing does so even when no prompt is running." | Stop must stop. |

Also relevant, not floors:

- 1.5.1: "Changed agy acp to offer every model available to your account to every ACP client, where previously only a fixed list of editors were offered models other than Gemini." The ACP guide still says third-party models are offered only to some editors. Both are shown in help.
- 1.5.9: "...prompts no longer fail when the ACP client passes an MCP server whose name contains spaces or other special characters..." The bridge name is `clubhouse`, so this does not apply.
- 1.5.13: "Fixed agy acp running the agent's shell commands in the directory the editor launched it from, such as your home directory, instead of the session's project folder." Clubhouse launches `agy acp` in the agent's folder, so it is not affected.

## The Windows ACP startup fix is not a CLI fact

#3800 lists "a Windows ACP startup fix" among the floor reasons. The only entry that matches, "Fixed the Windows ACP Server executable ( agy_acp_server.exe ) crashing at startup with a missing steps_pb2 module import.", is in a separate ACP extension release stream (v1.4.0, 2026-10-12) that ships `antigravity-acp`, not in any CLI 1.x entry. It gives no CLI version, so it is not used. Windows ACP startup stays a real-login gate (#3802, V12).

## Decisions made here

- ACP floor: **1.5.10** (`minVersion` for `antigravity_acp`). #3800 proposed 1.5.8. 1.5.8 has the last feature Clubhouse reads (context usage), but the 1.5.10 fixes are about a turn that waits on a request the client never sees and about stop not stopping, which break lifecycle guarantees rather than lose a display. One line to change if the maintainer prefers 1.5.8.
- Tested max: **unset.** `testedMax` means "newest version this driver was tested with", and nothing has run against a real `agy` yet. A newer version therefore gets no note, as for an unknown version. Set it when #3802 runs.
- Terminal floor: **none.** The policy has no terminal mechanism, and no changelog entry shows a terminal feature Clubhouse needs missing before some version. Related facts for when hooks land (#3795): 1.5.8 "Fixed hook commands on Windows that contain double quotes... failing and being silently skipped", which for a status hook means lost status, not a missed block, because Clubhouse's hooks always allow.
- `AGY_CLI_DISABLE_AUTO_UPDATE` is documented at https://antigravity.google/docs/cli/troubleshooting/. Clubhouse does not set it.
- `--disable-telemetry` is not passed. It is the person's Antigravity setting.

## Diagnostics (paths only, nothing sent)

Feedback diagnostics (`feedback-diagnostics.ts`) are an allowlist, and Framebriar's report contract is closed. It has `provider` and `driver` word attributes and no version or path attribute, and the SDK contract is not ours to extend. So:

- The provider (`antigravity-cli`) and driver (`antigravity_acp`) reach a report as the closed words they already are, once both are in the reviewed lists. Nothing else about Antigravity is added.
- The CLI version and the log paths are not sent. A path holds a user name, and a version has no attribute to travel in.
- The two log locations are shown to the person instead, so they can attach a file themselves: `~/.gemini/antigravity-cli/log/acp-*.log` (Antigravity's own, documented) and the Clubhouse `--log-file`. See the Antigravity help article.

If the maintainer wants the version in reports, that needs a new attribute in the Framebriar diagnostics contract first.
