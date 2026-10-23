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

describe('paths with spaces (#2423)', () => {
  it('splits them in prose, which stays conservative', () => {
    expect(paths('Wrote /tmp/CH media probe/image.png')).toEqual([
      ['/tmp/CH', undefined, undefined], ['probe/image.png', undefined, undefined],
    ]);
  });

  it('takes a whole code span with spaces as one path, keeping the text as written', () => {
    expect(wholeFilePath('/tmp/CH media probe/image.png')).toEqual({ start: 0, end: 29, path: '/tmp/CH media probe/image.png' });
    expect(wholeFilePath('~/Library/Application Support/Code/settings.json:12:4')).toMatchObject({
      path: '~/Library/Application Support/Code/settings.json', line: 12, col: 4,
    });
    expect(wholeFilePath('.clubhouse/.local/rich-preview-probes/tone sample.wav')).toMatchObject({ path: '.clubhouse/.local/rich-preview-probes/tone sample.wav' });
    expect(wholeFilePath('./My Docs/notes.md#L7')).toMatchObject({ path: './My Docs/notes.md', line: 7 });
    expect(wholeFilePath('C:\\Program Files\\App\\config.json:3')).toMatchObject({ path: 'C:\\Program Files\\App\\config.json', line: 3 });
    expect(wholeFilePath('file:///tmp/CH media probe/image.png')).toMatchObject({ path: 'file:///tmp/CH media probe/image.png' });
  });

  it('leaves commands, lists and prose in code spans alone', () => {
    expect(wholeFilePath('npm run src/main.ts')).toBeNull();
    expect(wholeFilePath('git diff src/a.ts')).toBeNull();
    expect(wholeFilePath('src/a.ts src/b.ts')).toBeNull();
    expect(wholeFilePath('/src/a.ts and /src/b.ts')).toBeNull();
    expect(wholeFilePath('node server.js')).toBeNull();
    expect(wholeFilePath('a / b')).toBeNull();
    expect(wholeFilePath('/tmp/x\tother')).toBeNull();
  });

  it('takes a quoted path with spaces as one path, the quotes outside the match', () => {
    const text = 'Saved to "/tmp/CH media probe/image.png" and \'docs/My Notes.md:4:2\'.';
    const found = findFilePaths(text);
    expect(found.map((m) => [m.path, m.line, m.col])).toEqual([
      ['/tmp/CH media probe/image.png', undefined, undefined],
      ['docs/My Notes.md', 4, 2],
    ]);
    expect(text.slice(found[0].start, found[0].end)).toBe('/tmp/CH media probe/image.png');
    expect(text.slice(found[1].start, found[1].end)).toBe('docs/My Notes.md:4:2');
    expect(paths('see `C:\\Users\\me\\My Project\\a.ts:9`')).toEqual([['C:\\Users\\me\\My Project\\a.ts', 9, undefined]]);
    expect(paths('\u201c~/Media Files/clip.mov\u201d')).toEqual([['~/Media Files/clip.mov', undefined, undefined]]);
  });

  it('keeps ordinary quotes and apostrophes to the usual tokens', () => {
    expect(paths('"src/a.ts and lib/b.ts" are done')).toEqual([['src/a.ts', undefined, undefined], ['lib/b.ts', undefined, undefined]]);
    expect(paths("it's in 'src/a.ts', isn't it")).toEqual([['src/a.ts', undefined, undefined]]);
    expect(paths('"see the docs" for src/a.ts')).toEqual([['src/a.ts', undefined, undefined]]);
    expect(paths('Changed "src/a.ts, src/b.ts" and `src/c.ts:12; lib/d.ts:4`')).toEqual([
      ['src/a.ts', undefined, undefined], ['src/b.ts', undefined, undefined], ['src/c.ts', 12, undefined], ['lib/d.ts', 4, undefined],
    ]);
    expect(wholeFilePath('src/a.ts, src/b.ts')).toBeNull();
  });

  it('still takes encoded file URLs as one token', () => {
    expect(paths('file:///tmp/CH%20media%20probe/image.png:3')).toEqual([['file:///tmp/CH%20media%20probe/image.png', 3, undefined]]);
  });
});
