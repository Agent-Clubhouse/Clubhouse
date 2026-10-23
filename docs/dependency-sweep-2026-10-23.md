# Core, build and test dependency sweep — 2026-10-23

Baseline for this extension: security branch commit `b96213e9c8717224bc040e4a3640610e265b4004`.
Original main baseline: `8e0903616ee45bff75c04f9bb62dc35feafce7f2`.
Official npm metadata, `npm outdated`, a fresh audit and upstream release notes
were checked for every direct runtime and development dependency. No forced
audit upgrade, release, installed-app replacement or GitHub write is included.

## Electron and Node decision

Keep the already selected **Electron 43.8.3**. The live
[Electron stable table](https://releases.electronjs.org/) and
[vendor releases](https://github.com/electron/electron/releases) list 43.8.3,
44.9.3 and 45.0.0, all with **Node 24.22.0**. The
[October Node bulletin](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
fixes are **24.22.1 / 22.23.4 / 26.12.1**. Only 46.0.0-alpha.1 and nightly
were verified to advertise Node 24.22.1; neither is appropriate for this patch.
The certificate blocklist fix is already in 43.8.3; full applicable Node bulletin
coverage remains unverified. See the [advisory ledger](security-2026-10-23.md).

The workflows still request floating `node-version: 22` (17 occurrences across
Validate, release and chat-handshake workflows). That declaration does not prove
which patch a hosted job ran. The explicit **22.23.4** pin is already in PR #2426;
its ready transition is denied. This sweep does not duplicate that patch. Local
validation uses **Node 24.22.1 / npm 11.19.1**. Neither CI nor host Node changes
Electron's embedded runtime. Node 26.12.1 is a separate major migration, not needed
for the current CI security fix.

## Selected updates and security relevance

- **Vitest and coverage 4.1.11 → 4.1.12**, including the matched mocker family.
  The vendor backported [manual mock code injection](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)
  and [Windows redirect traversal](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp)
  fixes. These affect exposed mock-server/plugin paths, not the shipped CH runtime;
  this repository's configured test environments are Node/jsdom.
- **Playwright 1.64.0 → 1.64.1** fixes an Electron first-window launch regression
  ([vendor notes](https://github.com/microsoft/playwright/releases/tag/v1.64.1)).
- **React/react-dom 19.3.0 → 19.3.1**, **Zustand 5.0.15 → 5.0.16**,
  **Marked 18.1.0 → 18.1.1** and **user-event 14.6.7 → 14.6.8** are compatible
  maintenance updates. React's notes concern server components; CH's desktop
  renderer is not being claimed vulnerable to that path. Marked includes parser
  correctness and nested-list performance fixes; DOMPurify remains the sanitizer.
- **ESLint 9.39.4 → 9.39.5**, **typescript-eslint 8.71.1 → 8.72.0** and
  current PostCSS 8.5.31 minimum; latest compatible lock resolutions also include
  **webpack 5.106.1 → 5.112.2**, **webpack-dev-middleware 7.4.5 → 7.4.6**,
  **electron-winstaller 5.4.0 → 5.4.4** and **MCP SDK 1.32.1 → 1.32.2**.
- Transitive **qs 6.14.2 → 6.16.1** removes the remaining qs findings;
  **body-parser 2.3.0 → 2.4.0** under the MCP SDK removes the new compressed-body
  DoS finding. These are dependency-graph fixes, not proof every path is shipped.
- Declare **@types/node ^24.19.2** explicitly to match the embedded major, instead
  of accepting an unconstrained transitive Node26 type resolution. Current Node24
  types also rename the event-loop histogram interface. Infer its return type from
  `monitorEventLoopDelay` so telemetry remains type-safe without runtime changes.

Audit package-entry counts: **40 → 35** in this expanded pass; final severity
counts **1 critical, 32 high, 2 moderate**. These include propagated parent
findings, not 35 independent vulnerabilities. The original security pass reduced
62 entries to 39; one new body-parser finding appeared before this extension.

Remaining leaf findings:

| Package | Installed | Why not forced here |
| --- | --- | --- |
| tar | 6.2.1 | Critical/high archive findings through Forge 7 rebuild/node-gyp/cacache. Patched 7.5.22 exists; forcing a major underneath old consumers is not established compatible. Coordinate Forge 8 migration. |
| extract-zip | 2.0.1 | Archive symlink traversal; no fixed release under this package name. Forge 8 uses electron-internal replacement. |
| image-size | 0.7.5 | ICNS parser DoS through appdmg. Coordinate maker/Forge migration; app's icon input is local. |
| node-forge | 1.4.0 | No patched npm version for signature verification advisory. Annex ships certificate generation/signing, not the inspected vulnerable verification path. It must not be dismissed as dev-only. |
| uuid | 8.3.2 | SockJS tooling copy remains; runtime Mermaid resolves 14.0.3. Do not override its major without consumer compatibility work. |

## Deferred updates and migration requirements

| Component | Available target | Reason |
| --- | --- | --- |
| Electron 43.8.3 | 44.9.3 / 45.0.0 | Major Chromium/native/packaging migration; still Node24.22.0. |
| Forge 7.11.2 / fuses 1.8.0 | Forge 8.0.1 / fuses 2.1.3 | [Forge 8](https://github.com/electron/forge/releases/tag/v8.0.1) changes to ESM, raises Node minimum and changes makers/output paths. Fuses 2 needs coordinated peer update. Requires Windows/Linux/macOS package validation, not a forced audit fix. |
| Vitest 4.1.12 | 5.0.5 | Existing nested mocks and protocol timing need migration; security backports are available on 4.1.12. |
| ESLint 9.39.5 / @eslint/js 9.39.5 | 10.13.0 / 10.0.1 | Existing new-rule violations documented in Dependabot policy; v9 is marked unsupported by npm. Schedule migration rather than suppress new errors. |
| TypeScript 5.9.3 / Monaco 0.55.1 | 7.0.2 / 0.57.0 | Requires exports-aware module-resolution and API migration; existing policy records missing typings in 0.56. No assumption 0.57 resolves all compatibility work. |
| jsdom 28.1.0 | 30.1.3 | Major DOM/test behavior change; broad component migration separate from patched Vitest. |
| asset-relocator 1.7.3 | 1.11.0 | Repo records renderer blank-screen regression from newer unguarded native-module runtime injection. Retain exact pin. |
| OTel 2.10.0 / experimental 0.221.0 / API 1.9.1 | 2.12.0/0.223 or3.0.0/0.300, API 1.10.0 | Must move together with Azure exporter compatibility. beta.46 still pins log SDK 0.221; latest Azure tag misleadingly points backward to beta.32. Do not downgrade or introduce duplicate SDKs. |
| Claude Agent SDK 0.3.302 | 0.3.309 latest;0.3.310 next | [0.3.309](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.309) fixes managed-settings propagation and embedded CLI extraction. Changes the CLI to 2.1.309; repository's live chat validation covers 2.1.302. Needs separate driver/embedded CLI validation; do not claim live validation from mocks. Keep Anthropic API SDK peer 0.135.0 rather than accepting its unconstrained major 1.2.0. |

These holds follow inspected compatibility evidence and `.github/dependabot.yml`;
they do not require new permission just because a migration is larger. They are
explicit deferred work, not a claim the current toolchain is fully secure.

## Validation

- Final clean `npm ci`, typecheck and lint passed (0 errors, 2,979 existing warnings).
- Full unit/component/integration suite passed: 789 files, 18,178 tests; 4 files
  and 37 tests skipped. A full rerun after the type compatibility repair passed.
- Updated V8 coverage adapter: 28 existing telemetry health tests passed;
  statements 98.8%, branches 93.67%, functions 100%, lines 99.33%.
- Fresh macOS ARM64 `npm run package` passed, including all six hardened-fuse
  assertions. No release signing or notarization credentials were used.
- 49 development-Electron E2E tests passed: startup, navigation/blank-screen
  guards, Node HTTPS verification, benign Brotli fetch, and Annex authentication
  and lifecycle. These launch `.webpack` with the installed development Electron,
  not the packaged executable; the HTTPS probe is not Chromium networking.
- Source-map inspection of 17 built main-process maps found 42 node-forge modules
  and no npm body-parser, qs, tar, extract-zip, image-size or Undici modules.
  This bounded check does not inspect every opaque SDK binary or external CLI.
- The new isolated packaged copy was ad-hoc signed under the prior user approval.
  `codesign --verify --deep --strict` passed. All six fuses and app.asar were
  unchanged by signing; the unsigned original was preserved. New app.asar SHA256:
  `b2b6f5cfb1d85de93d3924345502ad9831e9dd2eeea1c98103535e7fb5610be8`.
- **Fresh actual packaged launch passed:** after an initial macOS Keychain wait
  (confirmed by a process stack sample), the app completed startup and renderer
  initialization. Its startup record reports `app.isPackaged: true`, Electron
  **43.8.3**, Node **24.22.0**, Chromium **150.0.7871.250**. The official marketplace
  HTTPS fetch and startup plugin-update check succeeded. It exited with code 0,
  and the disposable profile was removed. No Keychain/trust setting was changed.
- Fresh packaged Annex, custom-registry negative/Brotli checks, Chromium TLS and
  updater apply/relaunch were not repeated in this extension. The prior b96213e9
  packaged Annex/custom-registry evidence remains separately identified; the
  new development-Electron compatibility checks above passed.

Release remains on hold: applicable embedded Node fixes are not verified in a
stable Electron; deferred tooling advisories remain; production signing/notarization
and updater apply are untested; and normal hosted CI/review/merge are blocked by
the existing GitHub 403 denial. No GitHub write was retried or redirected. The
extension is local and reviewable.

## Full direct dependency inventory

Registry latest tags are a snapshot and are not always the right target (Azure
is the known example above). “Held” means unchanged, including packages already
current. Lockfile changes include compatible transitive updates and deduplication.

| Dependency | Before | Selected | Registry latest | Decision |
| --- | --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.302 | 0.3.302 | 0.3.309 | Held |
| `@azure/monitor-opentelemetry-exporter` | 1.0.0-beta.46 | 1.0.0-beta.46 | 1.0.0-beta.32 | Held |
| `@monaco-editor/react` | 4.7.0 | 4.7.0 | 4.7.0 | Held |
| `@opentelemetry/api` | 1.9.1 | 1.9.1 | 1.10.0 | Held |
| `@opentelemetry/api-logs` | 0.221.0 | 0.221.0 | 0.223.0 | Held |
| `@opentelemetry/context-async-hooks` | 2.10.0 | 2.10.0 | 3.0.0 | Held |
| `@opentelemetry/core` | 2.10.0 | 2.10.0 | 3.0.0 | Held |
| `@opentelemetry/exporter-logs-otlp-http` | 0.221.0 | 0.221.0 | 0.300.0 | Held |
| `@opentelemetry/exporter-metrics-otlp-http` | 0.221.0 | 0.221.0 | 0.300.0 | Held |
| `@opentelemetry/exporter-trace-otlp-http` | 0.221.0 | 0.221.0 | 0.300.0 | Held |
| `@opentelemetry/resources` | 2.10.0 | 2.10.0 | 3.0.0 | Held |
| `@opentelemetry/sdk-logs` | 0.221.0 | 0.221.0 | 3.0.0 | Held |
| `@opentelemetry/sdk-metrics` | 2.10.0 | 2.10.0 | 3.0.0 | Held |
| `@opentelemetry/sdk-trace-base` | 2.10.0 | 2.10.0 | 2.12.0 | Held |
| `@types/ws` | 8.18.2 | 8.18.2 | 8.18.2 | Held |
| `@xterm/addon-fit` | 0.11.0 | 0.11.0 | 0.11.0 | Held |
| `@xterm/addon-serialize` | 0.14.0 | 0.14.0 | 0.14.0 | Held |
| `@xterm/headless` | 6.0.0 | 6.0.0 | 6.0.0 | Held |
| `@xterm/xterm` | 6.0.0 | 6.0.0 | 6.0.0 | Held |
| `adm-zip` | 0.6.1 | 0.6.1 | 0.6.1 | Held |
| `bonjour-service` | 1.4.4 | 1.4.4 | 1.4.4 | Held |
| `dompurify` | 3.4.17 | 3.4.17 | 3.4.17 | Held |
| `electron-squirrel-startup` | 1.0.1 | 1.0.1 | 1.0.1 | Held |
| `elkjs` | 0.12.0 | 0.12.0 | 0.12.0 | Held |
| `highlight.js` | 11.12.0 | 11.12.0 | 11.12.0 | Held |
| `marked` | 18.1.0 | 18.1.1 | 18.1.1 | Updated |
| `mermaid` | 12.2.0 | 12.2.0 | 12.2.0 | Held |
| `monaco-editor` | 0.55.1 | 0.55.1 | 0.57.0 | Held |
| `node-pty` | 1.1.0 | 1.1.0 | 1.1.0 | Held |
| `picomatch` | 4.0.7 | 4.0.7 | 4.0.7 | Held |
| `react` | 19.3.0 | 19.3.1 | 19.3.1 | Updated |
| `react-dom` | 19.3.0 | 19.3.1 | 19.3.1 | Updated |
| `ws` | 8.22.0 | 8.22.0 | 8.22.0 | Held |
| `zustand` | 5.0.15 | 5.0.16 | 5.0.16 | Updated |
| `@electron-forge/cli` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/maker-deb` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/maker-dmg` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/maker-rpm` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/maker-squirrel` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/maker-zip` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/plugin-auto-unpack-natives` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/plugin-fuses` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron-forge/plugin-webpack` | 7.11.2 | 7.11.2 | 8.0.1 | Held |
| `@electron/fuses` | 1.8.0 | 1.8.0 | 2.1.3 | Held |
| `@eslint/js` | 9.39.5 | 9.39.5 | 10.0.1 | Held |
| `@playwright/test` | 1.64.0 | 1.64.1 | 1.64.1 | Updated |
| `@tailwindcss/postcss` | 4.3.3 | 4.3.3 | 4.3.3 | Held |
| `@testing-library/dom` | 10.4.2 | 10.4.2 | 10.4.2 | Held |
| `@testing-library/jest-dom` | 7.0.1 | 7.0.1 | 7.0.1 | Held |
| `@testing-library/react` | 16.3.3 | 16.3.3 | 16.3.3 | Held |
| `@testing-library/user-event` | 14.6.7 | 14.6.8 | 14.6.8 | Updated |
| `@types/adm-zip` | 0.6.0 | 0.6.0 | 0.6.0 | Held |
| `@types/node` | 25.6.0 | 24.19.2 | 26.6.5 | Updated |
| `@types/picomatch` | 4.0.3 | 4.0.3 | 4.0.3 | Held |
| `@types/react` | 19.3.0 | 19.3.0 | 19.3.0 | Held |
| `@types/react-dom` | 19.3.0 | 19.3.0 | 19.3.0 | Held |
| `@vercel/webpack-asset-relocator-loader` | 1.7.3 | 1.7.3 | 1.11.0 | Held |
| `@vitest/coverage-v8` | 4.1.11 | 4.1.12 | 5.0.5 | Updated |
| `copy-webpack-plugin` | 14.0.0 | 14.0.0 | 14.0.0 | Held |
| `css-loader` | 7.1.5 | 7.1.5 | 7.1.5 | Held |
| `electron` | 43.8.3 | 43.8.3 | 45.0.0 | Held |
| `eslint` | 9.39.4 | 9.39.5 | 10.13.0 | Updated |
| `eslint-plugin-import-x` | 4.17.1 | 4.17.1 | 4.17.1 | Held |
| `fork-ts-checker-webpack-plugin` | 9.1.0 | 9.1.0 | 9.1.0 | Held |
| `jsdom` | 28.1.0 | 28.1.0 | 30.1.3 | Held |
| `monaco-editor-webpack-plugin` | 7.1.1 | 7.1.1 | 7.1.1 | Held |
| `node-loader` | 2.1.0 | 2.1.0 | 2.1.0 | Held |
| `postcss` | 8.5.31 | 8.5.31 | 8.5.31 | Held |
| `postcss-loader` | 8.2.1 | 8.2.1 | 8.2.1 | Held |
| `style-loader` | 4.0.0 | 4.0.0 | 4.0.0 | Held |
| `tailwindcss` | 4.3.3 | 4.3.3 | 4.3.3 | Held |
| `ts-loader` | 9.6.2 | 9.6.2 | 9.6.2 | Held |
| `typescript` | 5.9.3 | 5.9.3 | 7.0.2 | Held |
| `typescript-eslint` | 8.71.1 | 8.72.0 | 8.72.0 | Updated |
| `vitest` | 4.1.11 | 4.1.12 | 5.0.5 | Updated |
