#!/usr/bin/env node

/**
 * compute-sdk-hash.mjs — SDK surface integrity hash tool
 *
 * Usage:
 *   node scripts/compute-sdk-hash.mjs verify          # CI mode: fails on any mismatch
 *   node scripts/compute-sdk-hash.mjs update legacy    # Update the legacy hash
 *   node scripts/compute-sdk-hash.mjs update v0.9      # Update a version hash
 *   node scripts/compute-sdk-hash.mjs update all       # Update all hashes
 *   node scripts/compute-sdk-hash.mjs status           # Show current hash status
 *
 * Hash targets:
 *   legacy  — SHA-256 of src/shared/plugin-types.ts (covers v0.5–v0.8 surface)
 *   v0.9+   — SHA-256 of src/shared/sdk-surfaces/<version>.surface.ts
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HASHES_DIR = resolve(ROOT, 'src/shared/sdk-hashes');
const SURFACES_DIR = resolve(ROOT, 'src/shared/sdk-surfaces');
const LEGACY_SOURCE = resolve(ROOT, 'src/shared/plugin-types.ts');

function sha256(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

function readStoredHash(hashFile) {
  if (!existsSync(hashFile)) return null;
  return readFileSync(hashFile, 'utf-8').trim().split(/\s+/)[0];
}

function writeHash(hashFile, hash, sourceRelative) {
  writeFileSync(hashFile, `${hash}  ${sourceRelative}\n`);
}

/**
 * Build a map of all hash targets: { name → { sourceFile, hashFile } }
 */
function discoverTargets() {
  const targets = new Map();

  // Legacy target: entire plugin-types.ts
  targets.set('legacy', {
    sourceFile: LEGACY_SOURCE,
    hashFile: resolve(HASHES_DIR, 'legacy.sha256'),
    sourceRelative: 'src/shared/plugin-types.ts',
  });

  // Per-version targets: each *.surface.ts in sdk-surfaces/
  if (existsSync(SURFACES_DIR)) {
    for (const entry of readdirSync(SURFACES_DIR)) {
      const match = entry.match(/^(v[\d.]+)\.surface\.ts$/);
      if (match) {
        const version = match[1];
        targets.set(version, {
          sourceFile: resolve(SURFACES_DIR, entry),
          hashFile: resolve(HASHES_DIR, `${version}.sha256`),
          sourceRelative: `src/shared/sdk-surfaces/${entry}`,
        });
      }
    }
  }

  return targets;
}

function verify() {
  const targets = discoverTargets();
  let failures = 0;

  for (const [name, { sourceFile, hashFile, sourceRelative }] of targets) {
    const stored = readStoredHash(hashFile);
    if (!stored) {
      console.error(`\x1b[31m✗ ${name}\x1b[0m — no hash file at ${hashFile}`);
      failures++;
      continue;
    }

    const actual = sha256(sourceFile);
    if (actual !== stored) {
      console.error(`\x1b[31m✗ ${name}\x1b[0m — hash mismatch for ${sourceRelative}`);
      console.error(`  stored:  ${stored}`);
      console.error(`  actual:  ${actual}`);
      console.error('');
      console.error(`  If this change is intentional, update the hash:`);
      console.error(`    node scripts/compute-sdk-hash.mjs update ${name}`);
      console.error('');
      failures++;
    } else {
      console.log(`\x1b[32m✓ ${name}\x1b[0m — ${sourceRelative}`);
    }
  }

  if (failures > 0) {
    console.error('');
    console.error(`${failures} hash check(s) failed.`);
    console.error('If the change is to a stable/deprecated version, follow the patch process');
    console.error('in docs/sdk-versioning.md before updating the hash.');
    process.exit(1);
  }

  console.log('');
  console.log('All SDK surface hashes verified.');
}

function update(targetName) {
  const targets = discoverTargets();

  const toUpdate = targetName === 'all'
    ? [...targets.entries()]
    : targets.has(targetName)
      ? [[targetName, targets.get(targetName)]]
      : null;

  if (!toUpdate) {
    console.error(`Unknown target: ${targetName}`);
    console.error(`Available targets: ${[...targets.keys()].join(', ')}, all`);
    process.exit(1);
  }

  for (const [name, { sourceFile, hashFile, sourceRelative }] of toUpdate) {
    const hash = sha256(sourceFile);
    writeHash(hashFile, hash, sourceRelative);
    console.log(`\x1b[32m✓ ${name}\x1b[0m — updated (${hash.slice(0, 12)}…)`);
  }
}

function status() {
  const targets = discoverTargets();

  for (const [name, { sourceFile, hashFile, sourceRelative }] of targets) {
    const stored = readStoredHash(hashFile);
    const actual = sha256(sourceFile);

    if (!stored) {
      console.log(`\x1b[33m? ${name}\x1b[0m — no hash file (${sourceRelative})`);
    } else if (actual === stored) {
      console.log(`\x1b[32m✓ ${name}\x1b[0m — clean (${sourceRelative})`);
    } else {
      console.log(`\x1b[31m✗ ${name}\x1b[0m — modified (${sourceRelative})`);
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────

const [command, arg] = process.argv.slice(2);

switch (command) {
  case 'verify':
    verify();
    break;
  case 'update':
    if (!arg) {
      console.error('Usage: compute-sdk-hash.mjs update <target|all>');
      console.error('Targets: legacy, v0.9, ..., all');
      process.exit(1);
    }
    update(arg);
    break;
  case 'status':
    status();
    break;
  default:
    console.error('Usage:');
    console.error('  compute-sdk-hash.mjs verify          Check all hashes (CI mode)');
    console.error('  compute-sdk-hash.mjs update <target>  Update a hash (legacy, v0.9, all)');
    console.error('  compute-sdk-hash.mjs status           Show hash status');
    process.exit(1);
}
