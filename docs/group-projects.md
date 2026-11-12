# Group Projects

## Local persistence

The app-wide registry is `group-projects/registry.json`. Each group project has
`group-projects/<id>/bulletin.json`. These live under `.clubhouse` in the user's
home directory (`.clubhouse-dev` in development). Their existing JSON formats
remain unchanged.

The registry and bulletin services serialize pending writes and use the same
atomic replacement helper as the settings store: write a neighboring temporary
file, flush its contents, then rename it over the previous file. Failed writes
leave the previous file readable and the in-memory changes available for retry.
An explicit `flush()` rejects on failure; deferred flush failures are logged.
Shutdown flushes drain mutations that arrived while an earlier write was pending.

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
- `src/main/services/group-project-bulletin.ts`: board loading, retention and flush.
- `src/main/services/settings-store.ts`: shared atomic replacement helper.
- `src/main/services/group-project-storage.test.ts`: real-file crash/failure,
  concurrent-load and in-flight mutation regressions.

Scope, authoritative host identity and sequence numbers, durable membership,
directory management and network synchronization are separate additions. This
storage foundation does not change canvas membership, grants or polling.
