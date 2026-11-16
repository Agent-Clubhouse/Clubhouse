import { describe, expect, it } from 'vitest';
import { copiesRemoved, findPersonaCopies, fingerprintOf, PERSONA_BUILTIN_BLOCK, removePersonaCopies, type PersonaFingerprintTable } from './persona-copies';
import { BUILTIN_BLOCK_IDS, BUILTIN_MANIFEST } from './builtins';
import { BUILTIN_TEXT } from './builtin-text/index';
import table from './persona-copy-fingerprints.json';

/** Two versions of one persona, as the loop appended them at two saves. */
const OLD = '# Orchestrator\n\nYou plan work and start helpers.\n\n## Plan\n\n1. Read the work.\n';
const NEW = '# Orchestrator\n\nYou plan work and start helpers.\n\n## Plan\n\n1. Read the work.\n2. Split it into tasks.\n';
const QA = '# Role: Quality Assurance\n\nYou review changes.\n';
const TABLE: PersonaFingerprintTable = {
  personas: {
    orchestrator: { name: 'Orchestrator', versions: [fingerprintOf(OLD), fingerprintOf(NEW)] },
    qa: { name: 'Quality Assurance', versions: [fingerprintOf(QA)] },
  },
};
const one = () => 'one' as const;
const none = () => 'none' as const;

describe('findPersonaCopies', () => {
  it('finds every copy of a persona, whichever shipped version each is', () => {
    const text = `My notes\n\n${OLD}\n${OLD}\n${NEW}`;
    const [found] = findPersonaCopies(text, TABLE);
    expect(found.personaId).toBe('orchestrator');
    expect(found.personaName).toBe('Orchestrator');
    expect(found.copies.map((c) => text.slice(c.start, c.end))).toEqual([OLD, OLD, NEW]);
  });

  it('lists only personas with two or more copies', () => {
    expect(findPersonaCopies(`${OLD}\n${QA}`, TABLE)).toEqual([]);
    expect(findPersonaCopies(`${QA}\n${QA}\n${OLD}`, TABLE).map((p) => p.personaId)).toEqual(['qa']);
  });

  it('leaves a block that only repeats a heading (the humble-bison case)', () => {
    const text = '## Project: expense-tracker\n\nBudget rules.\n\n## Project: expense-tracker\n\nReceipts.\n';
    expect(findPersonaCopies(text, TABLE)).toEqual([]);
    // The persona's own heading repeated, with the person's text under it, isn't a copy either.
    const headings = '# Orchestrator\n\nMy own plan.\n\n# Orchestrator\n\nMy own plan.\n';
    expect(findPersonaCopies(headings, TABLE)).toEqual([]);
  });

  it('counts only a copy that starts a line and is whole', () => {
    const edited = OLD.replace('Read the work.', 'Read the work twice.');
    expect(findPersonaCopies(`${edited}\n${OLD}`, TABLE)).toEqual([]);
    expect(findPersonaCopies(`> ${OLD}\n> ${OLD}`, TABLE)).toEqual([]);
  });

  it('finds CRLF copies with the shipped table', () => {
    const body = BUILTIN_TEXT['orchestrator.md'].replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const [found] = findPersonaCopies(`Notes\r\n\r\n${body}\r\n${body}`);
    expect(found.copies).toHaveLength(2);
  });

  it('finds today\'s built-in persona text with the shipped table', () => {
    const body = BUILTIN_TEXT['orchestrator.md'];
    const text = `Project rules\n\n${body}\n\n${body}\n\n${body}`;
    const [found] = findPersonaCopies(text);
    expect(found).toMatchObject({ personaId: 'orchestrator', personaName: 'Orchestrator' });
    expect(found.copies).toHaveLength(3);
  });
});

describe('removePersonaCopies', () => {
  it('keeps one copy and every byte of the person\'s text before, between and after', () => {
    const before = 'Project rules\n\nUse pnpm.\n\n';
    const between = 'Ask before merging.\n\n';
    const after = '\n## My own section\n\n  indented, kept exactly\n';
    const text = `${before}${OLD}\n${between}${OLD}\n${NEW}${after}`;
    const found = findPersonaCopies(text, TABLE);
    const next = removePersonaCopies(text, found, one);
    expect(next).toBe(`${before}${between}${NEW}${after}`);
    expect(copiesRemoved(found, one)).toBe(2);
    expect(findPersonaCopies(next, TABLE)).toEqual([]);
  });

  it('keeps none when the persona is delivered as its own block', () => {
    const before = 'Project rules\n\n';
    const between = 'Ask before merging.\n\n';
    const after = '## Mine\n';
    const text = `${before}${OLD}\n${between}${OLD}\n${NEW}\n${after}`;
    const found = findPersonaCopies(text, TABLE);
    expect(removePersonaCopies(text, found, none)).toBe(`${before}${between}${after}`);
    expect(copiesRemoved(found, none)).toBe(3);
  });

  it('collapses the clever-panda shape: the persona 21 times after the project text', () => {
    const text = `# Project\n\nRules.\n\n${Array.from({ length: 21 }, () => NEW).join('\n')}`;
    const found = findPersonaCopies(text, TABLE);
    expect(found[0].copies).toHaveLength(21);
    expect(removePersonaCopies(text, found, one)).toBe(`# Project\n\nRules.\n\n${NEW}`);
  });

  it('decides per persona', () => {
    const text = `${QA}\n${OLD}\n${QA}\n${OLD}`;
    const found = findPersonaCopies(text, TABLE);
    expect(removePersonaCopies(text, found, (id) => (id === 'qa' ? 'none' : 'one'))).toBe(OLD);
  });

  it('changes nothing with no copies found', () => {
    expect(removePersonaCopies('just text\n', [], one)).toBe('just text\n');
  });
});

describe('shipped data', () => {
  it('names built-in blocks that exist and are not retired', () => {
    const ids = new Set<string>(Object.values(BUILTIN_BLOCK_IDS));
    for (const id of Object.values(PERSONA_BUILTIN_BLOCK)) {
      expect(ids.has(id)).toBe(true);
      expect(BUILTIN_MANIFEST.blocks.find((b) => b.id === id)?.retired).toBeFalsy();
    }
  });

  it('has the orchestrator versions the loop copied (several shipped texts)', () => {
    const versions = (table as PersonaFingerprintTable).personas.orchestrator.versions;
    expect(versions.length).toBeGreaterThanOrEqual(4);
    for (const v of versions) expect(v.first).toBe('# Orchestrator');
  });
});
