#!/usr/bin/env node
// Checks (or upgrades) the vendored ACP stable-v1 schema in
// src/main/chat/acp/schema against the public npm package it came from.
// Provenance and the recorded hashes are in schema/PROVENANCE.md.
//
//   node scripts/acp-schema-pin.mjs                          # check the pinned version
//   node scripts/acp-schema-pin.mjs --version 2.10.0 --write # vendor another version
//
// It only downloads the tarball (`npm pack --ignore-scripts` into a temp dir)
// and reads two files from it: nothing is installed, no package script runs,
// and node_modules is never touched. Needs network access to the npm registry.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@agentclientprotocol/sdk';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = path.join(repoRoot, 'src', 'main', 'chat', 'acp', 'schema');
const provenanceFile = path.join(schemaDir, 'PROVENANCE.md');
const FILES = [
  { inTarball: 'package/schema/v1/schema.json', vendored: 'schema.v1.json' },
  { inTarball: 'package/LICENSE', vendored: 'LICENSE' },
];

const args = process.argv.slice(2);
const write = args.includes('--write');
const versionFlag = args.indexOf('--version');
const provenance = fs.readFileSync(provenanceFile, 'utf8');
const pinned = /\| Version \| `([^`]+)` \|/.exec(provenance)?.[1];
const version = versionFlag >= 0 ? args[versionFlag + 1] : pinned;
if (!version) throw new Error('No version: pass --version <x.y.z>');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const sha = (algo, bytes, enc = 'hex') => createHash(algo).update(bytes).digest(enc);

const meta = JSON.parse(execFileSync(npm, ['view', `${PACKAGE}@${version}`, 'dist', 'gitHead', 'license', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-schema-'));
try {
  execFileSync(npm, ['pack', `${PACKAGE}@${version}`, '--ignore-scripts', '--silent', '--pack-destination', dir], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  const tarball = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.tgz')));
  const tgz = fs.readFileSync(tarball);
  const problems = [];
  if (sha('sha1', tgz) !== meta.dist.shasum) problems.push('tarball sha1 differs from the registry dist.shasum');
  if (`sha512-${sha('sha512', tgz, 'base64')}` !== meta.dist.integrity) problems.push('tarball sha512 differs from the registry dist.integrity');
  if (meta.license !== 'Apache-2.0') problems.push(`license is ${meta.license}, not Apache-2.0`);

  const out = path.join(dir, 'x');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xzf', tarball, '-C', out, ...FILES.map((f) => f.inTarball)]);
  const rows = [];
  for (const f of FILES) {
    const bytes = fs.readFileSync(path.join(out, f.inTarball));
    rows.push(`| \`${f.vendored}\` sha256 | \`${sha('sha256', bytes)}\` |`);
    const target = path.join(schemaDir, f.vendored);
    if (write) fs.writeFileSync(target, bytes);
    else if (!fs.readFileSync(target).equals(bytes)) problems.push(`${f.vendored} differs from ${f.inTarball} in ${PACKAGE}@${version}`);
  }

  console.log([
    `${PACKAGE}@${version}`,
    `| Version | \`${version}\` |`,
    `gitHead ${meta.gitHead}`,
    `| Tarball sha1 (registry \`dist.shasum\`) | \`${meta.dist.shasum}\` |`,
    `| Tarball integrity (registry \`dist.integrity\`) | \`${meta.dist.integrity}\` |`,
    ...rows,
  ].join('\n'));
  if (!write) {
    for (const row of [`| Version | \`${version}\` |`, `| Tarball sha1 (registry \`dist.shasum\`) | \`${meta.dist.shasum}\` |`, ...rows]) {
      if (!provenance.includes(row)) problems.push(`PROVENANCE.md lacks: ${row}`);
    }
    if (!provenance.includes(meta.gitHead)) problems.push(`PROVENANCE.md lacks gitHead ${meta.gitHead}`);
  }
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(write ? 'Vendored. Update PROVENANCE.md from the lines above, then run the pin test.' : 'Vendored schema matches the pinned package.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
