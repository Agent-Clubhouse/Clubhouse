# Copilot SDK chat driver: design note

Status: plan, not started · Date: 2026-10-17 · Context: [docs/structured-chat-research.md](structured-chat-research.md) §7 and §8 (Phase 5)

Copilot chat runs today on the ACP driver (`copilot_acp`, `src/main/orchestrators/adapters/acp-chat-driver.ts`). The research plans a later move to the GA Copilot SDK. The ACP driver stays: it becomes Copilot's fallback mode and remains the generic driver (`acp`) for every other ACP agent. This note sets out what that move involves, so it can be scheduled when the features below become product requirements.

## Why move

- **Status.** `@github/copilot-sdk` has been GA since 2026-06-02. It's MIT-licensed, follows semver, and is what VS Code's Agent Host uses. Copilot's ACP server is still labelled public preview.
- **Features ACP v1 can't carry.** The SDK speaks SDK protocol v3 to `copilot --server` and adds:
  - `send({ mode: 'immediate' | 'enqueue' })`: steering and native queueing.
  - Exit-plan-mode approval: plan approval.
  - Elicitation: structured questions.
  - Subagent events.
  - Credit usage.
  - `setModel(model, { reasoningEffort })`.
  - Resume without replaying history.

  Over ACP these degrade: the composer offers "Stop and send" instead of Steer, plan approval falls back to text, and there are no question cards.

## Running the user's own CLI

The Node SDK bundles a Copilot CLI by default. Clubhouse must not ship or run that copy; this is the same rule as for the Claude Agent SDK. Instead:

- Connect with `RuntimeConnection.forStdio({ path: <user's copilot>, args, env })`. The SDK always adds `--no-auto-update`, which makes the Homebrew/WinGet shim run its bundled runtime instead of the installed Copilot (#2154). The ACP driver dropped that flag for this reason; the SDK driver needs a workaround (for example `--prefer-version <installed version>`, which selects the installed package even with auto-update off) before it can be the default.
- **Version skew is the main risk.** SDK 1.0.N is tested against CLI 1.0.N, and the user's CLI changes almost daily. The driver checks the SDK protocol version when it connects. On a mismatch it falls back to `copilot_acp`, following the §7.1 rule: fall back only on real failures. A newer CLI that still connects gets an "untested version" notice instead.

## Shape of the code

- **New driver.** A `copilot_sdk` `ChatDriver` (the id is already in `ChatDriverId`) in `src/main/chat/copilot/`, mirroring `src/main/chat/claude/`:
  - a transport that wraps `CopilotClient` / `CopilotSession`;
  - a normalizer from the roughly 150 SDK event types to `ChatEventDraft`.
- **Reused from the ACP driver.** Permission option kinds, the level mapping (`plan` / `ask` / `full_access`, plus whatever modes the SDK adds) and the `session_info` choices:
  - models from the SDK's model list, with billing information as `costHint`;
  - efforts per model.
- **Capabilities:** steer true, queue native, planApproval true, questions true, subagents full, usage cost (credits), resume native.
- **Registration.** `registerCopilotChatDrivers` registers `copilot_sdk` ahead of `copilot_acp`, so Copilot's fallback order becomes SDK → ACP → terminal.

## Before writing it: packaging spike

This is the same risk class as the Claude Agent SDK and OTel spikes:

- Load `@github/copilot-sdk` (ESM, Node `^20.19 || >=22.12`) in the webpack main bundle of a packaged build on macOS, Windows and Linux.
- Exclude the bundled CLI and its per-platform binaries.
- Confirm a handshake that needs no credentials, for the nightly smoke test (research §8, decision 4).

## Testing

- Record SDK fixtures with the recorder from #1945 under a new protocol, `copilot-sdk`, which the fake CLI must learn to speak.
- Replay them through the driver in unit tests, as for the other three protocols.
- CI never sends a prompt.

## Size and timing

About 1.5 to 2 weeks plus the spike. Worth doing when steering, plan approval or questions become product requirements for Copilot. Until then, the ACP driver covers Copilot chat.
