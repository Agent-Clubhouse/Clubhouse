import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkWindowsPaths, findWindowsPathProblems, windowsNameProblem } from './check-windows-paths.mjs';

describe('windowsNameProblem', () => {
  it.each(['index.ts', 'CONTRIBUTING.md', 'console.ts', 'com10', 'a.b.c', '.gitignore', '.', '..'])('accepts %j', (name) => {
    expect(windowsNameProblem(name)).toBeUndefined();
  });

  it.each([
    ['undefined\\temp', 'contains "\\\\"'],
    ['a:b', 'contains ":"'],
    ['what?', 'contains "?"'],
    ['tab\there', 'contains "\\t"'],
    ['CON', 'is a reserved device name'],
    ['nul.txt', 'is a reserved device name'],
    ['Lpt9.log', 'is a reserved device name'],
    ['CONOUT$', 'is a reserved device name'],
    ['trailing.', 'ends with a dot or space'],
    ['trailing ', 'ends with a dot or space'],
  ])('rejects %j', (name, why) => {
    expect(windowsNameProblem(name)).toBe(why);
  });
});

describe('findWindowsPathProblems', () => {
  it('reports each bad path once, naming the first bad segment', () => {
    expect(findWindowsPathProblems([
      'src/ok.ts',
      'undefined\\temp/node-compile-cache/v24/00845a73',
      'docs/aux/CON',
    ])).toEqual([
      '"undefined\\\\temp/node-compile-cache/v24/00845a73": "undefined\\\\temp" contains "\\\\"',
      '"docs/aux/CON": "aux" is a reserved device name',
    ]);
  });
});

// Windows can't create `undefined\temp` or `a:b`, so these run on macOS and Linux.
describe.skipIf(process.platform === 'win32')('checkWindowsPaths on a real repo', () => {
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-windows-paths-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'ok.txt'), '');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'undefined\\\\temp/\n');
    return dir;
  };

  it('passes a clean repo', () => {
    const dir = makeRepo();
    try {
      expect(checkWindowsPaths(dir, { untracked: true })).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds tracked bad paths always, and untracked or ignored ones with untracked', () => {
    const dir = makeRepo();
    try {
      fs.mkdirSync(path.join(dir, 'undefined\\temp'));
      fs.writeFileSync(path.join(dir, 'undefined\\temp', 'cache'), '');
      expect(checkWindowsPaths(dir)).toBeUndefined();
      expect(checkWindowsPaths(dir, { untracked: true })).toContain('"undefined\\\\temp/"');

      fs.writeFileSync(path.join(dir, 'a:b'), '');
      execFileSync('git', ['add', 'a:b'], { cwd: dir });
      expect(checkWindowsPaths(dir)).toContain('"a:b": "a:b" contains ":"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
