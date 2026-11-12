# Bounded GitHub project import (#2808)

The Dispatcher's `preview_github_import`, `import_github_repository`,
`get_github_import` and `cancel_github_import` use one main-process import service.
`add_project` still only registers an existing local folder; it is not a cloner.

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
Remote metadata access and preview persistence require `project.add` on the exact
canonical destination, not just local project-read permission. Ask first requests
a metadata-only human decision before network access; Allow permits preview only.
Policy is checked again after remote access and before saving/exposing the plan.

## Approval and separate outcomes

A preview id is not authority. Import must obtain genuine exact current human
approval of the immutable server plan, including repository, canonical path,
parent identity, default/selected branch and commit, and actual effects. A generic
Allow grant or model/repository text cannot substitute. Inputs, placement, access
and remote metadata are revalidated around approval and before exclusive target
creation. The effect handler uses the existing reviewed `askFirst` original-scope
consumption API even under Allow, and requires the actual one-shot request id and
original immutable scope. Its main-private freshness assertion rechecks canonical
targets, caller session/provider/access and current grants after awaits and before
owned stages/registration. No proof is persisted, exposed as a token or forwarded.

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
Only existing system/global GitHub credential-helper configuration is carried
into an isolated Git environment, in environment variables rather than argv.
Inherited transport rewrites, Git environment injection, hooks, templates,
fsmonitor, filters, attributes configuration and submodule recursion are not
inherited. Redirects and non-HTTPS transports are disabled. The checkout uses
inert regular-file representations for symlinks. Repository hooks, filters,
setup and submodules are not run. Repository-provided `.clubhouse` runtime state
is refused before checkout/registration, rather than importing agents/settings
from untrusted content. This is safe subprocess configuration, **not a sandbox**.

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

Repeated starts of one plan return its existing receipt, not another checkout or
project. After cancellation, failure or app interruption, no download is silently
restarted. A complete checkout can be inspected and explicitly registered at the
same path with `add_project`. A registered project is reused by its id. Incomplete
downloads stay at their recorded destination for inspection; choose another new
destination only explicitly. No recovery path resets, overwrites or deletes
pre-existing or user-modified content.

Cancellation names the receipt's exact destination as well as its id, so current
destination-scoped permission still applies. Stopping one's own already-approved
tracked process does not ask for a second human decision; Off still refuses the
tool. Expired previews cannot use a later approval; obsolete Needs you rows can
be declined rather than treated as authorization for a replacement plan.

Fixtures use isolated local Git repositories and mocked authentication/approval
boundaries, without private credentials, login probes or paid agent calls.
