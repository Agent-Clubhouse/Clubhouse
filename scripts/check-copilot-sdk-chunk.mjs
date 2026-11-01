#!/usr/bin/env node
/**
 * Packaging guard for the GitHub Copilot SDK (docs/copilot-sdk-driver.md,
 * "Packaging"). Builds the main-process bundle with the production webpack
 * config, with the SDK loader made reachable from the main entry, and checks that:
 *
 *  - the SDK is emitted as its own lazy chunk (`github-copilot-sdk`), so the main
 *    entry chunk contains no SDK code, and that chunk stays under 1 MB;
 *  - no CLI or native binary is emitted: not the SDK's per-platform runtime
 *    (~159 MB), and not `koffi` or its prebuilt binaries;
 *  - the bundled chunk actually runs: a smoke entry built from the same config
 *    completes a handshake and creates a session against the runtime in
 *    node_modules, from a temp dir with no node_modules to fall back on, under
 *    plain Node and under Electron's Node.
 *
 * The smoke never sends a prompt. It runs with a throwaway home and with every
 * COPILOT_*, GH_* and GITHUB_* variable removed, so no paid request is possible.
 *
 * Usage: node scripts/check-copilot-sdk-chunk.mjs [--json] [--require-electron]
 * Without --require-electron, an Electron binary that isn't installed skips that run
 * and says so; with it, the binary is downloaded if needed, and failing to get it fails.
 * CI runs it in the `copilot-sdk-chunk` job of .github/workflows/validate.yml.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMIT_BYTES = 1024 * 1024;
const SDK_CHUNK = 'github-copilot-sdk';
const SDK_LOADER = './src/main/chat/copilot/sdk-loader.js';
const SMOKE_ENTRY = './src/main/chat/copilot/__fixtures__/sdk-bundle-smoke.ts';
const SMOKE_BUNDLE = 'sdk-bundle-smoke.js';

/** Emitted files that mean a CLI or native binary reached the build. */
const LEAKED_ASSET = /copilot-sdk-|copilot-runtime|koffi|msalruntime|OneAuth|native_modules|\.(node|exe|dll|dylib|so)$/i;
/** Bundled modules that should never be reachable from the SDK's chunk. */
const LEAKED_MODULE = /node_modules[\\/](koffi[\\/]|@koromix[\\/]|@github[\\/]copilot-sdk-)/;

export const findLeakedAssets = (names) => names.filter((n) => LEAKED_ASSET.test(n));
export const findLeakedModules = (resources) => resources.filter((r) => LEAKED_MODULE.test(r));

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

/** The runtime the SDK would pick itself, which npm ci installs for this platform. */
function findRuntime() {
  const platform = `${process.platform}-${process.arch}`;
  const binary = process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
  const runtime = path.join(root, 'node_modules', '@github', `copilot-sdk-${platform}`, 'prebuilds', platform, binary);
  if (!existsSync(runtime)) return undefined;
  // The SDK makes it executable the same way when it picks this file itself.
  if (process.platform !== 'win32') chmodSync(runtime, 0o755);
  return runtime;
}

/**
 * The Electron binary's path, or undefined if it isn't available. Requiring the
 * `electron` package downloads a missing binary, so only do that when asked to.
 */
function findElectron(requireElectron) {
  const dir = path.join(root, 'node_modules', 'electron');
  if (!requireElectron) {
    const pathFile = path.join(dir, 'path.txt');
    const binary = existsSync(pathFile) ? path.join(dir, 'dist', readFileSync(pathFile, 'utf8')) : undefined;
    return binary && existsSync(binary) ? binary : undefined;
  }
  try {
    return require(dir);
  } catch {
    return undefined;
  }
}

