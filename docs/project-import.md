# Bounded GitHub project import (#2808)

The Dispatcher exposes the existing bounded main-process importer through
`preview_repository_import`, `import_repository`, `get_repository_import` and
`cancel_repository_import`. The app's Needs you list reviews the exact main-owned
plan; Repository imports shows responsive progress, cancellation, real project
ids and recovery. `add_project` still only registers an existing local folder;
it is not a cloner. Import, agent creation and agent start are separate operations.

The initial supported input is exactly `https://github.com/owner/repository`,
optionally ending in `.git`, with an explicit absolute **new** destination and an
existing parent. No placement preference is guessed. SSH, enterprise hosts,
userinfo, tokens, escapes, query/fragment, traversal and option-like inputs are
refused without echoing their contents. An existing destination, including an
empty directory, is never repurposed. Matching registered projects are offered
for explicit open/reuse; existing checkouts can be inspected and separately
registered through `add_project`.

Preview obtains the actual advertised default branch, selected branch and tip
with authorized HTTPS Git metadata; it never assumes `main`. Empty repositories,
missing default branches and missing selected branches are explicit refusals.
Existing GitHub credential helpers are reused, not replaced. Restore missing or
expired access outside agent messages; never send passwords/tokens to an agent.

## Approval and separate outcomes

A preview id is not authority. Import must obtain genuine exact current human
approval of the immutable server plan, including repository, canonical path,
parent identity, default/selected branch and commit, and actual effects. A generic
Allow grant or model/repository text cannot substitute. Inputs, placement, access
and remote metadata are revalidated around approval and before exclusive target
creation. The public gateway always asks, including in Allow mode, through the
existing scoped one-time Needs you request. Only the real user-only IPC answer or
an authorized controlling device's `grant.answer` supplies that answer. A legacy
key-only approval cannot approve an import. No permission setting is changed.
The main-only scope binds the complete immutable plan, caller registration and
nonce, access, policy, target and approval revision; a changed caller, grant,
parent, tip, branch, plan or destination requires renewed review. The ledger is
never an approval source, and model text/tokens are not accepted as authority.

## Public workflow

1. The user names an HTTPS GitHub repository and exact new absolute destination
   with an existing parent. `preview_repository_import` checks authorized access,
   actual branches/tips and placement and reports `ready`, an existing project
   for explicit open/reuse, or an existing owned import receipt. It creates no
   checkout, project or agent.
2. `import_repository` takes only that caller's `planId` and exact canonical
   `destination`. Its first call places the full immutable review in Needs you:
   repository, parent/path/identity, advertised default branch and tip, selected
   branch and commit, expiry and effects. Allow is one use, not a lasting grant.
   The Dispatcher repeats the exact call only after the genuine answer.
3. Start returns immediately with an owned receipt. `get_repository_import`
   reports phase/numeric progress; `cancel_repository_import` additionally
   requires its exact destination. User-only typed IPC exposes the same receipts
   and exact cancellation to Repository imports. Cancellation never deletes.
4. A real registered project id enables a separate `create_managed_agent` with
   the owned `importId`. Needs you shows the effective template/setup, CLI/model,
   effort, access/Free Agent Mode, orchestration and connection choices. Decline
   to choose differently with the Dispatcher. Import approval never creates an
   agent. The builder leaves it asleep, and only a separately requested wake
   under the existing wake/message grants starts it. Repository setup is not run.
   The panel exposes receipt/project ids for recovery after lost conversation
   context; an omitted builder `importId` reports that caller's owned lifecycle
   id, not authority. The exact creation still needs its own human review.

Import downloads a shallow single-branch checkout into its exclusively created
directory, then calls the same `registerProjectFolder` path as the app and
`add_project`. Registration adds Clubhouse ignore rules. Its real project id is
preserved when a later step fails, including `.gitignore` updates. Clone,
registration, managed-agent creation and agent start are separate outcomes.
Import never creates/connects an agent or changes its authority.

After registration, a requested durable agent uses `list_agent_templates` and
`create_managed_agent` with `importId` and the user's effective
CLI/model/access/template choices, including Free Agent Mode and orchestration.
The gateway reuses the managed builder and bootstrap; it does not add a creation
engine. Template/settings changes invalidate the exact creation review. Access
and template grants remain capped to the caller; a connection requires its
existing separate `connection.bootstrap` authorization. A template cannot
implicitly connect it. It remains asleep until a separately authorized
`wake_agent`; without a connection there is no promise of Dispatcher reach.
The existing builder's Git operations retain the importer's native Git pin and
inert configuration for this composition, so creating a worktree does not admit
repository hooks/filters, injected PATH executables, setup or runtime delivery.

## Process and content safety

