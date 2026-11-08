import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

/**
 * The Dispatcher is two agents under one identity (#3036), and the one that
 * does the work is never named or shown. No string the app can show (UI text,
 * status lines, notifications, tool results, errors, help, and what either
 * agent is told) may mention a coordinator or a second session.
 *
 * Code may call it the coordinator in identifiers and comments; this reads
 * only string literals, template text and JSX text, plus the help pages and
 * the Dispatcher's instructions.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const SOURCE_DIRS = ['src/main', 'src/renderer', 'src/shared', 'src/preload'];
const TEXT_FILES_DIRS = ['src/renderer/features/help/content', 'src/main/services/dispatcher'];

/** Words that would name a second session. "phone book" is the agent cards' internal name (#3034). */
const FORBIDDEN = /\bcoordinators?\b|\b(?:second|hidden|background|two|other) (?:agent )?sessions?\b|\bphone ?book\b/i;

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__snapshots__') continue;
      walk(full, accept, out);
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

const isTest = (file: string) => /\.(test|spec)\.tsx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`) || file.includes(`${path.sep}test-utils${path.sep}`);

/** Every piece of text in a source file that could reach a person: not imports, identifiers or comments. */
function shownStrings(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    const parent = node.parent as ts.Node | undefined;
    const isModulePath = !!parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)
      || (ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'))));
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isModulePath) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the Dispatcher\'s hidden agent is never named (#3036)', () => {
  it('no string the app can show mentions a coordinator or a second session', () => {
    const files = SOURCE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), (f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !isTest(f)));
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      for (const { line, text } of shownStrings(file)) {
        seen.add(text.trim());
        if (FORBIDDEN.test(text)) hits.push(`${path.relative(ROOT, file)}:${line}: ${text.slice(0, 120)}`);
      }
    }
    expect(hits).toEqual([]);
    // It reads what it should: a tool refusal, a renderer status line and JSX text.
    expect(seen).toContain('Only the Dispatcher can use this tool.');
    expect(seen).toContain('Loading the Dispatcher');
    expect(seen).toContain('Retry');
  }, 60_000); // It parses every source file, which is slow on a loaded machine.

  it('no help page, and nothing either agent is told, mentions one either', () => {
    const files = TEXT_FILES_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), (f) => f.endsWith('.md')));
    expect(files.map((f) => path.basename(f))).toEqual(expect.arrayContaining(['dispatcher-instructions.md', 'dispatcher-chat-instructions.md']));
    const hits: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf-8').split('\n').forEach((text, i) => {
        if (FORBIDDEN.test(text)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${text.slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('catches the words it is for', () => {
    for (const text of ['Asking the coordinator…', 'The Coordinators', 'a hidden session', 'its second session', 'the phone book', 'two agent sessions']) {
      expect(FORBIDDEN.test(text), text).toBe(true);
    }
    for (const text of ['Asking what it does…', 'Coordinate, don\'t implement', 'one session', 'a new session']) {
      expect(FORBIDDEN.test(text), text).toBe(false);
    }
  });
});
