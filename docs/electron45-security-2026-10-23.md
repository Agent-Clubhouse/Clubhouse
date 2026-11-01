# Electron 45 and residual tooling security follow-up

Checked 2026-10-23. Extends local commit `9bcdef0ecbd6e2d3aded0a77b00fb30f3f58fe64`.
The original main baseline is `8e0903616ee45bff75c04f9bb62dc35feafce7f2`.
This is a reviewable local change, not a release clearance or a hosted CI result.

## Stable security pickup — 2026-10-28

The exact manifest and lockfile pin now selects **Electron 45.1.0**, replacing
45.0.0, on main baseline `6df7cb86e`. No other dependency versions changed.
The [Electron release notes](https://github.com/electron/electron/releases/tag/v45.1.0)
and [release manifest](https://releases.electronjs.org/release/v45.1.0) identify
**Node 24.22.1** and **Chromium 156.0.8078.49**, picking up the
[October Node security release](https://nodejs.org/en/blog/release/v24.22.1).
Electron uses Chromium's Brotli: the
[Chromium dependency pin](https://github.com/chromium/chromium/blob/156.0.8078.49/third_party/brotli/README.chromium)
is `cfa184a997ac19454d5a3ae97f6d600aac2445a6`, containing upstream fix
`0ed4268a4401abcb4472096340477cf4af7d1a2b`. The reported Brotli version remains
1.2.0; that string alone does not identify the backport.

Local macOS ARM64 validation (host Node 24.22.1 / npm 11.19.1):

- Clean dependency installation, typecheck, coverage ratchet (29/29), and lint
  passed; lint reports 0 errors and 3,048 warnings.
- Full suite: **816 files / 18,653 tests passed**, 4 files / 37 tests skipped.
- `npm run package` passed, including all six hardened fuse assertions.
- **96 development-Electron E2E tests passed** across startup, blank-screen
  prevention, popouts, command palette, find/replace, and native terminal
  input, resize, restart and cleanup.
- Executed development runtime reports **45.1.0 / Node 24.22.1 /
  Chromium 156.0.8078.49 / Undici 7.30.1 / Brotli 1.2.0 / modules ABI 150**.
  Benign Brotli round-trip, Node global fetch and Chromium net.fetch decoding,
  DNS NUL-input rejection, and the compiled preload bridge passed.

**Packaged application acceptance remains incomplete.** The initial local
package failed macOS signature verification and was killed at the modified fuse
page. Existing 45.0.0 crash evidence shows the same failure mechanism, so this
is not established as a 45.1.0 regression. A disposable copy signed through
Electron's signer passed strict/deep verification with unchanged fuses, ASAR and
repository entitlements, and executed JavaScript. Its custom startup probe then
waited on Keychain initialization because it incorrectly replaced OS `HOME`;
the repository's supported profile isolation preserves `HOME`. Full startup was
not revalidated with the corrected environment. No production signing or
notarization was validated.

Packaged renderer/native PTY/Annex/network acceptance, updater apply/relaunch,
and hosted Windows/Linux validation remain outstanding. Local signing is not a
prerequisite for opening this PR; these limitations must remain distinct from
the passing development-runtime checks. The installed application was not
replaced or restarted. Earlier dated findings below are historical and are
superseded by this section for the selected runtime and current validation.

## Node security follow-up — 2026-10-26

Electron remains pinned to 45.0.0. Dependabot now defers only Electron major
updates, allowing fixes on the current major to be proposed instead of ignoring
all versions >=44.0.0. This policy change does not patch the shipped runtime.
The [stable distribution](https://releases.electronjs.org/release/v45.0.0)
still reports Node 24.22.0; a stable distribution covering the full October Node
security batch remains unverified. Evaluate vendor backports per advisory:
Electron uses Chromium's Brotli, so its Node version alone does not establish
Brotli exposure. Do not substitute an alpha for a verified stable security update.

## Runtime migration

The user requested the newest stable Electron to reduce the distance to future
security updates. Official npm `latest` and the [vendor release](https://github.com/electron/electron/releases/tag/v45.0.0)
identify **45.0.0**. The exact package and lock pin move from 43.8.3 to 45.0.0.
The vendor lists Chromium **156.0.8078.48** and Node **24.22.0**. This retains the
[eMudhra blocklist mitigation](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)
(fixed on the 45 line in beta.6), but **does not establish the October Node fixes**
from 24.22.1. No prerelease runtime is selected. Marketplace global fetch still
reaches Brotli decoding; the earlier Node advisory classifications remain in
[the runtime ledger](security-2026-10-23.md).

[Electron 44/45 breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)
were compared with source and packaging:

- Image clipboard read/write helpers were removed. Main now uses asynchronous
  ClipboardItems, prefers PNG then JPEG, normalizes reads to the existing PNG
  IPC shape, and waits for copy completion/errors. Wake cooldown, top-frame
  authorization and the rich-chat feature gate remain in place. Tests cover
  rejected native reads/writes, MIME selection, conversion and asynchronous
  completion without touching the user's clipboard.
- Background `net` requests can now select platform client certificates. A
  `select-client-certificate` listener declines selection only when webContents
  is null, preserving the prior no-client-certificate boundary for background
  requests. Browser-window selection retains its previous behavior. Tests cover
  both branches; no real identity/certificate was accessed by the tests.
- Sandboxed preload Node shims/globals were removed. No executable Buffer,
  setImmediate/clearImmediate or events/timers/url imports were found in CH's
  preload sources. Startup/IPC smoke must still verify the compiled preload.
- ASAR raw file descriptors no longer work in native APIs. CH's native node-pty
  binaries are unpacked/copied by Forge; shell/native PTY smoke is required.
- Removed contentTracing APIs, old login-item attributes, frame capture
  constraints, and removed Node worker permissions were not used in inspected
  CH source. Window security guards remain unchanged.
- **Support decision:** Electron 45 requires macOS 13+, dropping macOS 12.
  Current release targets are 64-bit; Windows ia32/Linux armv7l binaries are no
  longer available. This support-floor change must be called out before rollout.
- safeStorage's synchronous API still works in 45 but is deprecated for removal
  in 46. CH and vendored Framebriar need an asynchronous storage migration before
  the next major; no encryption fallback or keychain setting was changed here.
  **Done (#2521):** both stores now use the async API when Electron has it, with
  the sync API as a fallback. Existing files decrypt unchanged. See
  `docs/framebriar-sdk-drop-20261031.md`.

## Patched build archive dependencies

`npm audit` falls from **35 package entries (1 critical, 32 high, 2 moderate)**
to **10 (0 critical, 8 high, 2 moderate)**. Entries include propagated parent
findings, not ten independent vulnerabilities. Remaining leaf packages are
image-size, node-forge and UUID. No global audit-force upgrade was used.

### tar 6.2.1 → 7.5.22, scoped under @electron/rebuild

Affected graph: Forge 7.11.2 core-utils → @electron/rebuild 3.7.2 → tar;
also rebuild → @electron/node-gyp 10.2.0-electron.1 → tar, and node-gyp →
make-fetch-happen 10.2.1 → cacache 16.1.3 → tar. No tar import was found in
cacache's lib despite its declared dependency. Source maps did not identify
these modules in the shipped main application.

The 6.x line has no patched release. Rebuild's newer 4.x line requires a broader
Node/Forge migration. The scoped override selects tar 7.5.22 for these consumers.
Tar 7 retains CommonJS and the Promise/stream `x`/`extract` APIs they call;
Node >=18 is compatible with the current Node 22 CI line and local Node 24.
Tar 7 changes chmod's default: existing files keep their mode. The clang consumer
creates a fresh destination; tests verify new compiler executable mode 0755.
Node-gyp's header files do not require replacing executable permissions.

The exact inspected calls are rebuild `lib/clang-fetcher.js` (file extraction)
and node-gyp `lib/install.js` (file or stream, strip:1, extension filter, onwarn).
The tests resolve tar through both consumers, exercise those options, and
check the decompression guard with only 64 KiB and an explicitly low limit.
They are compatibility/regression evidence, not exhaustive malicious-archive
fuzzing. Normal CH Forge configuration has `onlyModules: []`, excluding native
rebuild modules; manual rebuilds or a future config change can reach this code.
Node-gyp extracts streamed headers before comparing SHASUMS, so checksums cannot
protect that extraction from parser exhaustion. An attacker needs a supplied
local tarball, compromised/attacker-configured header or clang source, or similar
control of the build input. These are build-machine exposures, not Annex input.

| Advisory | First fixed version | Relevant precondition |
| --- | --- | --- |
| [GHSA-23hp-3jrh-7fpw](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw), critical decompression exhaustion | 7.5.19 | Compressed archive parsing/extraction |
| GHSA-r292-9mhp-454m, recursive member filter | 7.5.21 | Member-selection array; not passed by the inspected consumers |
| GHSA-34x7-hfp2-rc4v, hardlink traversal | 7.5.7 | Hostile hardlink archive |
| GHSA-8qq5-rm4j-mr97, overwrite | 7.5.3 | Hostile extraction paths |
| GHSA-83g3-92jg-28cx, hardlink escape | 7.5.8 | Hostile hardlink archive |
| GHSA-qffp-2rhf-9h96, drive-relative hardlink | 7.5.10 | Windows path/hardlink semantics |
| GHSA-9ppj-qmqm-q256, drive-relative symlink | 7.5.11 | Windows path/symlink semantics |
| GHSA-r6q2-hw4h-h46w, path reservation collision | 7.5.4 | Case/Unicode filesystem collision |
| GHSA-vmf3-w455-68vh, PAX size handling | 7.5.16 | Crafted intermediary header |
| GHSA-w8wr-v893-vjvp, numeric PAX path crash | 7.5.18 | Crafted PAX metadata |
| GHSA-8x88-c5mf-7j5w, negative size loop | 7.5.18 | replace API; no call found in inspected consumers |
| GHSA-gvwx-54wh-qm9j, NUL PAX exception | 7.5.17 | Crafted PAX metadata |

Version ranges are recorded in the saved baseline audit. [tar 7.5.22](https://github.com/isaacs/node-tar/releases/tag/v7.5.22)
exceeds these fix minima. This override should be removed when Forge's supported
rebuild chain resolves patched tar without it.

### extract-zip 2.0.1 → official Electron extractor 1.0.6

Affected graph: Forge 7.11.2 → @electron/packager 18.4.4 → extract-zip 2.0.1.
[GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and
[GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3)
have no patched version under the old package name. A malicious distribution ZIP
or compromised/custom source can supply escaping symlinks. @electron/get validates
normal downloads/cache entries before returning them; this lowers ordinary
exposure but is not justification for retaining an unsafe extractor.

A packager-scoped npm alias selects **@electron-internal/extract-zip 1.0.6**.
This official [Electron tooling replacement](https://github.com/electron/extract-zip)
was already used by Electron's installer and is used by newer Packager releases.
Packager's sole call passes a ZIP path and absolute `dir`, exactly the supported
API. Node 22.12+ is required for its ESM/native module; the local host is 24.22.1
and CI requests the current 22 line. The separate explicit 22.23.4 pin remains
in blocked PR #2426. This is intentionally scoped to Electron distribution
extraction; the vendor does not support arbitrary unverified archives as a
security boundary. Tests exercise Packager's actual CommonJS import wrapper,
executable permissions, framework symlinks on POSIX and rejection of an escaping
symlink, confined to a disposable test directory. Windows framework-symlink
preservation is skipped because Electron's Windows archive does not use it and
creating Windows symlinks may require privileges. Hosted Windows/Linux build
validation remains required before landing this alias.

## Residual findings and next actions

| Leaf dependency and path | Applicability / prerequisites | Patched version and next action |
| --- | --- | --- |
| image-size 0.7.5: maker-dmg 7.11.2 → electron-installer-dmg 5.0.1 → appdmg 0.6.6 | Build-only. GHSA-w3rx-r6r6-pgpr loops on a crafted ICNS entry. appdmg invokes sizeOf only for a configured background; CH config specifies an icon but **no background**, so this parser path is skipped in the current DMG build. The icon is not the parsed background. | First fixed 2.0.3; latest 2.0.4. No fixed 0.x/1.x. appdmg calls the old filename/callback API; v2 changed exports and uses separate file API. Do not force it. Upgrade/migrate the DMG maker once a compatible parent is available; re-audit before enabling backgrounds. |
| node-forge 1.4.0: Forge webpack → webpack-dev-server 5.2.7 → selfsigned 2.4.1; also imported directly by annex-tls.ts | **Shipped** despite dev:true. GHSA-86w9-cpqp-85rv concerns forged PKCS#1 v1.5 signature verification. Annex generates/signs its own certificate; Node/OpenSSL verifies TLS. No attacker-signature verification path found in Annex. selfsigned verifies its own newly generated certificate, not supplied attacker certificates. | No patched npm release verified. Track a vendor fix or separately replace the Annex certificate implementation with interoperability tests. If a tooling update removes this incidental dependency, make the Annex dependency explicit; do not silently remove it to clean audit output. |
| uuid 8.3.2: webpack-dev-server 5.2.7 → sockjs 0.3.24 → uuid | Tooling-only inspected path uses v4() with no external buffer. GHSA-w5hq-g745-h8pq affects v3/v5/v6 buffer/offset use; that prerequisite is absent. Shipped Mermaid already resolves fixed uuid 14.0.3. | Fixed lines start 11.1.1, 12.0.1, 13.0.1; no fixed 8.x. Update SockJS/dev-server through a supported compatible release. No blind major override for an unused vulnerable API. |

The npm audit does not enumerate every embedded Electron/Node/Chromium or native
binary issue. Passing tests and the smaller audit count do not clear the Node
release blocker. Prior test/tooling major holds are in the dependency sweep.

## Validation and landing status

- Clean `npm ci` passed with Node 24.22.1 / npm 11.19.1. Fresh audit: 10
  affected package entries, 0 critical / 8 high / 2 moderate.
- Final typecheck passed. Full lint passed with 0 errors and 2,980 warnings.
- Full unit/component/integration suite: **791 files / 18,190 tests passed**;
  4 files / 37 tests skipped.
- Fresh macOS ARM64 `npm run package` passed, including all six fuse assertions.
  The test-copy and original app.asar SHA-256 is
  `1cc7510b45fac48d1e9fbce424d4e3eba71ad54c241cafabb2b1814d661e1929`.
- **80 development-Electron E2E tests passed**: startup, navigation, blank-screen
  guards, Mermaid, multifile local plugins, popouts/IPC, native terminal input
  and resize/reconnect, Annex authentication/lifecycle, and runtime networking.
  A separate successful runtime rerun saved a structured evidence report.
- Executed development Electron reports **45.0.0 / Node 24.22.0 /
  Chromium 156.0.8078.48 / Undici 7.29.1 / Brotli 1.2.0 / modules ABI 150**,
  with **app.isPackaged false**. Node rejects the untrusted local TLS certificate
  and accepts an explicit per-request CA. Chromium net.fetch rejects the same
  untrusted certificate with ERR_CERT_AUTHORITY_INVALID. Global fetch decodes
  a benign Brotli response. No system trust or clipboard content was changed.
- The packaged framework (207,017,632 bytes) matches that executed official
  framework except six fuse-wire bytes at offsets 161230750–161230755,
  `101100` → `010011`. Official SHA-256:
  `5b3df7a04ddcad788384b59d2264b8fc06b8f8a92f4503decec354cdfeb91ba0`;
  packaged SHA-256:
  `8e6c36c2b72023cbfe70bf383c7019cf8f5620832def11a8c0fcc22269b36d71`.
  This is binary provenance, **not a successful packaged launch**. Packaged
  Info.plist reports 45.0.0 and minimum macOS 13.0. Unpacked native PTY binaries
  and the spawn helper are present; development-Electron native PTY E2E passed.

**Packaged launch is blocked in this follow-up.** Automatic approval review
rejected the ad-hoc signing action targeting only
`electron45-validation/packaged-validation/Clubhouse.app`, stating:
“Although isolated validation is authorized, the explicit restriction against
signing any app bars this ad-hoc codesign action.” The rejected command did not
execute and was not retried or routed around. An explicit resolution of that
approval conflict is pending. A separate safe copy and read-only inspection
completed afterward; `codesign --verify --deep --strict` reports “code has no
resources but signature indicates they must be present”. The copy remains
unsigned/unrepaired. All six fuses match the original hardened package.

Consequently **actual packaged app.isPackaged, startup, native PTY, Annex and
network checks on Electron 45 remain unverified**, along with production
signing/notarization, updater download/apply/relaunch, and hosted Windows/Linux
validation. Earlier Electron 43.8.3 packaged passes are historical evidence only.
No real agents, persistent pairing, user-installed app changes, release,
credentials, system trust changes or GitHub writes were used in this follow-up.

Remote read-only verification still shows main at
`8e0903616ee45bff75c04f9bb62dc35feafce7f2` and the security branch at
`b96213e9c8717224bc040e4a3640610e265b4004`. **9bcdef0 is local-only**, as is this
follow-up. PR creation and #2426's ready transition remain denied with
`403 FORBIDDEN: Resource not accessible by integration`; no retry or alternative
write route was attempted. No hosted CI/merge/landing is claimed.

Release recommendation: **hold** for complete applicable embedded Node coverage,
resolution of actual packaged validation, normal cross-platform hosted CI and
reviewed landing. A rollout must explicitly acknowledge the macOS 13 support
floor. The sweep reduces exposure and prepares the newest stable runtime; it
does not make the current main release-ready.
