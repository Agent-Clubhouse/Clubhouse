#!/usr/bin/env node
/**
 * Builds the main-process bundle with the production webpack config and
 * checks the telemetry lazy chunks (docs/telemetry-otel-spec.md §6.3):
 *
 *  - the SDK and each destination are emitted as separate async chunks, so
 *    the main entry chunk contains no OpenTelemetry or Azure exporter code;
 *  - the telemetry chunks, plus any shared chunks webpack split out of them,
 *    total at most 2 MB for each destination (SDK + that destination).
 *
 * Usage: node scripts/check-telemetry-chunk-size.mjs [--json]
 * CI runs it through scripts/check-telemetry-chunk-size.test.ts.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMIT_BYTES = 2 * 1024 * 1024;
const SDK_CHUNK = 'telemetry-sdk';
const DESTINATION_CHUNKS = ['telemetry-azure', 'telemetry-otlp', 'telemetry-framebriar'];

/** Load the TypeScript webpack config with a minimal transpile-only hook. */
function loadMainConfig() {
  const ts = require('typescript');
  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = (module, filename) => {
    const source = readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
  try {
    return require(path.join(root, 'webpack.main.config.ts')).mainConfig;
  } finally {
    if (previous) require.extensions['.ts'] = previous;
    else delete require.extensions['.ts'];
  }
}

function build(config) {
  const webpack = require('webpack');
  return new Promise((resolve, reject) => {
    webpack(config, (err, stats) => {
      if (err) return reject(err);
      if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve(stats);
    });
  });
}

const fmt = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

/** Returns { report, failures }; failures is empty when every check passes. */
export async function checkTelemetryChunks() {
  const mainConfig = loadMainConfig();
  const outDir = mkdtempSync(path.join(tmpdir(), 'clubhouse-telemetry-chunks-'));
  const config = {
    ...mainConfig,
    context: root,
    mode: 'production',
    target: 'electron-main',
    devtool: false,
    output: { path: outDir, filename: 'index.js', chunkFilename: '[name].js' },
    // Type checking, Monaco and asset copying don't affect main-process chunking.
    plugins: [],
  };
  try {
    const stats = await build(config);
    const json = stats.toJson({ all: false, ids: true, assets: true, chunks: true, chunkGroups: true });
    const assetSize = new Map(json.assets.map((a) => [a.name, a.size]));
    const chunkById = new Map(json.chunks.map((c) => [c.id, c]));
    // Emitted (minified) bytes, which is what ships in app.asar.
    const chunkBytes = (id) => chunkById.get(id).files.reduce((sum, f) => sum + (assetSize.get(f) ?? 0), 0);
    const entryChunkIds = new Set(json.namedChunkGroups.main.chunks);

    const groupBytes = (name) => {
      const group = json.namedChunkGroups[name];
      if (!group) throw new Error(`Chunk group "${name}" was not emitted: is lazy-chunks.js still plain JS with webpackChunkName comments?`);
      const ids = group.chunks.filter((id) => !entryChunkIds.has(id));
      return { ids, bytes: ids.reduce((sum, id) => sum + chunkBytes(id), 0) };
    };

    const failures = [];
    const { compilation } = stats;
    const { chunkGraph } = compilation;
    const entryChunks = new Set(compilation.entrypoints.get('main').chunks);
    // Expand concatenated modules so every bundled file is visible.
    const bundled = [];
    for (const m of compilation.modules) {
      for (const inner of m.modules ?? [m]) {
        if (inner.resource) bundled.push({ resource: inner.resource, chunks: [...chunkGraph.getModuleChunks(m)] });
      }
    }
    const sdkModule = /node_modules[\\/](@opentelemetry|@azure[\\/]monitor-opentelemetry-exporter)[\\/]/;
    const leaked = bundled.filter((b) => sdkModule.test(b.resource) && b.chunks.some((c) => entryChunks.has(c)));
    if (leaked.length) failures.push(`Main entry chunk contains telemetry SDK modules (first: ${leaked[0].resource})`);

    // destinations/azure.ts neutralizes the exporter's OneSettings singleton by
    // file path into dist/commonjs. If webpack ever bundled the ESM build too,
    // that would be a second, un-neutralized instance.
    const azure = bundled.map((b) => b.resource).filter((r) => r.includes('monitor-opentelemetry-exporter'));
    if (azure.some((r) => /monitor-opentelemetry-exporter[\\/]dist[\\/]esm[\\/]/.test(r))) {
      failures.push('The Azure exporter ESM build is bundled; OneSettings neutralization would miss that instance');
    }
    const configManagers = azure.filter((r) => /_configuration[\\/]configurationManager\.js$/.test(r));
    if (configManagers.length !== 1) {
      failures.push(`Expected exactly one Azure exporter ConfigurationManager module, found ${configManagers.length}`);
    }

    const sdk = groupBytes(SDK_CHUNK);
    const report = { limitBytes: LIMIT_BYTES, sdkBytes: sdk.bytes, destinations: {} };
    for (const dest of DESTINATION_CHUNKS) {
      const d = groupBytes(dest);
      const ids = new Set([...sdk.ids, ...d.ids]);
      const total = [...ids].reduce((sum, id) => sum + chunkBytes(id), 0);
      report.destinations[dest] = { ownBytes: d.bytes, totalWithSdkBytes: total };
      if (total > LIMIT_BYTES) failures.push(`${SDK_CHUNK} + ${dest} is ${fmt(total)}, over the ${fmt(LIMIT_BYTES)} limit`);
    }
    return { report, failures };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { report, failures } = await checkTelemetryChunks();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`telemetry-sdk: ${fmt(report.sdkBytes)}`);
    for (const [dest, r] of Object.entries(report.destinations)) {
      console.log(`${dest}: ${fmt(r.ownBytes)} (with SDK: ${fmt(r.totalWithSdkBytes)}, limit ${fmt(LIMIT_BYTES)})`);
    }
  }
  for (const f of failures) console.error(`::error::${f}`);
  if (failures.length) process.exitCode = 1;
}
