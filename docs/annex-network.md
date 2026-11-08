# Annex Network

Epic: #3056. Stages land in order: #3057 (peer basics), #3058 (reachability), #3060 (network channel), then #3061 onward.

## Model

- **A device** is anything paired with this machine, phone or computer, keyed by its identity fingerprint. `annex-peers.json` holds one entry per device with its pinned certificate and its role (it controls this machine, or this machine controls it).
- **The device list** (`src/main/services/annex-devices.ts`) is every paired device with where it stands: `connected`, `connecting`, `offline` or `needs-pairing`, and a problem when one is known. Settings is built from it. IPC: `annex:list-devices`, `annex:remove-device`, `annex:devices-changed`.
- **Reaching a satellite** (`src/main/services/annex-reach.ts`): each satellite entry remembers where it was reached (`knownHosts`, newest first, plus the hosts in its pairing link) and its port (`mainPort`), and can hold a host the person typed (`typedHost`), such as a tailnet name. Connections are direct: every address is the satellite itself, and the pinned certificate decides.
- **The network channel** (`src/main/services/annex-network-channel.ts`, protocol in `src/shared/annex-network-protocol.ts`): a WebSocket at `/network` on the main TLS port that carries membership only (`hello`, `members`, `member-joined`, `member-removed`, `member-renamed`). Anything else closes it with 4400.
- **A problem** (`src/shared/annex-problems.ts`) is a classified reason a connection failed, shown as two sentences: what happened, and what to do.

## Real-device checks

Synthetic tests can't cover certificates under Electron or local network discovery. Each stage merges on green CI; these need two computers and a phone before a release.

