Evidence for steps 8–9 ("A's unchanged authoritative Alias can replace the remotely assigned name on observers"), with a deterministic reproduction. This is related to a Windows E2E failure, but the hosted trigger is not proven.

**Deterministic reproduction (unit level, `annex-network-membership.test.ts` harness, main `daa7dab5e`)**

1. A sends its own `hello` with name `Studio`.
2. This machine runs `renameMember(A, 'Studio in the network')`. The alias becomes the new name, and `member-renamed` is broadcast.
3. A sends its own `hello` again, still `Studio`. The alias reverts to `Studio`. The same happens with A's own `members` view.

Cause in source (`src/main/services/annex-network-membership.ts`):
- `addMember` applies a member's own announced name unconditionally: `const name = own && member.name !== existing.alias ? member.name : existing.alias`.
- The `member-renamed` handler only updates an existing peer record, so a rename **of this machine** is ignored. The renamed computer keeps announcing its unchanged `settings.alias || deviceName` (`localMember`).
- A member's own `hello` and `members` record carry **no time**. D209's "newest rename wins" therefore cannot be ordered against a member's own name.

**Hosted E2E observations (Windows, `e2e/annex-v2/settings-page.spec.ts:39`, "two desktops join from the page, and one renames and removes the other")**

At line 95, after B saves "Studio in the network", B's row keeps A's hostname for 10 s. This happened on both attempts in two runs:

| Run | Head | Artifact `annex-traces-windows-2022-1` |
| --- | --- | --- |
| 44715575990 (#3746) | `f7be061e7`, before the #3733 composition | id 14620261562, `sha256:eb44827bfc6524c9092a1d0b8154c03bd1bc4685cd147f9027ed9c926b2a2f85` |
| 44880807605 (#3749) | `879064193` | id 14698591252, `sha256:63048a90b3d62cfb9023ef856183636988aa7193abb68d56224e81f2b8d9990d` |

**Trace limits.** Both traces are runner-only: action before/after records, stdout and the error. There are no DOM snapshots, console, network or IPC. They do show:
- The Save click completed.
- The asserted row is A's (only row, connected, member).
- The row text contains the **Rename** button. `AnnexDeviceList.tsx` renders it only when the name editor is closed, and the editor closes after `renameDevice` resolves true.

So a save that was accepted and then overwritten by a later device list is consistent with the evidence. **The specific late message, or a list remount, is not observed.** The unit reproduction shows the overwrite mechanism. It does not prove which message arrived on the runner.

**Compatibility constraint for any fix.** `parseNetworkMessage` refuses extra member fields (`MEMBER_KEYS` with `onlyKeys`) and unknown message types, and the channel closes on refusal. Adding a name timestamp to `hello`/`members`, or a new message type, would make current peers close the membership channel. Timestamp-based ordering therefore needs version or feature negotiation. A name-only guard (ignore an own record repeating the pre-rename name) was considered and rejected. It can veto a deliberate return to an old name, and it misses A→B→C with a late intermediate name.