Git is spawned without shell interpolation, with bounded output and timeouts.
Before checkout, the runner pins a native Git executable resolved from existing
absolute PATH directories. Relative/empty/missing PATH entries are excluded and
the canonical helper search path is frozen, so downloaded programs cannot become
Git or credential-helper executables through cwd-relative PATH lookup.
Script shims are skipped rather than treating an absolute shell wrapper as a
native Git pin.
Only existing system/global GitHub credential-helper configuration is carried
into an isolated Git environment, in environment variables rather than argv.
Each operation exclusively creates a temporary empty regular configuration file;
it never passes a platform null-device pathname to Git as a config file.
Its identity, type, link count and empty bytes are rechecked before Git starts.
The same regular file disables hooks by being a non-directory hooks path.
It remains alive through the tracked child's close callback, including spawn errors.
Owned temporary state is removed on success, failure and cancellation; unexpected
replacement/content is preserved with a sanitized warning, never recursively deleted.
Inherited transport rewrites, Git environment injection, hooks, templates,
fsmonitor, filters, attributes configuration and submodule recursion are not
inherited. Redirects and non-HTTPS transports are disabled. The checkout uses
inert regular-file representations for symlinks. Repository hooks, filters,
setup and submodules are not run. Repository-provided `.clubhouse` runtime state
is refused before checkout/registration, rather than importing agents/settings
from untrusted content. This is safe subprocess configuration, **not a sandbox**.

The app-created regular Git configuration is bounded, strictly validated and
byte-sealed. Unknown keys/includes/filters, changed origin, Git indirection, or
replacement control directories stop the import. Ownership/configuration is checked again after
credential and authority awaits, immediately before each owned Git subprocess.
Checkout creates the selected local branch at the reviewed commit without
automatically modifying upstream-tracking configuration. Immediately before
registration, fresh remote metadata and actual local origin, HEAD, branch/ref,
directory identity and ignore-file safety are rechecked. Final parent checks
and exclusive directory creation have no intervening asynchronous await.
These guards do not isolate the filesystem from other OS processes.

Known Git control files, including both selected-branch reflogs, must remain
singly linked regular files. Their identity/version may change only for the
specific files the current owned Git operation writes; symlinks, hardlinks and
unexpected replacements stop before the next subprocess. Optional Git locks are
disabled, so a status inspection cannot silently refresh/adopt a changed index.

A clean Git status is bound to a whole-working-tree byte/metadata fingerprint
(excluding `.git`), checked again after the last authority await and at the real
registration ignore-write boundary. Cancellation is rechecked after authority
awaits. Ignored content changes and newly appeared runtime-state aliases are not
silently accepted. Inspection never follows symlinks or runs filters. Each walk
allows at most 20,000 entries, 64 MiB of file contents and depth 128, with a
250 ms elapsed budget checked between filesystem operations. A single filesystem
call is not time-isolated. Over-bound checkouts remain preserved partial imports
for inspection and explicit local registration; these are registration-inspection
bounds, not a clone disk quota.

Import passes a main-private guard through the existing `registerProjectFolder`
path. After the actual registry await, its guarded ignore writer uses bounded
no-follow file descriptors and exclusive creation, without an await between the
last safety check and write. Existing and resulting ignore files are capped at
1 MiB. Ordinary no-options registration retains its existing behavior and line
format. A refused write after registry commit reports a partial outcome with the
real project id; no registration or user content is rolled back or deleted.

Git/credential-helper stderr is never returned, persisted or logged. Progress
contains only phase and numeric percentage. Cancellation signals only the
tracked import child process, never a process name or unrelated process group.
It preserves every file already created and any completed project registration.

## Recovery and bounds

The private app-owned `project-imports.json` ledger retains immutable plans and
operation receipts. It is lifecycle history, **not settings** (classified in
`settings-audit-inventory.test.ts`), not an audit or permission source. Schema
corruption fails closed without replacing the file. The exact persisted UTF-8
pretty-JSON encoding, including newline/escaping, is capped at 128 KiB, with up to
32 plans and 32 receipts. Unused previews expire after ten minutes; receipts are
not silently evicted. A full history refuses new imports. Only one import runs
at a time; metadata output is capped at 1 MiB, remote checks at 30 seconds and
each Git operation at ten minutes. Shallow download bounds history, not the
repository's total byte size; there is no disk quota or repository-size promise.
Ledger reads require a singly linked regular file, compare path and open-file
identity/version before and after the bounded read, and check the observed path
again before committing. Existing and dangling symlinks are refused even where
`O_NOFOLLOW` is unavailable. An ENOENT result is empty history only after at most
128 closest-ancestor probes reach an existing directory; encountered files,
links, permission failures, unknown roots and over-bound paths are refused.

