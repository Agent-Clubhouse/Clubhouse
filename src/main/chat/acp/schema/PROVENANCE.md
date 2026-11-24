# Vendored ACP schema

`schema.v1.json` is the **stable** Agent Client Protocol v1 JSON schema, byte for
byte, from the public npm package `@agentclientprotocol/sdk`. `LICENSE` is that
package's license (Apache-2.0, Zed Industries). Nothing here is loaded at
runtime: `../protocol.ts` hand-writes the subset Clubhouse speaks, and
`../protocol.test.ts` checks it against this file.

| Field | Value |
|---|---|
| Package | `@agentclientprotocol/sdk` |
| Version | `2.9.1` |
| Source repository | https://github.com/agentclientprotocol/typescript-sdk, tag `v2.9.1` (`ab16fb07b4e7e5dd8e55633b42930857223c4cd0`, the package's `gitHead`) |
| Tarball | `https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-2.9.1.tgz` |
| Tarball sha1 (registry `dist.shasum`) | `dbfc3b7182def3d6df0678db634726023fd33527` |
| Tarball integrity (registry `dist.integrity`) | `sha512-8iJdxGa3SunLfzqLLb3RfQFmr4hnmWeAyeAK6MbkJiXJbrRlMRgKsVnDl/7Hu48yu/30gAlytNDzh5W77rv5SA==` |
| File in tarball | `package/schema/v1/schema.json` → `schema.v1.json` |
| `schema.v1.json` sha256 | `79fbeccc5cb5668259ee35ff7440ffd79eaf813742366ac06f707b98bbf789db` |
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
