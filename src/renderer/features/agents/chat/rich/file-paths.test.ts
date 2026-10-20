import { describe, expect, it } from 'vitest';
import { findFilePaths, wholeFilePath } from './file-paths';

const paths = (text: string) => findFilePaths(text).map((m) => [m.path, m.line, m.col]);

describe('findFilePaths', () => {
  it('finds absolute, relative and dotted paths with line suffixes', () => {
    expect(paths('Edited /Users/me/app/src/main.ts:42:7 and src/renderer/App.tsx:10.')).toEqual([
      ['/Users/me/app/src/main.ts', 42, 7],
      ['src/renderer/App.tsx', 10, undefined],
    ]);
    expect(paths('See ./scripts/build.sh, ../shared/x.ts and package.json')).toEqual([
      ['./scripts/build.sh', undefined, undefined],
      ['../shared/x.ts', undefined, undefined],
      ['package.json', undefined, undefined],
    ]);
    expect(paths('deep src/components/Button without extension')).toEqual([['src/components/Button', undefined, undefined]]);
    expect(paths('types in node_modules/@types/node/index.d.ts')).toEqual([['node_modules/@types/node/index.d.ts', undefined, undefined]]);
  });

  it('parses Windows paths, with either slash and a line suffix', () => {
    expect(paths('Opened C:\\Users\\me\\proj\\src\\index.ts:12 and D:/data/out.png')).toEqual([
      ['C:\\Users\\me\\proj\\src\\index.ts', 12, undefined],
      ['D:/data/out.png', undefined, undefined],
    ]);
    expect(paths('.\\scripts\\run.ps1')).toEqual([['.\\scripts\\run.ps1', undefined, undefined]]);
    // A drive letter alone is not a path with a line number.
    expect(paths('C:\\')).toEqual([]);
  });

  it('finds file:// URLs but leaves other URLs and emails to the link matcher', () => {
    expect(paths('file:///tmp/report.html')).toEqual([['file:///tmp/report.html', undefined, undefined]]);
    expect(paths('https://github.com/org/repo/blob/main/a.ts and me@example.com')).toEqual([]);
  });

  it('skips prose, numbers, dates and versions', () => {
    expect(paths('read/write access on 10/19/2026, v1.2.3, e.g. this, and / alone')).toEqual([]);
    // A bare dotted name is only a candidate: main decides whether such a file exists.
    expect(paths('Node.js')).toEqual([['Node.js', undefined, undefined]]);
  });

  it('strips wrapping punctuation and reports offsets of the path text', () => {
    const text = 'Look at **src/a.ts**, then (lib/b.js).';
    const [a, b] = findFilePaths(text);
    expect(text.slice(a.start, a.end)).toBe('src/a.ts');
    expect(text.slice(b.start, b.end)).toBe('lib/b.js');
  });
});

describe('findFilePaths names and anchors', () => {
  it('keeps names that start with _ or ~', () => {
    expect(paths('__init__.py, _app.tsx and ~/notes/todo.md')).toEqual([
      ['__init__.py', undefined, undefined], ['_app.tsx', undefined, undefined], ['~/notes/todo.md', undefined, undefined],
    ]);
    expect(wholeFilePath('~/notes/todo.md')).toMatchObject({ path: '~/notes/todo.md' });
  });

  it('reads #L anchors and line ranges as their first line', () => {
    expect(paths('src/a.ts#L10 src/b.ts#L3-L9 src/c.ts:12-20')).toEqual([
      ['src/a.ts', 10, undefined], ['src/b.ts', 3, undefined], ['src/c.ts', 12, undefined],
    ]);
  });
});

describe('wholeFilePath', () => {
  it('takes a code span that is just a path', () => {
    expect(wholeFilePath(' src/main.ts:3 ')).toMatchObject({ path: 'src/main.ts', line: 3 });
    expect(wholeFilePath('npm run src/main.ts')).toBeNull();
    expect(wholeFilePath('const x = 1')).toBeNull();
  });
});
