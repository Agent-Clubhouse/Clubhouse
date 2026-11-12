# Handoffs

Handoffs are not enabled in this build. The internal foundation does not transfer files, apply work or wake a receiver.

A handoff is an explicit agreement to continue work on another computer. It is separate from `hand_off`, which gives an ordinary task to a local helper. Any agent with the required permission can offer work to an agent or to a computer's Dispatcher; being a Dispatcher or orchestrator is not otherwise required.

## Prepare handoff

The read-only **Prepare handoff** built-in skill is named `prepare-handoff`. [Read the prepare-handoff guide](https://github.com/Agent-Clubhouse/Clubhouse/blob/main/src/main/services/managed-agents/handoff-skill/SKILL.md).

Its delivery requires both an enabled handoff capability and the agent's `handoff.offer` permission. Without the live tools and app-provided safety preview, the guide stops rather than trying another way to copy files. Project-owned skills are not deleted to enforce a permission.

The guide prepares a brief with **Goal**, **Done**, **Remaining**, **Verification** and **Open questions**. It distinguishes committed, pushed branch work from local worktree changes. Required ignored or large files must be selected explicitly and included in a bounded preview, not silently discarded.

## Review before offering

Review the selected paths, deletions, executable modes, file count, total bytes and immutable manifest digest. Secrets, unsafe paths, symlinks, invalid bounds or hashes and incomplete checks block the operation. Agents cannot override a secret finding or paste its matched value into a brief. Only redacted paths and rule identifiers belong in a report.

The optional `probe_capacity` tool requires `device.read` and reports coarse bands, not private process information or paid provider probes. Unknown capacity is not proof of availability, and capacity is not receiver agreement.

## Follow the agreement

`offer_handoff` creates an offer; `get_handoff` reconciles its authoritative state. An offer is not acceptance, and acceptance is not successful transfer or apply. The addressed receiver must explicitly agree.

Sender cancellation takes effect only when the receiving authority durably acknowledges it before applying begins. A failed or indeterminate apply keeps its checkpoint and artifacts for recovery. It does not mean files were rolled back, and must not trigger an automatic retry or cleanup of someone else's work.
