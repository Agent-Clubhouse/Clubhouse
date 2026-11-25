# Vendored ACP schema

`schema.v1.json` is the **stable** Agent Client Protocol v1 JSON schema, byte for
byte, from the public npm package `@agentclientprotocol/sdk`. `LICENSE` is that
package's license (Apache-2.0, Zed Industries). Nothing here is loaded at
runtime: `../protocol.ts` hand-writes the subset Clubhouse speaks, and
`../protocol.test.ts` checks it against this file.

| Field | Value |
|---|---|
| Package | `@agentclientprotocol/sdk` |
| Version | `2.12.0` |
| Source repository | https://github.com/agentclientprotocol/typescript-sdk, tag `v2.12.0` (`6b84c6da9430a1e4aba9c87c0b45f8b43a6aea9a`, the package's `gitHead`) |
| Tarball | `https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-2.12.0.tgz` |
| Tarball sha1 (registry `dist.shasum`) | `6df251c1884006efd1da35c7a807df84151e513a` |
| Tarball integrity (registry `dist.integrity`) | `sha512-nSkamfY4Lw9/AVBU5G5V9p82ScXhANDMBybQwcPH/9+euUtZm04/VFUMaLj4gLFEXxQEy+QP1VQiKgSRbYVIPg==` |
| File in tarball | `package/schema/v1/schema.json` → `schema.v1.json` |
| `schema.v1.json` sha256 | `d3ddaefbee593abf74beeda91bdf57b58ef99bf90219dc1cb4ae90be3ba18518` |
| `LICENSE` sha256 | `6ed4f049cce59e05197d585bdf8a39980b45d546d6ea718ee344555f3a867c3a` |
| Protocol docs | https://agentclientprotocol.com/protocol/v1/overview |

Only the stable schema is vendored. `schema.unstable.json` (fork, providers,
session status/options/title, and others) is not, and Clubhouse doesn't send
those methods.

## Checking or upgrading

`npm run acp:check-schema` downloads the pinned tarball with
`npm pack --ignore-scripts` into a temporary folder (nothing is installed and no
package script runs), checks it against the registry's `dist.shasum` and
`dist.integrity` and the values above, and compares the schema and license
bytes with the committed copies. To upgrade, run
`node scripts/acp-schema-pin.mjs --version <x.y.z> --write`, update this table
from its output, and fix whatever `protocol.test.ts` reports.
