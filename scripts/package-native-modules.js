const fs = require('node:fs');
const path = require('node:path');

function copyNativeModule(srcRoot, destRoot, moduleName) {
  const src = path.join(srcRoot, 'node_modules', moduleName);
  const dest = path.join(destRoot, 'node_modules', moduleName);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });

  // Also copy transitive native dependencies listed in the module's package.json
  const pkgPath = path.join(src, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const dep of Object.keys(deps)) {
      const depSrc = path.join(srcRoot, 'node_modules', dep);
      const depDest = path.join(destRoot, 'node_modules', dep);
      if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
        fs.cpSync(depSrc, depDest, { recursive: true });
      }
    }
  }
}

/** SDK code lives in lazy webpack chunks; no runtime, FFI or test SDK may ship as a package. */
function assertNoCopilotPackages(buildPath) {
  const modules = path.join(buildPath, 'node_modules');
  if (!fs.existsSync(modules)) return;
  for (const entry of fs.readdirSync(modules, { recursive: true })) {
    const normalized = String(entry).replace(/\\/g, '/');
    if (/(?:^|\/)(?:copilot-sdk-v3-fixture|koffi)(?:\/|$)|(?:^|\/)@koromix(?:\/|$)|(?:^|\/)@(?:github|microsoft)\/copilot-sdk(?:[-/]|$)/.test(normalized)) {
      throw new Error(`Packaged node_modules contains forbidden Copilot SDK/runtime/FFI package: ${normalized}`);
    }
  }
}

/** The exact native-package staging step used by Forge afterCopy. */
function prepareNativeModules(projectRoot, buildPath) {
  copyNativeModule(projectRoot, buildPath, 'node-pty');
  assertNoCopilotPackages(buildPath);
}

module.exports = { prepareNativeModules, assertNoCopilotPackages };
