#!/usr/bin/env node
/**
 * Packaging guard for the Copilot SDK (docs/copilot-sdk-driver.md, "packaging
 * spike"). Builds the main-process bundle with the production webpack config,
 * with the SDK loader made reachable from the main entry, and checks that:
 *
 *  - the SDK is emitted as its own lazy chunk (`copilot-sdk`), so the main
 *    entry chunk contains no SDK code, and that chunk stays under the limit;
 *  - nothing from the SDK's per-platform runtime packages (~130 MB each) and
 *    no native asset (koffi's FFI binaries) is emitted;
 *  - the bundled chunk actually runs: a smoke entry built from the same config
 *    spawns the given `copilot` (by default the fake server in __fixtures__)
 *    through RuntimeConnection.forStdio and completes the protocol handshake,
 *    from a temp dir with no node_modules to fall back on.
 *
 * Usage: node scripts/check-copilot-sdk-chunk.mjs [--json] [--copilot <path>]
 * `--copilot $(which copilot)` runs the smoke against a real install; it only
 * handshakes (connect + status.get), creates no session and sends no prompt.
 * CI runs it through scripts/check-copilot-sdk-chunk.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadMainConfig } from './check-claude-sdk-chunk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMIT_BYTES = 1024 * 1024;
const SDK_CHUNK = 'copilot-sdk';
const SDK_LOADER = './src/main/chat/copilot/sdk-loader.js';
const SMOKE_ENTRY = './src/main/chat/copilot/__fixtures__/sdk-bundle-smoke.ts';
const FAKE_COPILOT = path.join(root, 'src/main/chat/copilot/__fixtures__/fake-copilot-server.js');

const fmt = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

/** Returns { report, failures }; failures is empty when every check passes. */
export async function checkCopilotSdkChunk({ copilot = FAKE_COPILOT } = {}) {
  const mainConfig = loadMainConfig();
  const outDir = mkdtempSync(path.join(tmpdir(), 'clubhouse-copilot-sdk-chunk-'));
  const config = {
    ...mainConfig,
    context: root,
    mode: 'production',
    target: 'electron-main',
    devtool: false,
    entry: {
      // Nothing in the app loads the SDK yet; add the loader so this checks
      // the bundle as it will be once a driver does.
      main: [mainConfig.entry, SDK_LOADER],
      'copilot-sdk-smoke': SMOKE_ENTRY,
    },
    output: { path: outDir, filename: '[name].js', chunkFilename: '[name].js' },
    plugins: [],
  };
  try {
    const stats = await build(config);
    const json = stats.toJson({ all: false, ids: true, assets: true, chunks: true, chunkGroups: true, warnings: true });
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
    const { compilation } = stats;
    const { chunkGraph } = compilation;
    const sdkModule = /node_modules[\\/](@github[\\/]copilot-sdk|koffi|vscode-jsonrpc|zod)[\\/]/;
    // webpack may split the SDK's dependencies into shared lazy chunks; count
    // every non-entry chunk that holds SDK code, not just the named one.
    const sdkChunkIds = new Set(group.chunks.filter((id) => !mainEntryIds.has(id)));
    for (const chunk of compilation.chunks) {
      if (mainEntryIds.has(chunk.id)) continue;
      for (const m of chunkGraph.getChunkModulesIterable(chunk)) {
        if ((m.modules ?? [m]).some((inner) => inner.resource && sdkModule.test(inner.resource))) {
          sdkChunkIds.add(chunk.id);
          break;
        }
      }
    }
    const sdkIds = [...sdkChunkIds];
    const sdkBytes = sdkIds.reduce((sum, id) => sum + chunkBytes(id), 0);
    const sdkChunks = sdkIds.map((id) => ({ files: chunkById.get(id).files, bytes: chunkBytes(id) }));
    const mainBytes = [...mainEntryIds].reduce((sum, id) => sum + chunkBytes(id), 0);
    if (sdkBytes > LIMIT_BYTES) failures.push(`Copilot SDK chunks total ${fmt(sdkBytes)}, over the ${fmt(LIMIT_BYTES)} limit`);

    const entryChunks = new Set(compilation.entrypoints.get('main').chunks);
    for (const m of compilation.modules) {
      for (const inner of m.modules ?? [m]) {
        // zod and vscode-jsonrpc may legitimately be used elsewhere in main.
        if (!inner.resource || !/node_modules[\\/](@github[\\/]copilot-sdk|koffi)[\\/]/.test(inner.resource)) continue;
        if ([...chunkGraph.getModuleChunks(m)].some((c) => entryChunks.has(c))) {
          failures.push(`Main entry chunk contains Copilot SDK code (${inner.resource})`);
        }
      }
    }

    const leakedAssets = json.assets.map((a) => a.name).filter((n) => /copilot-sdk-(darwin|linux|win32)|koffi|native_modules|\.node$/.test(n));
    if (leakedAssets.length) failures.push(`Bundle emitted SDK runtime or native assets: ${leakedAssets.join(', ')}`);

    let smoke;
    try {
      const out = execFileSync(process.execPath, [path.join(outDir, 'copilot-sdk-smoke.js'), copilot], {
        cwd: outDir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      smoke = JSON.parse(out.trim().split('\n').pop());
      if (!smoke.connected) failures.push('Bundled SDK smoke run did not connect');
    } catch (err) {
      failures.push(`Bundled SDK smoke run failed: ${err.stderr || err.message}`);
    }

    return {
      report: {
        limitBytes: LIMIT_BYTES,
        sdkBytes,
        mainEntryBytes: mainBytes,
        sdkChunks,
        warnings: (json.warnings ?? []).map((w) => (typeof w === 'string' ? w : w.message).split('\n')[0]),
        smoke,
      },
      failures,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--copilot');
  const { report, failures } = await checkCopilotSdkChunk(i > 0 ? { copilot: process.argv[i + 1] } : {});
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.sdkBytes !== undefined) {
    console.log(`${SDK_CHUNK}: ${fmt(report.sdkBytes)} (limit ${fmt(LIMIT_BYTES)}); main entry: ${fmt(report.mainEntryBytes)}`);
    if (report.smoke) console.log(`smoke: ${JSON.stringify(report.smoke)}`);
  }
  for (const f of failures) console.error(`::error::${f}`);
  if (failures.length) process.exitCode = 1;
}
