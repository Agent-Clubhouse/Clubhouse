/**
 * #3356: every group project write goes through the host service. This scans
 * main-process source and fails on any write to the group project stores, or
 * any file write under group-projects/, outside the host and its stores.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MAIN = path.join(__dirname, '..');
const rel = (file: string) => path.relative(MAIN, file).split(path.sep).join('/');

/** The host and the stores only it uses. */
const STORE_FILES = new Set([
  'services/group-project-host.ts',
  'services/group-project-registry.ts',
  'services/group-project-bulletin.ts',
  'services/group-project-membership-file.ts',
  'services/group-project-json-file.ts',
  'services/group-project-paths.ts',
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' || entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

const RULES: Array<{ name: string; applies: (text: string) => boolean; pattern: RegExp }> = [
  {
    name: 'registry mutation',
    applies: (text) => text.includes('group-project-registry'),
    pattern: /groupProjectRegistry\s*\.\s*(create|update|delete|setScope|flush|_setForTesting)\s*\(/,
  },
  {
    name: 'board mutation',
    applies: (text) => text.includes('group-project-bulletin'),
    pattern: /(?<!groupProjectHost\s*)\.\s*(postMessage|deleteMessage|deleteTopic|setTopicProtected|setLimits|trimToLimits|clearAll|claimInbox|flush)\s*\(/,
  },
  {
    // Reads go through the host too, so a group project hidden by a delete stays unreadable.
    name: 'direct board access',
    applies: () => true,
    pattern: /\bgetBulletinBoard\s*\(/,
  },
  {
    name: 'board write helper',
    applies: () => true,
    pattern: /\b(ensureProjectChannels|ensureInboxChannel|destroyBulletinBoard|flushAllBulletinBoards)\b/,
  },
  {
    name: 'store module import',
    applies: () => true,
    pattern: /from\s+['"][./]*(?:services\/)?group-project-(membership-file|json-file|paths)['"]/,
  },
  {
    name: 'file write under group-projects/',
    applies: (text) => /['"`]group-projects['"`]/.test(text),
    pattern: /\b(writeFile|writeFileSync|replaceFile|rename|renameSync|rm|rmSync|unlink|unlinkSync|appendFile)\s*\(/,
  },
];

describe('group project reads and writes go through the host (#3356)', () => {
  const files = sourceFiles(MAIN).filter((file) => !STORE_FILES.has(rel(file)));

  it('finds the files it guards', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(rel)).toContain('ipc/group-project-handlers.ts');
  });

  it('has no direct writes outside the host service', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const rule of RULES) {
        if (!rule.applies(text)) continue;
        text.split('\n').forEach((line, i) => {
          if (rule.pattern.test(line)) violations.push(`${rel(file)}:${i + 1} ${rule.name}: ${line.trim()}`);
        });
      }
    }
    expect(violations).toEqual([]);
  });

  it('catches a direct write', () => {
    const text = "import { getBulletinBoard } from './group-project-bulletin';\nawait getBulletinBoard(id).postMessage('a', 'b', 'c');";
    const rule = RULES.find((r) => r.name === 'board mutation')!;
    expect(rule.applies(text) && text.split('\n').some((line) => rule.pattern.test(line))).toBe(true);
  });
});
