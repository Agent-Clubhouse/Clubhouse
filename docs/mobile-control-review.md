# Mobile control v1 adversarial review

Reviewed the additive increment in PR #2430, including authorization, duplicate commands, replay, stale runtime identity, approval settlement, and cancellation. All findings below are fixed by the follow-up commit containing this report.

| Finding | Fix and regression coverage |
| --- | --- |
| Revocation during asynchronous command prerequisites could still dispatch an operation. | Recheck peer role, certificate pin, and server epoch after awaits, immediately before dispatch. A delayed project lookup followed by session self-revocation must reject without spawning. Chat prerequisites also check the captured runtime is still registered. |
| A transcript approval can remain visible while its response is already in flight. | Validate the exact option against the runtime's unsettled permission map as well as the transcript. Tests cover pending, in-flight, and settled responses. Only one-time options remain permitted. |
| An agent exit can purge interior replay events without making the retained buffer empty. | Require a complete contiguous mobile replay range; otherwise emit replay:gap. Legacy replay is unchanged. |
| A stop racing a quick-agent startup could miss the eventual process. | Track both quick and durable starts with cancellation records until they finish. Explicit stop and Annex shutdown mark pending starts canceled. A late process is stopped and the receipt is failed/start_cancelled because effects may already have occurred. |
| Revoking peer trust did not close its bearer-authenticated WebSockets. | Track peer-issued token IDs during revocation and close both certificate and bearer connections. Replacing a pinned certificate also disconnects the prior sessions. |
| Disposed durable agent metadata could still be used for commands. | Reject disposed targets before dispatch; test that start does not invoke the agent launcher. |

The follow-up adds advertised DELETE /api/v1/mobile/pairing for the caller's session-only pairing. It requires pinned client mTLS, cannot target another identity, and refuses persistent or shadowed persistent trust without mutation. Tests exercise session revocation and persistent refusal. See mobile-control-v1.md for exact wire fields.

## Validation

- 19 test files, 590 tests passed: Annex server/client, identity/TLS/peers/settings, replay and permissions, mobile commands, chat runtime, IPC, telemetry contracts, and renderer stores.
- TypeScript typecheck passed. Changed TypeScript files passed ESLint with warnings only.
- TLS integration tests use temporary certificates, mocked in-memory peers, and loopback listeners. They do not provision persistent user access or operate the user's running application.

## Boundaries for clients and integration

- Transport disconnect does not cancel an accepted command. Retry the same command ID within the advertised receipt window; use explicit interrupt/stop to cancel. Revocation prevents subsequent dispatch boundaries but cannot undo an operation already dispatched.
- Mobile pairing grants the existing full Annex controller role. Certificate pinning applies across legacy routes, which retain their existing controller powers. This increment does not implement a restricted mobile role.
- Receipts are in memory for one hour. Expiry or an epoch change requires state reconciliation instead of blind retry. Capacity rejects new IDs rather than discarding valid receipts.
- Local credential removal while offline cannot revoke desktop trust. Session trust lasts until explicit desktop disconnect or Annex stop unless the client successfully calls self-revoke.
- The chat response is paginated, but pending-interaction reconstruction currently reads the session transcript. No gateway, attachment upload, merge, release, or GUI execution is part of this review.
