#!/usr/bin/env bash
# Rebuild node-pty for Linux inside an older Debian (#3080), so the glibc the
# packaged app needs is set by this image, not by whatever the runner has.
#
# node-pty is the only native module. It's compiled once by `npm ci` and
# copied into the package as it is (forge.config.ts rebuildConfig.onlyModules
# is empty), so this runs after `npm ci` and before `electron-forge make`. It
# uses Node-API, so a binary built with the image's Node loads in Electron.
# Only the compile runs in the container: about 15 seconds plus the image pull.
#
# Then it loads the rebuilt module with the runner's Node and spawns a pty, so
# a binary that doesn't load or can't spawn fails here, not for users.
set -euo pipefail

image="${LINUX_NATIVE_IMAGE:-node:22-bookworm}"
dir="node_modules/node-pty"
if [ ! -d "$dir" ]; then
  echo "::error::$dir not found. Run npm ci first."
  exit 1
fi

echo "Rebuilding node-pty in $image"
# The whole checkout is mounted: binding.gyp reads node-addon-api from the top-level node_modules.
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
  -v "$PWD":/work -w "/work/$dir" \
  "$image" npx --yes node-gyp@11 rebuild

node -e '
const pty = require("./node_modules/node-pty");
const p = pty.spawn("/bin/echo", ["pty-ok"], {});
let out = "";
p.onData((d) => { out += d; });
p.onExit(() => {
  if (!out.includes("pty-ok")) { console.error("node-pty spawned but printed", JSON.stringify(out)); process.exit(1); }
  console.log("The rebuilt node-pty spawned a pty");
  process.exit(0);
});
setTimeout(() => { console.error("node-pty did not finish spawning within 15s"); process.exit(1); }, 15000);
'
