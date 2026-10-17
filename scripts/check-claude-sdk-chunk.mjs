#!/usr/bin/env node
/**
 * Packaging guard for the Claude Agent SDK (docs/structured-chat-research.md
 * §8 "Spikes: Packaging"). Builds the main-process bundle with the production
 * webpack config, with the Claude SDK transport made reachable from the main
 * entry, and checks that:
 *
 *  - the SDK is emitted as its own lazy chunk (`claude-agent-sdk`), so the
 *    main entry chunk contains no SDK code, and that chunk stays under 2 MB;
 *  - none of the SDK's per-platform CLI binaries (~250 MB each) or any other
 *    native asset from it is emitted;
 *  - the bundled chunk actually runs: a smoke entry built from the same config
 *    starts a session against __fixtures__/fake-claude.mjs, from a temp dir
 *    with no node_modules to fall back on.
 *
 * Usage: node scripts/check-claude-sdk-chunk.mjs [--json]
 * CI runs it through scripts/check-claude-sdk-chunk.test.ts.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMIT_BYTES = 2 * 1024 * 1024;
const SDK_CHUNK = 'claude-agent-sdk';
const SDK_TRANSPORT = './src/main/chat/claude/sdk-transport.ts';
const SMOKE_ENTRY = './src/main/chat/claude/__fixtures__/sdk-bundle-smoke.ts';
const FAKE_CLAUDE = path.join(root, 'src/main/chat/claude/__fixtures__/fake-claude.mjs');

/** Load the TypeScript webpack config with a minimal transpile-only hook. */
export function loadMainConfig() {
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

export function build(config) {
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
export async function checkClaudeSdkChunk() {
  const mainConfig = loadMainConfig();
  const outDir = mkdtempSync(path.join(tmpdir(), 'clubhouse-claude-sdk-chunk-'));
  const config = {
    ...mainConfig,
    context: root,
    mode: 'production',
    target: 'electron-main',
    devtool: false,
    entry: {
      // Nothing in the app imports the chat runtime yet; add the transport so
      // this checks the bundle as it will be once it does.
      main: [mainConfig.entry, SDK_TRANSPORT],
      'claude-sdk-smoke': SMOKE_ENTRY,
    },
    output: { path: outDir, filename: '[name].js', chunkFilename: '[name].js' },
    // Type checking, Monaco and asset copying don't affect main-process chunking.
    plugins: [],
  };
  try {
    const stats = await build(config);
    const json = stats.toJson({ all: false, ids: true, assets: true, chunks: true, chunkGroups: true });
    const assetSize = new Map(json.assets.map((a) => [a.name, a.size]));
    const chunkById = new Map(json.chunks.map((c) => [c.id, c]));
    const chunkBytes = (id) => chunkById.get(id).files.reduce((sum, f) => sum + (assetSize.get(f) ?? 0), 0);
    const failures = [];

    const group = json.namedChunkGroups[SDK_CHUNK];
    if (!group) {
      failures.push(`Chunk group "${SDK_CHUNK}" was not emitted: is sdk-loader.js still plain JS with a webpackChunkName comment?`);
      return { report: {}, failures };
    }
    const mainEntryIds = new Set(json.namedChunkGroups.main.chunks);
    const sdkIds = group.chunks.filter((id) => !mainEntryIds.has(id));
    const sdkBytes = sdkIds.reduce((sum, id) => sum + chunkBytes(id), 0);
    const mainBytes = [...mainEntryIds].reduce((sum, id) => sum + chunkBytes(id), 0);
    if (sdkBytes > LIMIT_BYTES) failures.push(`${SDK_CHUNK} is ${fmt(sdkBytes)}, over the ${fmt(LIMIT_BYTES)} limit`);

    const { compilation } = stats;
    const { chunkGraph } = compilation;
    const entryChunks = new Set(compilation.entrypoints.get('main').chunks);
    const sdkModule = /node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]/;
    for (const m of compilation.modules) {
      for (const inner of m.modules ?? [m]) {
        if (!inner.resource || !sdkModule.test(inner.resource)) continue;
        if ([...chunkGraph.getModuleChunks(m)].some((c) => entryChunks.has(c))) {
          failures.push(`Main entry chunk contains Claude Agent SDK code (${inner.resource})`);
        }
      }
    }

    // The SDK's optional per-platform packages hold its bundled `claude`; none
    // of it may be copied into the bundle (e.g. by the asset relocator).
    const leakedAssets = json.assets.map((a) => a.name).filter((n) => /claude-agent-sdk-|native_modules/.test(n));
    if (leakedAssets.length) failures.push(`Bundle emitted SDK binary assets: ${leakedAssets.join(', ')}`);

    let smoke;
    try {
      const out = execFileSync(process.execPath, [path.join(outDir, 'claude-sdk-smoke.js'), FAKE_CLAUDE], {
        cwd: outDir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      smoke = JSON.parse(out.trim().split('\n').pop());
      for (const kind of ['initialized', 'session_started', 'message', 'turn_ended', 'session_ended']) {
        if (!smoke.kinds.includes(kind)) failures.push(`Bundled SDK smoke run saw no ${kind} event (saw: ${smoke.kinds.join(', ')})`);
      }
    } catch (err) {
      failures.push(`Bundled SDK smoke run failed: ${err.stderr || err.message}`);
    }

    return { report: { limitBytes: LIMIT_BYTES, sdkBytes, mainEntryBytes: mainBytes, smoke }, failures };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { report, failures } = await checkClaudeSdkChunk();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.sdkBytes !== undefined) {
    console.log(`${SDK_CHUNK}: ${fmt(report.sdkBytes)} (limit ${fmt(LIMIT_BYTES)}); main entry: ${fmt(report.mainEntryBytes)}`);
    if (report.smoke) console.log(`smoke events: ${report.smoke.kinds.join(' ')}`);
  }
  for (const f of failures) console.error(`::error::${f}`);
  if (failures.length) process.exitCode = 1;
}
