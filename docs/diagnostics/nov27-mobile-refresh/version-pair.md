# Reconnect and selected Dispatcher history across desktop releases

The Mini is running **0.43.0-beta.8**. The process executable and installed bundle version were rechecked on November 27 Pacific time. The process started November 26 at 18:22:15 UTC. GitHub published beta.8 at 18:16:36 UTC that day and its adjacent predecessor beta.7 on November 17 at 21:23:57 UTC. The release pins are 30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71 and dc8e82236eb2ae8dadb6bd309297d0c157caaba4 respectively. Local upstream source was checked against remote main at c041e7082ca4f72eaf65d4d83c6902b44182fd08. Source checkout did not update the app. Bundle metadata does not attest the binary's Git tree. Beta.7's performance on the user's phone remains unknown.

The incident capture established Go build 2.0.0+2026112601 at f242adfcaec697834417eb6c1183ed32007534a7. The newer comparison source is #646 at a0ad2b83f11805cbc38a5f35883c136a96bfd008. The dead-connection candidate at 1e8f194e6f4bd3a554bd853e0cb35aea2c8cb598 is a separate extension. The user's current installed build is unverified. #646 was open with failing checks at inspection.

## Where the host can change selected-chat behavior

| Controlled observation | Beta.7 | Beta.8 | What it explains |
|---|---|---|---|
| Stable, live selected chat | 200, selected reply | 200, selected reply | Both handler versions reach page construction on the stable control. |
| Run identity replaced while the transcript await is held | 200 with old reply | 409, no page constructed | A real user-visible release difference if a run changes in flight. The fence prevents stale content. |
| Permission created then withdrawn | One permission event, zero refresh requests from the tested listeners | One permission event, two refresh requests | Beta.8 can add snapshot work when permissions change. Actual frame count depends on coalescing and sockets. |
| Long synthetic selected session, latest or older page | Full 8,386,678-byte file per read | Same | An existing repeated expense on each refetch. Warm file read/parse medians in these cases were 13–20 ms across both versions. They do not establish a 10–30 s storage stall. |

The handler trial executes each release's actual route function with an already-admitted simulated phone, held transcript promise and instrumented page constructor. This isolates the run-change decision. The trial does not execute a TLS connection, phone transport, real runtime or renderer. The separate storage trial executes the actual selected-session reader, Dispatcher filtering and page builder across 48 measured reads. Its forced warm index, fixed release order, simple messages and page limit of 50 (route default 2,000) matter. The results exclude an in-flight emit backlog, a contended storage queue, a cold repair and actual network backpressure. [Storage measurements](pair-replay.md) · [Host release delta](release-delta.md)

The retained Mini records show connect-triggered snapshots around the chat windows. The recorded refresh at 14:47:47 UTC follows the phone history cancellation. The capture establishes an attempted history read that cancelled after about 9.65 seconds and connection context shared with the Mini. No matching host HTTP completion, stage timing, selected Dispatcher name or phone paint was established. No permission change or run replacement has been linked to that read. A healthy host read can still sit behind client catalog work, an obsolete connection or a second request without yielding usable chat.

## Version-bound inputs for the client comparison

Run from the desktop repository root with both release commits available locally:

```sh
python3 docs/diagnostics/nov27-mobile-refresh/host-fixture.py beta7 > /tmp/nov27-host-fixture-beta7.json
python3 docs/diagnostics/nov27-mobile-refresh/host-fixture.py beta8 > /tmp/nov27-host-fixture-beta8.json
node docs/diagnostics/nov27-mobile-refresh/handler-race.cjs
node docs/diagnostics/nov27-mobile-refresh/permission-refresh.cjs
```

The JSON carries the desktop commit and SHA-256 of every consumed desktop recording. Each case supplies a connect snapshot, capabilities, network, projects, 14 per-project agent responses, agent state, selected Dispatcher history and seven sequenced chat frames. The role, history and visible reply come from release fixtures. The generator composes them into one synthetic exchange, expanding the two-project catalog with 12 empty projects and aligning the snapshot baseline to the first event. The selection is a sleeping Dispatcher with retained readable history. “On it.” is the expected visible reply. Snapshot data, successful history read, and that reply becoming available in the selected client store are separate checkpoints.

| Export | SHA-256 |
|---|---|
| Beta.7 | 6d7846bfb9f8ecb447febe2024c8159ca0bb8b2baa4d0697e2e52f1747048052 |
| Beta.8 | 8b78c7c732f7b82e507920203a850058eeecc148067205f6158af3bb95fb140e |

The Go owner runs the old/new client stores with these releases. Both exports passed host-side shape and content checks. Device installation, actual network recovery, UI rendering and today's phone experience require separate evidence.

## Host changes ranked by evidence

1. **Localize a matched slow request first.** For a future sampled chat read, distinguish request admission, runtime event wait, storage queue, file read/parse, page construction, response flush and request close. Record durations/byte counts and existing trace context only. A host completion with no phone arrival or a stalled client request before headers left the phone points to a different change.
2. **Reduce repeated transcript acquisition if that stage dominates.** The 48 measured reads establish repeat I/O on both releases. A bounded selected-session cache or contiguous tail refresh must preserve pending permissions/questions, older queued messages, raw sequence cursors, Dispatcher visibility and final role/session/epoch/currentness checks. Keep replacement, rollback and cold repair on an authoritative fallback. Verify same-session repeated reads and cancelled/changed-generation cases before adoption.
3. **Reduce redundant refreshes only if the client timeline implicates them.** Preserve prompt withdrawal, grant revocation and snapshot consistency. The listener experiment measures two refresh requests; it supplies neither wire-frame counts nor a reason to suppress a permission transition. Keep the 409 stale-run fence. A current-generation replacement read belongs with the Go owner if a matched 409 blocks the selected conversation.

The diagnostic branch changes no application behavior. No live fix is accepted from these results.
