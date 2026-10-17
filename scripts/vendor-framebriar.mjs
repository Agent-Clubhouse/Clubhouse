#!/usr/bin/env node
/**
 * Vendors the Framebriar Node/Electron SDK (github.com/masra91/framebriar)
 * into src/main/vendor/framebriar/, keeping its relative layout, and pins it.
 *
 *   node scripts/vendor-framebriar.mjs --from ~/source/framebriar [--commit <sha>]
 *       Copy the files at <sha> (default: the checkout's HEAD) and rewrite the manifest.
 *   node scripts/vendor-framebriar.mjs --check [--from ~/source/framebriar]
 *       Fail if a vendored file was edited locally (hash differs from the manifest), or,
 *       with --from, if the pinned commit's files differ from what's vendored.
 *
 * The files are the ones adapters/node/README.md lists: adapters/node/*.mjs,
 * adapters/browser/telemetry.mjs (pure helpers), adapters/browser/otel-exporter.mjs and
 * src/protocol.mjs. They have no npm dependencies and are never edited here; the
 * Clubhouse-owned typings next to them (adapters/node/index.d.mts) aren't vendored.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = path.join(root, 'src/main/vendor/framebriar');
export const MANIFEST = path.join(VENDOR_DIR, 'VENDORED.json');
const REPO = 'https://github.com/masra91/framebriar';
const EXTRA = ['adapters/browser/telemetry.mjs', 'adapters/browser/otel-exporter.mjs', 'src/protocol.mjs'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

function filesAt(src, commit) {
  const listed = git(src, 'ls-tree', '--name-only', commit, 'adapters/node/').toString('utf8').split('\n').filter(Boolean);
  const node = listed.filter((f) => f.endsWith('.mjs'));
  if (node.length === 0) throw new Error(`No adapters/node/*.mjs at ${commit}`);
  return [...node, ...EXTRA].sort();
}

function readAt(src, commit, file) {
  return git(src, 'show', `${commit}:${file}`);
}

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

/** Local integrity: every manifest file exists and matches its recorded hash; no extra .mjs files. */
export function checkLocal() {
  const manifest = readManifest();
  const problems = [];
  for (const [file, hash] of Object.entries(manifest.files)) {
    const p = path.join(VENDOR_DIR, file);
    if (!existsSync(p)) problems.push(`missing ${file}`);
    else if (sha256(readFileSync(p)) !== hash) problems.push(`edited locally: ${file}`);
  }
  return { manifest, problems };
}

/** Upstream drift: the pinned commit's files equal what's vendored. */
export function checkUpstream(src) {
  const { manifest, problems } = checkLocal();
  const files = filesAt(src, manifest.commit);
  const vendored = Object.keys(manifest.files).sort();
  if (JSON.stringify(files) !== JSON.stringify(vendored)) problems.push(`file list differs from ${manifest.commit}: ${files.join(', ')}`);
  for (const file of files) {
    if (manifest.files[file] && sha256(readAt(src, manifest.commit, file)) !== manifest.files[file]) problems.push(`differs from upstream: ${file}`);
  }
  return { manifest, problems };
}

function vendor(src, commit) {
  const sha = git(src, 'rev-parse', commit).toString('utf8').trim();
  const files = filesAt(src, sha);
  // Drop files the previous pin vendored that the new one doesn't. Clubhouse-owned
  // files next to them (the *.d.mts typings) are left alone.
  const previous = existsSync(MANIFEST) ? Object.keys(readManifest().files) : [];
  for (const file of previous) if (!files.includes(file)) rmSync(path.join(VENDOR_DIR, file), { force: true });
  const hashes = {};
  for (const file of files) {
    const bytes = readAt(src, sha, file);
    const out = path.join(VENDOR_DIR, file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    hashes[file] = sha256(bytes);
  }
  const manifest = { repo: REPO, commit: sha, vendoredAt: new Date().toISOString().slice(0, 10), files: hashes };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = arg('--from')?.replace(/^~(?=\/)/, process.env.HOME ?? '~');
  if (process.argv.includes('--check')) {
    const { manifest, problems } = from ? checkUpstream(from) : checkLocal();
    for (const p of problems) console.error(`::error::framebriar vendor: ${p}`);
    if (problems.length) process.exitCode = 1;
    else console.log(`framebriar vendor OK at ${manifest.commit}${from ? ' (matches upstream)' : ''}`);
  } else {
    if (!from) throw new Error('--from <framebriar checkout> is required to vendor');
    const manifest = vendor(from, arg('--commit') ?? 'HEAD');
    console.log(`Vendored ${Object.keys(manifest.files).length} files from ${manifest.commit}`);
  }
}
