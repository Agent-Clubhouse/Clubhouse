# Annex attachment registration

The mobile image-upload handler verifies durable registration independently of
the mutable agent-config cache (#3715). A cold cache or a benign watcher eviction
does not unregister a running agent.

Before reading an upload body, the handler acquires a read-only registration
lease using the primary `agents.json` file. The file must contain healthy,
uniquely identified records, and the target must match the registration's
`createdAt` and not be
disposed. Neither a backup nor a cached record can replace this verification.
The read does not initialize, repair, migrate, warm, or persist agent settings.

Staging keeps its synchronous `beforeWrite` checks. Every check reads and
validates the current primary bytes through a read-only descriptor, verifies
the read's file/path coherence and the project/storage directory identities,
then closes the descriptor. Matching timestamps alone are not authority.
Benign edits and atomic rewrites remain usable when registration is unchanged.
Local removal or disposal revokes the lease before its deferred disk flush;
restoring the record cannot revive a revoked lease. Every completed or refused
request releases the change listener; no descriptor waits for the upload body.

Missing, disposed, changed-epoch, unreadable or corrupt registration fails
closed with `agent_not_found`, without restoring a backup. The existing
principal, project-generation/pending, exact-runtime, image-capability, reverse-request
liveness, Dispatcher, and quick-agent checks remain in place. Lost authority
during staging discards the image before publication. No phone fields, grants,
pairing rules, or reverse-control protocol change.