Each commit keeps its exclusively created temporary file descriptor open through
rename. BigInt identity/type/link-count checks bind the path to that descriptor,
and bounded readback verifies the exact encoded bytes. The known post-write
version is sealed across sync and checked again after destination inspection,
immediately before rename; the initial empty-file version is not reused after
the app's own write. A changed temporary file stops before replacing the ledger.
Failure cleanup removes only still-matching owned state; unexpected replacements
and moved originals are preserved with a sanitized warning. Descriptor-close
failure explicitly reports whether the ledger was already committed.
These cooperative checks do not claim atomic confinement against other OS processes.

Repeated starts of one plan return its existing receipt, not another checkout or
project. After cancellation, failure or app interruption, no download is silently
restarted. A complete checkout can be inspected and explicitly registered at the
same path with `add_project`. A registered project is reused by its id. Incomplete
downloads stay at their recorded destination for inspection; choose another new
destination only explicitly. No recovery path resets, overwrites or deletes
pre-existing or user-modified content.

Each import can link one agent-creation outcome in the same bounded ledger.
Before the existing builder runs it reserves an operation key/request id; a
completed call returns the existing agent, including after app restart, without
replaying creation or restoring a removed connection. Changed choices, a removed
agent or an interrupted/failed reservation are explicit refusals with inspection
and reuse choices, never blind retries. Omitting `importId` cannot bypass this
workflow for an imported project. Additional agents remain explicit app
operations. Imported-agent failure/interruption preserves its record, partial
worktree/branch and user-modified content; ordinary builder recovery is unchanged.
Agent creation/connection failures do not erase project registration or undo
user-owned connection changes. The import receipt's `agentCreated: false` and
`agentStarted: false` describe the import itself; `agentCreation` reports the
separate builder outcome, and `wake_agent`/`get_status` report actual runtime
start outcomes. Lifecycle receipts do not grant authority.

App-owned project registration retains import membership before checkout effects,
including partial destinations later registered through Add project. Positively
registered ordinary projects do not read import history during agent creation;
an unreadable import ledger cannot disable their existing builder. Ambiguous
legacy registration still requires readable history, and registered import
membership never falls back to ordinary creation on a ledger error.

The imported builder uses the protected native Git adapter for its actual
repository probe; a false/error result cannot bootstrap a commit or succeed as
a plain folder. Canonical parent checks and exclusive worktree-folder creation
have no asynchronous gap. Current exact consent, template/settings and permissions
are checked after setup/settings/grant preparation and at commit boundaries.
Invalidation preserves partial state without completing creation or publishing
template permissions beyond the caller's revoked reach.

A completed imported agent retains its operation association independently of
the separate import ledger link. If that final link save fails, public results
and status retain the actual agent id and distinguish completed creation from
receipt-save failure. Once committed history is readable/writable, retry after
restart reconciles that association without another builder run, connection
restoration or wake.

The same live import approval continues through separate connection bootstrap:
queued direction writes, their atomic replacement, policy preparation/commit,
and final connection inspection all recheck the original caller and consent.
Invalidation reports a partial connection outcome without undoing already
committed or user-owned switches. No agent is started.

Agent-record backups also recheck owned record storage immediately before their
temporary write and rename. A replaced `.clubhouse` stops remaining backup effects.
A blocked backup reports the already-committed main record honestly, without
rolling it back in memory, overwriting outside files or unsafe cleanup.

Fixtures use isolated local Git repositories and mocked authentication/approval
boundaries, without private credentials, login probes or paid agent calls.
Git serializes fixture configuration with exact value readbacks, including
Windows backslashes. Runtime-name fixtures use real Git objects/refs without
requiring host worktree spelling, checking exact trees/payloads and trunk/tips.
Native macOS results and modeled Windows path/config controls do not establish
native Windows success.
Public composition tests call the actual startup-registered MCP catalog,
Needs you/user-only answer seam and controlling-device answer seam, real bounded
Git checkout/registration, managed template/builder and persistent retry link.
The renderer tests review/progress/cancel/choice surfaces. Access/provider
availability and the wake runtime boundary are deterministic stubs: no live
private credentials, provider/model execution, local Electron/browser/E2E or
paid prompts are evidence for this workflow.
The entry-limit fixture uses stream-mocked directory enumeration over one owned
real file: the real walker counts 20,000 entries and reads/hashes their bytes,
then rejects entry 20,001 before file opens. Separate real-filesystem fixtures
retain byte, metadata, symlink, depth and elapsed-budget checks.
PATH fixtures also calibrate a controlled pre-launch observer at `spawn` and
`execFileSync`, including `--version` probes. An import must make no untrusted
admissions even if a rejected probe could fall back successfully. On Windows,
this is an admission observation, not a claim that POSIX script bytes named
`git.exe` are natively launchable.
