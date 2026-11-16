#!/usr/bin/env node
/**
 * Builds the fingerprints of every version Clubhouse ever shipped of each
 * built-in persona's text (#3579), from git history:
 *
 *   node scripts/persona-copy-fingerprints.mjs           # check only
 *   node scripts/persona-copy-fingerprints.mjs --write   # update the table
 *
 * The old "Config changes detected" → Save to Clubhouse loop appended the
 * persona to an agent's instructions at every save, so a block brought over
 * by the switch to managed can hold many copies, each of the persona as it
 * was at that save. persona-copies.ts finds them by these fingerprints: the
 * text's first line, its length and its SHA-256, for the text with front
 * matter removed (as the persona runtime appended it), with LF and with CRLF
 * line endings. No persona text is stored, only its fingerprint.
 *
 * It reads every commit of HEAD that touched a persona file, following
 * renames. A shallow clone (CI) can't see that history: check mode then says
 * so and exits 0, and the test checks only the committed table's format.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TABLE_PATH = path.join(ROOT, 'src/main/services/managed-agents/persona-copy-fingerprints.json');

/** Persona id → its name in the old persona picker and the files its text lived in, oldest path first. */
export const PERSONA_SOURCES = {
  'orchestrator': { name: 'Orchestrator', files: ['src/renderer/features/personas/orchestrator.md', 'src/main/services/managed-agents/builtin-text/orchestrator.md'] },
  'project-manager': { name: 'Project Manager', files: ['src/renderer/features/personas/project-manager.md', 'src/main/services/managed-agents/builtin-text/project-manager.md'] },
  'group-project-pm': { name: 'Group Project PM', files: ['src/renderer/features/personas/group-project-pm.md', 'src/main/services/managed-agents/builtin-text/group-project-lead.md'] },
  'qa': { name: 'Quality Assurance', files: ['src/renderer/features/personas/qa.md', 'src/main/services/managed-agents/builtin-text/quality-assurance.md'] },
  'executor-merge': { name: 'Executor (Full Merge)', files: ['src/renderer/features/personas/executor-merge.md', 'src/main/services/managed-agents/builtin-text/developer-full-merge.md'] },
  'executor-pr-only': { name: 'Executor (PR Only)', files: ['src/renderer/features/personas/executor-pr-only.md', 'src/main/services/managed-agents/builtin-text/developer-no-merge.md'] },
  'researcher': { name: 'Researcher', files: ['src/renderer/features/personas/researcher.md', 'src/main/services/managed-agents/builtin-text/researcher.md'] },
  'judge': { name: 'Judge', files: ['src/renderer/features/personas/judge.md', 'src/main/services/managed-agents/builtin-text/code-reviewer.md'] },
  'workhorse': { name: 'Workhorse', files: ['src/renderer/features/personas/workhorse.md', 'src/main/services/managed-agents/builtin-text/helper.md'] },
  'ui-lead': { name: 'UI/Design Lead', files: ['src/renderer/features/personas/ui-lead.md', 'src/main/services/managed-agents/legacy-persona-text/ui-lead.md'] },
  'quality-auditor': { name: 'Quality Auditor', files: ['src/renderer/features/personas/quality-auditor.md', 'src/main/services/managed-agents/legacy-persona-text/quality-auditor.md'] },
  'doc-updater': { name: 'Documentation Updater', files: ['src/renderer/features/personas/doc-updater.md', 'src/main/services/managed-agents/legacy-persona-text/doc-updater.md'] },
};

/** The same front matter rule as src/shared/front-matter.ts. */
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)+/;
const stripFrontMatter = (raw) => { const m = raw.match(FRONT_MATTER_RE); return m ? raw.slice(m[0].length) : raw; };

/** One text's fingerprint, as persona-copies.ts computes it. */
export function fingerprint(text) {
  return { first: text.split(/\r?\n/, 1)[0], length: text.length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function isShallow() {
  return git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
}

/** Every text a file ever had in HEAD's history, following renames. */
function textsOf(file) {
  const out = git(['log', '--follow', '--format=commit %H', '--name-only', 'HEAD', '--', file]);
  const texts = [];
  let commit = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('commit ')) { commit = line.slice(7); continue; }
    if (!line.trim() || !commit) continue;
    try {
      texts.push(git(['show', `${commit}:${line.trim()}`]));
    } catch {
      // The file was deleted in that commit: nothing to read there.
    }
  }
  return texts;
}

/** The table, built from git history. */
export function buildTable() {
  const personas = {};
  for (const [id, source] of Object.entries(PERSONA_SOURCES)) {
    const seen = new Map();
    for (const file of source.files) {
      for (const raw of textsOf(file)) {
        const body = stripFrontMatter(raw.replace(/\r\n/g, '\n'));
        if (!body.trim()) continue;
        for (const text of [body, body.replace(/\n/g, '\r\n')]) {
          const f = fingerprint(text);
          seen.set(f.sha256, f);
        }
      }
    }
    const versions = [...seen.values()].sort((a, b) => a.length - b.length || a.sha256.localeCompare(b.sha256));
    personas[id] = { name: source.name, versions };
  }
  return {
    $comment: "Generated by scripts/persona-copy-fingerprints.mjs from git history (#3579). Don't edit by hand: run it with --write.",
    personas,
  };
}

export const serialize = (table) => `${JSON.stringify(table, null, 2)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (isShallow()) {
    console.log('A shallow clone has no persona history: nothing to check. Fetch the full history to regenerate.');
    process.exit(0);
  }
  const next = serialize(buildTable());
  if (process.argv.includes('--write')) {
    writeFileSync(TABLE_PATH, next);
    console.log(`Wrote ${path.relative(ROOT, TABLE_PATH)}`);
  } else {
    let current = '';
    try { current = readFileSync(TABLE_PATH, 'utf8'); } catch { /* missing table: it differs */ }
    if (current !== next) {
      console.error(`${path.relative(ROOT, TABLE_PATH)} is out of date. Run: node scripts/persona-copy-fingerprints.mjs --write`);
      process.exit(1);
    }
    console.log('The persona fingerprints are up to date.');
  }
}