**Stage 1 (#3057)**
- Pair two desktops with the pairing link; each lists the other as connected in its Annex settings.
- Remove the controller on the satellite: the controller's row says "no longer paired" with Pair again, within a few seconds.
- Quit and reopen the controller with the satellite off: the satellite is listed as offline, "hasn't been found on the network yet". Turn the satellite on: it connects without pressing anything.
- Turn off Wi-Fi on the controller: the row says what happened and what to do, then reconnects when Wi-Fi is back.
- Pair a phone running an older Clubhouse Go that sends the desktop's name: the lock overlay says "Controlled by Phone".

**Stage 2 (#3058)**
- Quit the controller, then reopen it with discovery blocked (different subnets, or mDNS off): it reconnects to a paired satellite at its remembered address.
- Set a satellite's address to its tailnet name, then take the controller off the LAN onto the tailnet only: it connects by the tailnet name.
- Put "Also reachable at" on a Mac and pair a phone from its QR code: the phone can reach it over the tailnet.
- A network with IPv6 only between the two computers: discovery connects over IPv6.
- Switch Wi-Fi networks, sleep and wake, and turn a VPN on and off with Annex running: no "Uncaught exception" in the log, and the advertisement comes back.

**Stage 3 (#3060)**
- Pair two desktops: each lists the other as a member it hears from (`listNetworkMembers`).
- Remove the pairing on either: the channel closes at once on both.

## Decision log

Decisions made while building, for the maintainer to revisit. Newest last.

| # | Decision | Why | Revisit if |
|---|---|---|---|
| D180 | The device list is built on demand from what already exists: the peers file, the server's session-only phones, the client's satellite connections and the server's open sockets. Nothing new is stored. | One source of truth per fact, and nothing to migrate. Stage 4 adds network membership, which will need its own record. | Membership (#3061) needs devices this machine has never connected to. |
| D181 | A device that controls this machine is `connected` only while it has an open socket that is still paired; otherwise `offline`. Only devices this machine connects to can be `connecting`. | The server can't see a controller trying to reach it. | Stage 4 makes every connection two-way. |
| D182 | Problems are codes with fixed text. The raw error stays in logs and telemetry, which still map from the raw text as before. A satellite's `lastError` is the problem's two sentences on one line. | The same words wherever it's shown, and telemetry stays comparable across versions. | A surface needs the raw detail. |
| D183 | Until the single page (#3067), Annex shows the devices that control this machine, and Annex control shows the devices this machine controls. Older entries with no role are on both, so either page can remove them or pair again. Both read the one list. | Moves the data first without redesigning settings in this stage. | #3067 lands. |
| D184 | Remove device works the same either way: this machine's own connection to it is forgotten, its entry is removed, and any socket it has to this machine is cut, not left to finish closing. | Removal ends access at once whichever way it was paired. Uses the revoke path from #2986. | Stage 4 spreads removal to every member. |
| D185 | A device that pairs with this machine's own name (or none) is stored as "Phone" when it sends `pairingMode` or a phone or tablet icon, otherwise "Computer". Same-name checks ignore case and surrounding spaces, against this machine's alias and device name. Pairing again stores the new name. (#2442) | An older Clubhouse Go sent the desktop's own name, so the lock overlay read "Controlled by" this Mac. | Two computers that really share a name are common; then prefer a suffix such as the last fingerprint group. |
| D186 | A paired satellite this machine hasn't found since it started is listed as `offline` with "hasn't been found on the network yet". Retry starts looking for it, and it connects as soon as discovery finds it. With Connect to satellites off, every satellite says that instead. | It used to be missing from Settings until discovery found it. | Stage 2 remembers addresses (#3058). |
| D187 | While pairing, the same problems give advice for a one-off attempt ("try again"), never "Clubhouse is reconnecting". A certificate that changes between the check and the pairing says so. | Pairing never retries by itself. | |
| D188 | Order of addresses tried: what discovery announced in this run, then the typed host, then remembered and pairing-link hosts, newest first. A failed address hands over to the next after 250 ms, and an address announced during an attempt goes next at once. Once all have failed, the usual backoff (1 s doubling to 30 s, with jitter) applies, and it keeps retrying. One address showing another certificate moves on to the next; only when every address does is the satellite marked as needing pairing again. | Discovery's address is current on this network; a typed host is the person's word over anything remembered. | A typed host should win even on the LAN. |
| D189 | Paired satellites with a remembered or typed address are connected at startup, and on wake, without waiting for discovery. Discovery still adds new addresses. | A satellite on a tailnet, or a network without mDNS, is never announced. | |
| D190 | The server listens on `::` (IPv4 and IPv6 together), falling back to IPv4 where the system has no IPv6. Announced addresses are ranked: private IPv4, tailnet, other IPv4, unique-local IPv6, global IPv6; loopback and link-local are never used (mDNS gives no interface for link-local). mDNS itself is IPv4, so IPv6 reaches a satellite through a typed or remembered address, or an announcement that also lists IPv6. | IPv6 works where it's all there is, without breaking IPv4 networks that also announce link-local IPv6. | |
| D191 | A typed host is a name or an address, with an optional port; anything else (a URL, a path, an IPv6 zone, an incomplete IPv4 address) is refused with a message. A port is required while the satellite has never been reached. It's kept across pairing again, and the Address button stays available while a satellite needs pairing again, since a typo can be why. Connecting through it isn't saved as a found address, so clearing it forgets it, and its port never replaces the satellite's own. Saving it while Connect to satellites is off saves without connecting. | One field, no surprises. | |
| D192 | "Also reachable at" on this machine is added last to its pairing link and the phone's routes, but not when the server is bound to one address. | A phone or computer pairing over the LAN learns the tailnet name for later. The link's contract only adds hosts. | Older Clubhouse Go builds stumble on a host name in the list. |
| D193 | mDNS socket errors are logged at warn, at most once a minute per kind, and never thrown. A socket that can't start is replaced after 30 s; the advertisement is published again on wake. (#1921) | They reached `uncaughtException` after network changes. | |
| D194 | Waking the machine no longer starts discovery while Connect to satellites is off. | It used to rescan regardless of the setting. | |
| D195 | The membership channel is a separate WebSocket path (`/network`) on the main TLS port, in its own module that imports nothing that controls a machine. `/ws` is unchanged. | Membership can't reach control by construction, not just by a check. One port, so reachability (#3058) covers both. | |
| D196 | `/network` accepts a pinned peer of either role, where `/ws` accepts only a controller. Older pairings are refused with `needs_pairing` until paired again. | Membership isn't control, and every member will need to talk to every other (#3061). | |
| D197 | Every message is parsed against a closed schema: a known type, this version (`v: 1`), no extra fields, bounded sizes (64 KB a message, 64 members). Anything else closes the channel (4400; 4426 for another version) and is logged without its content. | "Membership only" holds whatever a peer sends. | A newer member needs a field older ones refuse: bump `v`. |
| D198 | The first message each way is `hello`, and it must name the identity and certificate the connection authenticated with. Each message is acted on only while the sender is still paired with that certificate, so a removal ends the channel at once. A channel silent for 10 s without a hello is closed. | A member can only speak for itself. | |
| D199 | In this stage the controller opens the channel to each satellite once its main connection opens, and both sides only record what they hear (`listNetworkMembers`). Stage 4 acts on it. | Ships the channel on its own, as the epic allows. | |

