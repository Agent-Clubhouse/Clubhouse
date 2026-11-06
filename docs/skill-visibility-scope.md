# Skill visibility and editing

The agent Skills page lists files from the selected agent's existing worktree
provider folder. The agent's provider override controls list/read/write/delete,
not the project's default provider. Project-scoped legacy callers retain their
existing conventions. Explicit agent requests reject a mismatched current
worktree; mutations use the existing agent transition reservation.

Rows show the worktree source path. Files found here are not proof that a provider
loaded or executed a skill. This page is not a catalog inventory or a scan of
home, ancestor, plugin or arbitrary additional directories. Opening it does not
import, assign, adopt, start an agent or execute scripts. Target switches discard
prior-target results.

The existing editor changes SKILL.md only. Supporting files are preserved but
cannot yet be edited in this editor; deleting a skill remains a separate explicit
whole-folder action. A fixture regression covers effective-provider listing and
editing, preservation of another provider's file, and supporting script bytes and
mode. It uses no real provider or user project.

Whole catalog bundles already use SkillAssetPayload.files, including relative
paths, UTF-8/base64 encoding and executable metadata. The independent catalog
bundle editor work reuses that model and catalog revision/impact checks. It does
not require native sources to be imported merely to become visible.

Broader native filesystem visibility remains blocked by the shared confined
reader boundary tracked in #2830. The existing worktree listing is not presented
as an atomic filesystem sandbox. Separately, provider-reported session metadata
can show what a provider reported for that session, with missing reports distinct
from explicit empty reports; it is neither a filesystem inventory nor execution
verification. Neither path should wake an agent to populate a list.

Related: #2819, #2820, #2740. No new agent grants or #2855 expansion.
