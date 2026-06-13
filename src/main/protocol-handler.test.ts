import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  PROTOCOL_SCHEME,
  parseProtocolUrl,
  extractProtocolUrlFromArgv,
  findProjectForFile,
  resolveProtocolCommand,
} from './protocol-handler';
import { Project } from '../shared/types';

function project(id: string, p: string): Project {
  return { id, name: path.basename(p), path: p };
}

describe('PROTOCOL_SCHEME', () => {
  it('is "clubhouse"', () => {
    expect(PROTOCOL_SCHEME).toBe('clubhouse');
  });
});

describe('parseProtocolUrl', () => {
  it('parses an open-file command with a path', () => {
    const result = parseProtocolUrl('clubhouse://open-file?path=/Users/me/proj/src/index.ts');
    expect(result).toEqual({ kind: 'open-file', filePath: '/Users/me/proj/src/index.ts' });
  });

  it('parses an open-folder command with a path', () => {
    const result = parseProtocolUrl('clubhouse://open-folder?path=/Users/me/proj');
    expect(result).toEqual({ kind: 'open-folder', folderPath: '/Users/me/proj' });
  });

  it('URL-decodes the path parameter', () => {
    const encoded = encodeURIComponent('/Users/me/my project/a file.ts');
    const result = parseProtocolUrl(`clubhouse://open-file?path=${encoded}`);
    expect(result).toEqual({ kind: 'open-file', filePath: '/Users/me/my project/a file.ts' });
  });

  it('matches the scheme case-insensitively', () => {
    const result = parseProtocolUrl('Clubhouse://open-folder?path=/tmp/x');
    expect(result).toEqual({ kind: 'open-folder', folderPath: '/tmp/x' });
  });

  it('matches the command case-insensitively', () => {
    const result = parseProtocolUrl('clubhouse://OPEN-FILE?path=/tmp/x.ts');
    expect(result).toEqual({ kind: 'open-file', filePath: '/tmp/x.ts' });
  });

  it('tolerates a trailing slash after the command', () => {
    const result = parseProtocolUrl('clubhouse://open-folder/?path=/tmp/x');
    expect(result).toEqual({ kind: 'open-folder', folderPath: '/tmp/x' });
  });

  it('returns null for the wrong scheme', () => {
    expect(parseProtocolUrl('https://open-file?path=/tmp/x.ts')).toBeNull();
    expect(parseProtocolUrl('vscode://open-file?path=/tmp/x.ts')).toBeNull();
  });

  it('returns null for an unknown command', () => {
    expect(parseProtocolUrl('clubhouse://do-something?path=/tmp/x')).toBeNull();
  });

  it('returns null when the path parameter is missing', () => {
    expect(parseProtocolUrl('clubhouse://open-file')).toBeNull();
    expect(parseProtocolUrl('clubhouse://open-folder?other=1')).toBeNull();
  });

  it('returns null when the path parameter is empty or whitespace', () => {
    expect(parseProtocolUrl('clubhouse://open-file?path=')).toBeNull();
    expect(parseProtocolUrl('clubhouse://open-file?path=%20%20')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(parseProtocolUrl('not a url')).toBeNull();
    expect(parseProtocolUrl('')).toBeNull();
  });
});

describe('extractProtocolUrlFromArgv', () => {
  it('finds a clubhouse:// argument among other args', () => {
    const argv = ['/path/to/electron', '--some-flag', 'clubhouse://open-file?path=/tmp/x.ts'];
    expect(extractProtocolUrlFromArgv(argv)).toBe('clubhouse://open-file?path=/tmp/x.ts');
  });

  it('matches the scheme case-insensitively', () => {
    const argv = ['app', 'Clubhouse://open-folder?path=/tmp/x'];
    expect(extractProtocolUrlFromArgv(argv)).toBe('Clubhouse://open-folder?path=/tmp/x');
  });

  it('returns the first match when several are present', () => {
    const argv = ['app', 'clubhouse://open-file?path=/a.ts', 'clubhouse://open-file?path=/b.ts'];
    expect(extractProtocolUrlFromArgv(argv)).toBe('clubhouse://open-file?path=/a.ts');
  });

  it('returns null when no protocol argument is present', () => {
    expect(extractProtocolUrlFromArgv(['app', '--flag', '/tmp/file'])).toBeNull();
    expect(extractProtocolUrlFromArgv([])).toBeNull();
  });
});

describe('findProjectForFile', () => {
  const projects = [
    project('p1', '/Users/me/projects/alpha'),
    project('p2', '/Users/me/projects/beta'),
  ];

  it('matches a file under a project root and returns a relative path', () => {
    const result = findProjectForFile('/Users/me/projects/alpha/src/index.ts', projects);
    expect(result?.project.id).toBe('p1');
    expect(result?.relativePath).toBe('src/index.ts');
  });

  it('returns null when no project contains the file', () => {
    expect(findProjectForFile('/Users/me/elsewhere/file.ts', projects)).toBeNull();
  });

  it('does not match a sibling whose name is a prefix of the root', () => {
    // /Users/me/projects/alpha-extra must NOT match root /Users/me/projects/alpha
    const result = findProjectForFile('/Users/me/projects/alpha-extra/file.ts', projects);
    expect(result).toBeNull();
  });

  it('picks the deepest (most specific) project when roots are nested', () => {
    const nested = [
      project('outer', '/Users/me/work'),
      project('inner', '/Users/me/work/sub'),
    ];
    const result = findProjectForFile('/Users/me/work/sub/lib/x.ts', nested);
    expect(result?.project.id).toBe('inner');
    expect(result?.relativePath).toBe('lib/x.ts');
  });

  it('normalizes project roots with trailing separators', () => {
    const withTrailing = [project('p', '/Users/me/projects/alpha/')];
    const result = findProjectForFile('/Users/me/projects/alpha/src/a.ts', withTrailing);
    expect(result?.project.id).toBe('p');
    expect(result?.relativePath).toBe('src/a.ts');
  });

  it('skips projects with an empty path', () => {
    const withEmpty = [project('empty', ''), project('p1', '/Users/me/projects/alpha')];
    const result = findProjectForFile('/Users/me/projects/alpha/x.ts', withEmpty);
    expect(result?.project.id).toBe('p1');
  });
});

describe('resolveProtocolCommand', () => {
  const projects = [project('p1', '/Users/me/projects/alpha')];

  it('passes open-folder through unchanged', () => {
    const action = resolveProtocolCommand({ kind: 'open-folder', folderPath: '/tmp/new' }, projects);
    expect(action).toEqual({ kind: 'open-folder', folderPath: '/tmp/new' });
  });

  it('resolves open-file to its owning project', () => {
    const action = resolveProtocolCommand(
      { kind: 'open-file', filePath: '/Users/me/projects/alpha/src/a.ts' },
      projects,
    );
    expect(action).toEqual({ kind: 'open-file', projectId: 'p1', relativePath: 'src/a.ts' });
  });

  it('returns open-file-not-found when no project contains the file', () => {
    const action = resolveProtocolCommand(
      { kind: 'open-file', filePath: '/somewhere/else/a.ts' },
      projects,
    );
    expect(action).toEqual({ kind: 'open-file-not-found', filePath: '/somewhere/else/a.ts' });
  });
});
