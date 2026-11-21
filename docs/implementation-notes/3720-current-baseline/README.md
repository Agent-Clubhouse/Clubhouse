# Current-main naming baseline

Base: `c43ffb37d20650c542e449a8a04a9fd84e65b655`.
Test-only source: `80ea1b628` (full execution SHA in raw receipt).
This branch intentionally retains three red diagnostic assertions. It is evidence,
not a PR candidate or a green implementation claim.

The original root Vitest configuration/global setup and runtime boundary were used,
one worker, no file parallelism and disabled compile/Vitest cache. All 1,176
nonoptional dependency versions matched the existing cache; load 2.39 on 16 CPUs
before admission. No install, shared cache writes, app/host probe or live socket.

One full membership-file run: **3 failed, 91 passed, 94 total**. Raw stdout/stderr,
JUnit, actual HEAD and before/after input hashes are retained.

Observed defects:

1. Local rename to `Studio in the network` succeeds, then the target's unchanged
   preference `Studio` in an own hello replaces it. Pin, role, pairing and route
   assertions pass before the failing label assertion.
2. The same occurs in an own members view.
3. A newer incoming `Laptop` event equal to the existing label is ignored, leaving
   no ordering floor. An older `Older laptop` event then wins incorrectly.

The existing 90 tests and one new legacy name/route positive control pass. These
are mocked membership/store/channel unit controls, not authenticated transport,
disk durability, mixed-version, real app or full-duplex evidence. The red legacy
name-retention assertions diagnose the actual loss; they do not authorize a
blanket legacy hello veto. The approved modern negotiated overlay must carry the
new ordered semantics while preserving old-peer connections and legacy learning.

The same-label timestamp floor has a narrow independent existing-message fix:
accept a newer event's ordering stamp even when no peer label needs mutation.
That needs its own isolated source/test candidate and independent review. The
overwrite cases remain dependent on the negotiated name store/intent/projection
integration, not that small legacy correction alone.

## Store checkpoint and dependency classification

Retained complete-body review freeze: `a2c6b9ab5846692510b211c1493f40cfb5dc6ac3`;
proof `63c76cdb89f92feb58433e856987c472545c9267`; delivery branch
`annex-wake-readiness/3720-committed-store-review` at `75b1292b6`.
The original review request was not delivered while the parent slept. On resume,
published QA head `70d1a31a9` contains the r3/helper reports but no complete-body
store verdict. B1/L1/C1–C3 are resolved at r3 contract level, not executed consumer
proof. Lane now reports no concrete store/next-transport overlap, explicitly
without store/race approval.

`current-main-bindings.json` proves twelve relevant source/config paths are byte
identical from landed foundation f19 through current c43. This permits exact review
binding; it does not turn previous mirror checks into current runtime proof.

Concrete naming dependencies are: its own durable name/order state and accepted
intent witness; serialized local Alias commits with authority/emergency fences;
explicit no-IO label projections/currentness; bilateral strict-v1-preserving
negotiation; and the executed security/mixed-version/restart matrix. The immutable
Q5 notice index and unwired agent runtime coordinator landed since f19 do not
change these paths. Q5 journal/physical backend/adoption/provider runtime work is
not a blanket naming prerequisite. Integrating any shared primitive later still
requires its actual contract and owner review.

Future SAVE/MCP/disable/purge work must preserve P7w cloned SAVE/serialized runtime
ordering, abortControllerReads before disable notifications and separately
coordinate client start/stop/control presence. Neither utility merges nor this
baseline establish those consumer or readiness controls.
