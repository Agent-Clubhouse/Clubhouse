// Build script for the Lounge community plugin.
// Bundles state.ts + main.ts → dist/main.js (ESM, React external)
// Output goes to ~/.clubhouse/plugins/lounge/dist/main.js
//
// Usage: node --loader ts-node/esm src/renderer/plugins/builtin/lounge/build.mjs
// Or:    npx esbuild ... (see package.json script)

const esbuild = require('esbuild');
const path = require('path');
const os = require('os');
const fs = require('fs');

const pluginDir = path.join(os.homedir(), '.clubhouse', 'plugins', 'lounge');
const outFile = path.join(pluginDir, 'dist', 'main.js');

// Ensure output directory exists
fs.mkdirSync(path.dirname(outFile), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  external: ['react', 'react/jsx-runtime'],
  outfile: outFile,
  sourcemap: false,
  minify: false,
});

// Copy manifest.json
const manifestSrc = path.resolve(__dirname, '..', '..', '..', '..', '..', 'manifest.json');
const manifestDest = path.join(pluginDir, 'manifest.json');
// Use the canonical manifest at the plugin root
if (!fs.existsSync(manifestDest)) {
  console.log('Note: manifest.json should be at', pluginDir);
}

console.log('✓ Built →', outFile);

