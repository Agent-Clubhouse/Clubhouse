# Bounded GitHub project import (#2808)

This stage adds an internal main-process import engine and opt-in registration
safety guards only. It registers no MCP tools, UI entry point or Dispatcher
skill, and is **not user-accessible**. Gateway registration and genuine human
approval integration require separate review. Any later import handler must
remain fail-closed with `approval_boundary_unavailable` until that boundary is
approved. `add_project` still only registers an existing local folder; it is not
a cloner.

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
creation. This engine-only stage exposes no effect handler and does not adopt
approval activation. A later gateway must remain explicitly fail-closed until
the separately reviewed original-scope human-approval boundary is integrated.

Import downloads a shallow single-branch checkout into its exclusively created
directory, then calls the same `registerProjectFolder` path as the app and
`add_project`. Registration adds Clubhouse ignore rules. Its real project id is
preserved when a later step fails, including `.gitignore` updates. Clone,
registration, managed-agent creation and agent start are separate outcomes.
Import never creates/connects an agent or changes its authority.

After registration, a requested durable agent uses `list_agent_templates` and
`create_managed_agent` with the user's effective provider/model/access/template
choices, including Free Agent Mode and orchestration. It remains asleep until a
separately authorized `wake_agent`.

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
`O_NOFOLLOW` is unavailable. These cooperative checks do not claim atomic
confinement against other OS processes.

Repeated starts of one plan return its existing receipt, not another checkout or
project. After cancellation, failure or app interruption, no download is silently
restarted. A complete checkout can be inspected and explicitly registered at the
same path with `add_project`. A registered project is reused by its id. Incomplete
downloads stay at their recorded destination for inspection; choose another new
destination only explicitly. No recovery path resets, overwrites or deletes
pre-existing or user-modified content.

Fixtures use isolated local Git repositories and mocked authentication/approval
boundaries, without private credentials, login probes or paid agent calls.
The entry-limit fixture uses stream-mocked directory enumeration over one owned
real file: the real walker counts 20,000 entries and reads/hashes their bytes,
then rejects entry 20,001 before file opens. Separate real-filesystem fixtures
retain byte, metadata, symlink, depth and elapsed-budget checks.