/** A throwaway home and no credentials: nothing to log in with, nothing real to write to. */
function smokeEnv(home, extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COPILOT_|GH_|GITHUB_|ELECTRON_RUN_AS_NODE$)/i.test(k)));
  const dirs = Object.fromEntries(['AppData', 'LocalAppData', 'cache', 'config', 'data'].map((d) => [d, path.join(home, d)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: dirs.AppData,
    LOCALAPPDATA: dirs.LocalAppData,
    XDG_CACHE_HOME: dirs.cache,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    COPILOT_HOME: path.join(home, '.copilot'),
    ...extra,
  };
}

function runSmoke({ label, exec, bundle, runtime, cwd, home, extraEnv, failures }) {
  try {
    const out = execFileSync(exec, [bundle, runtime], { cwd, env: smokeEnv(home, extraEnv), encoding: 'utf8', timeout: 90_000 });
    const smoke = JSON.parse(out.trim().split('\n').pop());
    if (!smoke.version || !smoke.protocolVersion) failures.push(`${label}: the runtime reported no version (${out.trim()})`);
    if (!smoke.sessionId) failures.push(`${label}: no session was created (${out.trim()})`);
    if (smoke.authenticated !== false) failures.push(`${label}: the runtime found a login, so the smoke isn't isolated (${out.trim()})`);
    return smoke;
  } catch (err) {
    failures.push(`${label} failed: ${err.stderr || err.message}`);
    return undefined;
  }
}

/** Returns { report, failures }; failures is empty when every check passes. */
export async function checkCopilotSdkChunk({ requireElectron = false } = {}) {
  const mainConfig = loadMainConfig();
  const outDir = mkdtempSync(path.join(tmpdir(), 'clubhouse-copilot-sdk-chunk-'));
  const config = {
    ...mainConfig,
    context: root,
    mode: 'production',
    target: 'electron-main',
    devtool: false,
    entry: {
      // Nothing in the app imports the loader yet; add it so this checks the
      // bundle as it will be once the driver does.
      main: [mainConfig.entry, SDK_LOADER],
      [path.basename(SMOKE_BUNDLE, '.js')]: SMOKE_ENTRY,
    },
    output: { path: path.join(outDir, 'bundle'), filename: '[name].js', chunkFilename: '[name].js' },
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
    const sdkModule = /node_modules[\\/]@github[\\/]copilot-sdk[\\/]/;
    const resources = [];
    for (const m of compilation.modules) {
      for (const inner of m.modules ?? [m]) {
        if (!inner.resource) continue;
        resources.push(inner.resource);
        if (sdkModule.test(inner.resource) && [...chunkGraph.getModuleChunks(m)].some((c) => entryChunks.has(c))) {
          failures.push(`Main entry chunk contains Copilot SDK code (${inner.resource})`);
        }
      }
    }

    const leakedAssets = findLeakedAssets(json.assets.map((a) => a.name));
    if (leakedAssets.length) failures.push(`Bundle emitted CLI or native assets: ${leakedAssets.join(', ')}`);
    const leakedModules = findLeakedModules(resources);
    if (leakedModules.length) failures.push(`Bundle contains modules it shouldn't: ${leakedModules.join(', ')}`);

    const report = { limitBytes: LIMIT_BYTES, sdkBytes, mainEntryBytes: mainBytes };
    const runtime = findRuntime();
    if (!runtime) {
      failures.push(`No @github/copilot-sdk-${process.platform}-${process.arch} in node_modules, so the bundled smoke can't run. Was it installed with optional dependencies?`);
      return { report, failures };
    }

    const smokeArgs = { bundle: path.join(outDir, 'bundle', SMOKE_BUNDLE), runtime, cwd: outDir, failures };
    report.node = runSmoke({ ...smokeArgs, label: 'Bundled SDK smoke under Node', exec: process.execPath, home: path.join(outDir, 'home-node') });

    const electron = findElectron(requireElectron);
    if (electron) {
      report.electron = runSmoke({
        ...smokeArgs,
        label: "Bundled SDK smoke under Electron's Node",
        exec: electron,
        home: path.join(outDir, 'home-electron'),
        extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      });
      if (report.electron && !report.electron.electron) failures.push(`The Electron smoke ran under plain Node: ${JSON.stringify(report.electron)}`);
    } else if (requireElectron) {
      failures.push('No Electron binary in node_modules, so the Electron smoke could not run');
    } else {
      report.electron = 'skipped: no Electron binary';
    }

    return { report, failures };
  } finally {
    // The runtime can still be flushing logs; a leftover temp directory is harmless.
    try { rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { report, failures } = await checkCopilotSdkChunk({ requireElectron: process.argv.includes('--require-electron') });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.sdkBytes !== undefined) {
    console.log(`${SDK_CHUNK}: ${fmt(report.sdkBytes)} (limit ${fmt(LIMIT_BYTES)}); main entry: ${fmt(report.mainEntryBytes)}`);
    console.log(`Node smoke: ${JSON.stringify(report.node)}`);
    console.log(`Electron smoke: ${JSON.stringify(report.electron)}`);
  }
  for (const f of failures) console.error(`::error::${f}`);
  if (failures.length) process.exitCode = 1;
}
