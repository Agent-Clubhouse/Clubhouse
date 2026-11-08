# Passive provider-reported skills

Agent Details → Reported skills displays a snapshot of names that Claude reported for the exact chat session. Opening the card does not start/wake a session, send a prompt, request metadata, scan files, import assets, or change provider settings.

## Source and coverage

The pinned `@anthropic-ai/claude-agent-sdk` 0.3.316 `SDKSystemMessage` defines `skills: string[]` on `system/init` (`sdk.d.ts`, around line 6266). The existing SDK stream drain and stream-json transport already receive this frame. `ClaudeNormalizer.mapSystem` retains its skill names; `ClaudeChatDriverSession.map` forwards root init metadata through the existing `session_info` event. No additional provider method is called. Normally this frame first arrives during an ordinary user-driven turn; an idle session can therefore remain unknown.

Names alone do not identify filesystem scope, path, origin, version, or whether a skill was used/executed. This display is separate from configured/imported Clubhouse skills and the command menu. Commands, tools, MCP connections and plugin lists are not converted into skill identities. Mid-session command-list changes do not refresh this snapshot; a later root init can replace it. The card shows the report timestamp and shared/native session IDs. After the session ends it is labelled a last-session snapshot, not current readiness.

This slice covers Claude Agent SDK and Claude stream-json root init frames only. Codex's generated `skills/list` types are not evidence that this driver already requests a list. Its passive `skills/changed` notification has no names, and we add no request. Copilot command availability mixes builtins and custom commands, so we infer no skills from it. Terminal sessions have no passive skill card. This is not all-provider native skill inventory.

## Data contract

`session_info.providerSkills` contains the tagged provider (`claude-code`), selected Claude driver, source (`system/init`), native session ID and names. `names: null` means absent, malformed or beyond display limits; `names: []` means an explicit valid empty report. Generic session metadata without `providerSkills` leaves the snapshot unchanged. Every root init supplies a new known/unknown snapshot. Invalid arrays are never filtered into an empty proof. Display metadata is limited to 512 names of at most 256 UTF-16 code units each; empty/whitespace-only/control-character names invalidate the list, and duplicate valid names collapse. Names render as text and are never resolved as paths or executed.

The renderer accepts a report only for an already started matching shared session, provider and driver, with a valid report timestamp and matching native ID in `session_info`. A report cannot establish/reactivate a shared session. Within the current shared session, a root init can authoritatively replace its native ID (for example, a resume fallback); its other metadata is retained and the old skill snapshot is replaced. This relies on the existing runtime's shared-session envelope and monotonic sequence, not an OS identity guarantee. Nested/subagent init is excluded and cannot replace the parent transport's native identity. New `session_started` events reset the snapshot; a native ID change without a new report invalidates it. Prior-shared-session and wrong-provider/driver reports are rejected. The card additionally checks agent, session, driver and native identity, and matches the agent's explicit provider override or the current known project's default (Claude when the known project has no override). Unresolved inherited selection stays unknown; changing a project default immediately hides a mismatched old report, without a new provider or filesystem read.

Transcript replay preserves the timestamp/provenance of a completed session and deduplicates overlapping events. A transcript with no matching start cannot acquire a skill snapshot from a bare metadata record. New sessions start unknown, including resumes, until their own report arrives. Nothing here asserts execution, live connectivity, current filesystem contents, or persistent readiness.

## Validation scope

Synthetic tests cover absent/malformed/explicit-empty/bounded metadata, wire normalization, both existing fake transports, root/subagent isolation, no additional transport sends, shared event serialization, reducer identity/replay/reset behavior, and read-only text rendering. No real provider binary, prompt, probe, server, scan, auth flow or local Playwright is used.
