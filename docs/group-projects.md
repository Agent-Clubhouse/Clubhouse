# Group Projects

## Creation scope

New records persist a validated `scope`: project or app, and local or network.
`create(name, options?)` accepts an optional registered `projectId` as the default
context and an optional explicit `scope`. Without either, the default is
app/local. A project context defaults to that project/local. An explicit scope
takes precedence, including app scope from inside a project; contradictory
project IDs and unregistered IDs are refused before creating a record.

Canvas creation forwards its project context (including an explicitly associated
project on an app canvas); an app canvas without one uses app/local. A project
canvas missing its context refuses creation rather than silently using app scope.
The MCP create tool derives the registered project from its caller's project
path and refuses an unregistered caller path.

Network creation is explicitly refused until the authoritative Annex host path
is available, even if Annex is enabled. No local group is presented as a network
group. `get_project_info` includes scope; legacy records without one return
`scope: null` unless membership-aware migration can verify the complete
membership inventory. Creation does not infer migration scope from an incomplete
startup binding cache or change existing members or subscriptions.

## Legacy scope inference

Initial registry loading inventories registered projects, durable agents, saved
connections, every app/project Canvas store, and live bindings/registrations.
It reuses the existing wire and connection eligibility rules without creating
memberships or changing subscriptions. A single known member project implies
project/local; mixed or verified empty membership implies app/local.

Strict read-only source readers refuse unknown or malformed rows, ambiguous
identities and corrupt/unreadable primary files rather than treating filtered
rows, caches or recovered backups as a complete inventory. Ordinary readers
retain their existing recovery behavior. Backup-only or recovery-only data is
untrusted; only verified absence of primary and recovery copies is empty.

Inference persists atomically before publication, retaining an internal
`_scopeInference: "legacy-v1"` provenance marker on every later registry write.
The marker is not part of the public Group Project object. On every fresh load,
marked scopes are untrusted until a complete inventory reproduces the recorded
candidate and passes drift checks. A different candidate is never silently
adopted. Unrelated edits retain the recorded candidate even while its public
scope is unresolved. Explicit scopes from new creation remain authoritative and are not
re-inferred.

Immutable inventory signatures are rechecked before and after persistence.
Detected drift restores the previous registry before publication; restoration
failure explicitly rejects loading. The retained provenance also protects a
restart after a crash between rename and verification. This is cooperative
validation, not a transaction spanning independent source files or protection
against external filesystem tampering.

Unavailable, unknown or changed inventory leaves scope unresolved
(`get_project_info` returns `scope: null`) with a logged retryable diagnostic.
Repairing the source permits another attempt on the next app startup. There is
no polling loop, automatic read retry or live membership expansion.

## Local persistence

The app-wide registry is `group-projects/registry.json`. Each group project has
`group-projects/<id>/bulletin.json`. These live under `.clubhouse` in the user's
home directory (`.clubhouse-dev` in development). Their existing JSON formats
retain existing data; new registry records add the optional scope field.

The registry and bulletin services serialize pending writes and use the same
atomic replacement helper as the settings store: write a neighboring temporary
file, flush its contents, then rename it over the previous file. Failed writes
leave the previous file readable and the in-memory changes available for retry.
An explicit `flush()` rejects on failure; deferred flush failures are logged.
Shutdown flushes drain mutations that arrived while an earlier write was pending.
The all-board flush awaits every board before reporting failures, so one failed
board does not bypass other pending board writes. The existing shutdown timeout
still applies.

Only a missing file initializes an empty store. An unreadable or corrupt store
refuses reads and mutations rather than overwriting history with an empty
fallback. Repairing the file permits a later load to retry.
Protection changes made before the first board read are applied after loading
the saved history, rather than replacing that history or ignoring the change.

Protected bulletin topics are exempt from both retention limits. The global
budget and trim preview count only unprotected messages. Posting retains the
just-posted message even if older history has timestamps ahead of the clock.

## File map

- `src/shared/group-project-types.ts`: registry and bulletin types.
- `src/main/services/group-project-registry.ts`: registry loading, CRUD and flush.
- `src/main/services/group-project-scope-migration.ts`: checked legacy inventory.
- `src/main/services/group-project-scope-migration.test.ts`: real-file inference,
  drift, crash-provenance and publication-barrier regressions.
- `src/main/services/group-project-bulletin.ts`: board loading, retention and flush.
- `src/main/services/settings-store.ts`: shared atomic replacement helper.
- `src/main/services/group-project-storage.test.ts`: real-file crash/failure,
  concurrent-load and in-flight mutation regressions.

Scope management, authoritative host identity and
sequence numbers, durable membership, directory management and network
synchronization are separate additions. These foundations do not change canvas
membership, grants or polling.
