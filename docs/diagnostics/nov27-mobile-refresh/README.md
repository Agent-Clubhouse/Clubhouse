# Mobile Dispatcher refresh on November 27

The Mini recorded a mobile chat GET taking **15.433 seconds**. A later GET on the same route took **56 milliseconds**. Both ended in HTTP class 2xx. The host records identify the route template. They omit the selected agent and phone build, so neither request can yet be assigned to the reported screen refresh.

| Mini observation (UTC) | First window | Second window |
|---|---:|---:|
| Snapshot send logged | 14:33:03.394 | 14:45:03.234 |
| Snapshot bytes / icon bytes | 684,689 / 0 | 684,690 / 0 |
| Chat GET start | 14:33:32.043 | 14:45:10.717 |
| Chat GET end | 14:33:47.476 | 14:45:10.773 |
| Subsequent generic agent settings GET | 6.069 s | 6.543 s |

**There are two places to measure.** In the later window about 7.5 seconds elapsed between WebSocket upgrade and the start of the 56 ms chat read. In the earlier window a socket closed and upgraded again, and about 26 seconds elapsed between that upgrade and the chat GET. Capabilities, catalog discovery and 14 recorded per-project agent requests preceded chat in both windows. The Go owner traced a connection-state transition that waits for catalog discovery before visible chat can refresh. Host logs alone cannot time client-side work in the gaps. Settings arrived after chat started, and the settings badge is asynchronous in the inspected client.

**Inside the chat request**, the timer includes the awaited handler and may include response flush or socket close. It cannot separate wait for pending chat events, serialized transcript access, disk read, parsing, page construction or transfer. Closing the socket during the handler can leave work running. The available traces have no matching child-stage timers or phone delivery timestamp. The host reads the full selected session before building a bounded page, even for older-page requests. At inspection the visible Dispatcher session file was 4,730,101 bytes and its indexed last sequence was 12,205. The controller's separate session was 56,060,145 bytes. Neither file has been matched to these GETs. Reading a tail alone would lose older pending and queued state. [Host chat paths](host-path.md)

**Other host observations.** In the two one-minute metric windows ending around 14:33:38 and 14:34:38 UTC, event-loop delay p99 was 4.1 and 8.6 ms respectively. Two snapshot builds in the first window took 5–15 ms. Similar snapshot sizes and zero icon bytes preceded both GETs. Outbound Mini-to-satellite reconnect attempts are a separate connection. Current power assertions and retained sleep logs give no positive evidence of a sleep transition during either window. Request attribution to system load, socket backpressure, provider readiness or a queued turn remains open. Generic agent settings can await provider catalogs; Dispatcher settings follows a separate path. [Settings paths](settings-path.md)

**Version boundary.** The running Mini process reported 0.43.0-beta.8. The release tag resolves to 30fd3ab0fdca6dbe75aed0b91e4c9878eded9b71. The investigated upstream source was c041e7082ca4f72eaf65d4d83c6902b44182fd08. The ordinary full-session read predates beta.8 and remains in both inspected revisions. The running binary's exact source, installed phone build, user-selected host and a before-update timing comparison remain unverified. The two windows establish variability on one desktop version.

**Next discriminator.** For one delayed refresh, match the phone's selected host, build, local time/timezone and expected visible change to its request trace. Compare foreground or refresh, chat dispatch, first/last body bytes and first visible update with the Mini's request start/end. If a matched request spends seconds inside the host interval, the next useful instrumentation is stage duration and byte counts without transcript contents. Keep client catalog scheduling with the Go owner. No product or runtime change was made. Private original records and hashes stay on the Mini.
