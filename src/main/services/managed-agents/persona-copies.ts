/**
 * Copies of a built-in persona repeated in a block (#3579). The retired
 * "Config changes detected" → Save to Clubhouse loop appended the agent's
 * persona to its instructions at every save, and the switch to managed kept
 * the result as the agent's own block, so a block can hold the persona many
 * times over, each copy as the persona read at that save.
 *
 * A copy is the whole text of a version Clubhouse shipped, starting at the
 * start of a line: persona-copy-fingerprints.json has every version's first
 * line, length and SHA-256 (scripts/persona-copy-fingerprints.mjs), and the
 * persona text Clubhouse ships now is added here. A repeated heading, or a
 * copy someone edited, is never a copy.
 *
 * Nothing here writes: the service offers removal and saves it as a new
 * revision of the block, which Undo or the catalog's revision history can
 * bring back.
 */
import { createHash } from 'crypto';
import fingerprintTable from './persona-copy-fingerprints.json';
import { BUILTIN_TEXT } from './builtin-text/index';
import uiLeadText from './legacy-persona-text/ui-lead.md';
import qualityAuditorText from './legacy-persona-text/quality-auditor.md';
import docUpdaterText from './legacy-persona-text/doc-updater.md';
import { stripFrontMatter } from '../../../shared/front-matter';

export interface PersonaFingerprint { first: string; length: number; sha256: string }
export interface PersonaFingerprintTable { personas: Record<string, { name: string; versions: PersonaFingerprint[] }> }

/** One persona found more than once in a text: where each copy is, in order. */
export interface PersonaCopies {
  personaId: string;
  personaName: string;
  copies: Array<{ start: number; end: number }>;
}

/** Whether removal keeps the last copy or none (the persona is delivered as its own block everywhere the block is used). */
export type PersonaCopiesKeep = 'one' | 'none';

/** The text each persona has in this build, by persona id: its built-in block's text, or the kept legacy text. */
const CURRENT_PERSONA_TEXT: Record<string, string | undefined> = {
  'orchestrator': BUILTIN_TEXT['orchestrator.md'],
  'project-manager': BUILTIN_TEXT['project-manager.md'],
  'group-project-pm': BUILTIN_TEXT['group-project-lead.md'],
  'qa': BUILTIN_TEXT['quality-assurance.md'],
  'executor-merge': BUILTIN_TEXT['developer-full-merge.md'],
  'executor-pr-only': BUILTIN_TEXT['developer-no-merge.md'],
  'researcher': BUILTIN_TEXT['researcher.md'],
  'judge': BUILTIN_TEXT['code-reviewer.md'],
  'workhorse': BUILTIN_TEXT['helper.md'],
  'ui-lead': uiLeadText,
  'quality-auditor': qualityAuditorText,
  'doc-updater': docUpdaterText,
};

/**
 * The built-in block that delivers the persona now, for personas whose block
 * is still installed. Retired blocks (D71) become the person's copies, so a
 * persona with one isn't listed: removal always keeps a copy of it.
 */
export const PERSONA_BUILTIN_BLOCK: Readonly<Record<string, string>> = {
  'orchestrator': 'builtin-block-orchestrator',
  'group-project-pm': 'builtin-block-group-project-lead',
  'qa': 'builtin-block-quality-assurance',
  'researcher': 'builtin-block-researcher',
  'workhorse': 'builtin-block-helper',
};

export function fingerprintOf(text: string): PersonaFingerprint {
  return { first: text.split(/\r?\n/, 1)[0], length: text.length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** The shipped table plus this build's persona text, with LF and CRLF endings. */
function withCurrentText(table: PersonaFingerprintTable): PersonaFingerprintTable {
  const personas: PersonaFingerprintTable['personas'] = {};
  for (const [id, entry] of Object.entries(table.personas)) {
    const versions = [...entry.versions];
    const current = CURRENT_PERSONA_TEXT[id];
    if (current) {
      const body = stripFrontMatter(current.replace(/\r\n/g, '\n'));
      for (const text of [body, body.replace(/\n/g, '\r\n')]) {
        const f = fingerprintOf(text);
        if (body.trim() && !versions.some((v) => v.sha256 === f.sha256)) versions.push(f);
      }
    }
    personas[id] = { name: entry.name, versions };
  }
  return { personas };
}

let shipped: PersonaFingerprintTable | null = null;
function shippedTable(): PersonaFingerprintTable {
  shipped ??= withCurrentText(fingerprintTable as PersonaFingerprintTable);
  return shipped;
}

/** Every persona found at least twice in `text`, by whole-text match only. */
export function findPersonaCopies(text: string, table: PersonaFingerprintTable = shippedTable()): PersonaCopies[] {
  // By first line, longest version first, so a version that another one starts with doesn't cut it short.
  const byFirst = new Map<string, Array<PersonaFingerprint & { personaId: string }>>();
  for (const [personaId, entry] of Object.entries(table.personas)) {
    for (const v of entry.versions) {
      if (!v.first || v.length <= v.first.length) continue;
      const list = byFirst.get(v.first) ?? [];
      list.push({ ...v, personaId });
      byFirst.set(v.first, list);
    }
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length);

  const found = new Map<string, Array<{ start: number; end: number }>>();
  let pos = 0;
  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos);
    const line = text.slice(pos, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, '');
    const match = byFirst.get(line)?.find((v) => pos + v.length <= text.length && fingerprintOf(text.slice(pos, pos + v.length)).sha256 === v.sha256);
    if (match) {
      const end = pos + match.length;
      const list = found.get(match.personaId) ?? [];
      list.push({ start: pos, end });
      found.set(match.personaId, list);
      // Carry on at the first line start at or after the copy's end.
      if (end >= text.length) break;
      if (text[end - 1] === '\n') { pos = end; continue; }
      const next = text.indexOf('\n', end);
      if (next === -1) break;
      pos = next + 1;
      continue;
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return [...found.entries()]
    .filter(([, copies]) => copies.length >= 2)
    .map(([personaId, copies]) => ({ personaId, personaName: table.personas[personaId].name, copies }));
}

/**
 * The text with duplicate copies removed: every copy but the last for a
 * persona kept once, every copy for one kept none. Each removed copy goes
 * with the line breaks right after it (the loop's separator). Everything else,
 * text before, between and after the copies, stays exactly as it was.
 */
export function removePersonaCopies(text: string, found: PersonaCopies[], keep: (personaId: string) => PersonaCopiesKeep): string {
  const spans = found
    .flatMap((p) => (keep(p.personaId) === 'none' ? p.copies : p.copies.slice(0, -1)))
    .sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start);
    at = span.end;
    while (text.startsWith('\r\n', at) || text[at] === '\n') at += text[at] === '\r' ? 2 : 1;
  }
  return out + text.slice(at);
}

/** How many copies removal takes out. */
export function copiesRemoved(found: PersonaCopies[], keep: (personaId: string) => PersonaCopiesKeep): number {
  return found.reduce((n, p) => n + p.copies.length - (keep(p.personaId) === 'none' ? 0 : 1), 0);
}
