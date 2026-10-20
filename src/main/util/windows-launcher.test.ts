import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWindowsCmdLine, quoteWindowsArg, resolveNodeShim } from './windows-launcher';

// A model of what happens to a cmd.exe line, so the escaping can be checked on
// any OS. structured-spawn.windows.test.ts runs the same matrix through a real
// cmd.exe on Windows CI.

/** Variables the model treats as defined, in a real cmd.exe they'd expand. */
const ENV: Record<string, string> = { PATH: 'EXPANDED', USERNAME: 'EXPANDED', A: 'EXPANDED' };

/**
 * Phase 1 on a command line (not in a batch file): `%NAME%` expands when NAME
 * is defined; otherwise the text stays. Resumes right after the opening `%`,
 * so every pair of percent signs is tried as a name.
 */
function expandPercent(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const close = line[i] === '%' ? line.indexOf('%', i + 1) : -1;
    const name = close > i ? line.slice(i + 1, close).toUpperCase() : '';
    if (name && name in ENV) {
      out += ENV[name];
      i = close + 1;
    } else {
      out += line[i++];
    }
  }
  return out;
}

/**
 * Phase 2: outside quotes `^` escapes the next character (an escaped `"`
 * doesn't toggle quote mode) and an unescaped `&`, `|`, `<` or `>` would end
 * or redirect the command; inside quotes everything is literal.
 */
function stripCarets(line: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') quoted = false;
      out += c;
    } else if (c === '^') {
      out += line[++i] ?? '';
    } else {
      if (c === '"') quoted = true;
      if ('&|<>'.includes(c)) throw new Error(`unescaped ${c} would split the command: ${line}`);
      out += c;
    }
  }
  return out;
}

/** CommandLineToArgvW / MSVCRT argument splitting, as node.exe does it. */
function splitMsvcrt(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') {
        let n = 0;
        while (line[i] === '\\') { n++; i++; }
        if (line[i] === '"') {
          arg += '\\'.repeat(n >> 1);
          if (n % 2) arg += '"';
          else { quoted = !quoted; }
        } else {
          arg += '\\'.repeat(n);
          i--;
        }
      } else if (c === '"') {
        quoted = !quoted;
      } else if (!quoted && (c === ' ' || c === '\t')) {
        break;
      } else {
        arg += c;
      }
    }
    args.push(arg);
  }
  return args;
}

/**
 * The argv a node script receives when `buildWindowsCmdLine(binary, args)`
 * runs as `cmd.exe /d /s /c "<line>"`. A batch binary stands for an npm shim
 * whose line is `"node" "cli.js" %*`: `%*` is replaced with the arguments as
 * cmd.exe passed them and that line goes through phase 2 again (substituted
 * text isn't rescanned for `%`).
 */
function roundTrip(binary: string, args: string[]): string[] {
  const line = stripCarets(expandPercent(buildWindowsCmdLine(binary, args)));
  const space = line.indexOf(' ');
  const tail = space < 0 ? '' : line.slice(space + 1);
  if (/\.(cmd|bat)$/i.test(binary)) {
    return splitMsvcrt(stripCarets(`"node" "cli.js" ${tail}`)).slice(2);
  }
  return splitMsvcrt(tail);
}

/** Arguments cmd.exe or MSVCRT quoting can get wrong. */
const TRICKY_ARGS = [
  '',
  ' ',
  'plain',
  'with spaces',
  '100%',
  '%PATH%',
  '%%PATH%%',
  '%A%%A%',
  '%~dp0',
  '!PATH!',
  '^',
  'a^b^^c',
  'a&b',
  'a|b',
  '<in>out',
  '(x) [y] {z}',
  '"',
  'say "hi"',
  '""',
  'a\\b',
  'C:\\data\\',
  'trailing\\\\',
  'a\\"b',
  '\\\\"',
  'semi;colon,comma=eq',
  '*?`',
  'https://h/mcp?x=a%20b&y=%PATH%',
  JSON.stringify({ mcpServers: { s: { url: 'https://h/mcp?x=a%20b', env: { P: '%USERNAME%|^&', D: 'C:\\data\\' } } } }),
];

describe('quoteWindowsArg', () => {
  it.each([
    ['', '""'],
    ['a b', '"a b"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['C:\\data\\', '"C:\\data\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['a\\b', '"a\\b"'],
  ])('quotes %j as %j', (arg, quoted) => {
    expect(quoteWindowsArg(arg)).toBe(quoted);
  });

  it.each(TRICKY_ARGS)('splits %j back unchanged', (arg) => {
    expect(splitMsvcrt(`x ${quoteWindowsArg(arg)}`)).toEqual(['x', arg]);
  });
});

describe('buildWindowsCmdLine', () => {
  it('round-trips every tricky argument through a batch shim (#2339, #2340)', () => {
    expect(roundTrip('claude.cmd', TRICKY_ARGS)).toEqual(TRICKY_ARGS);
  });

  it('round-trips every tricky argument to an executable', () => {
    expect(roundTrip('claude.exe', TRICKY_ARGS)).toEqual(TRICKY_ARGS);
  });

  it.each(TRICKY_ARGS)('round-trips %j on its own', (arg) => {
    expect(roundTrip('claude.cmd', ['--x', arg])).toEqual(['--x', arg]);
    expect(roundTrip('CLAUDE.BAT', [arg])).toEqual([arg]);
    expect(roundTrip('claude.exe', [arg])).toEqual([arg]);
  });

  it('caret-escapes the binary once and a shim\'s arguments twice', () => {
    expect(buildWindowsCmdLine('C:\\my tools\\x.cmd', ['a b'])).toBe('C:\\my^ tools\\x.cmd ^^^"a^^^ b^^^"');
    expect(buildWindowsCmdLine('C:\\my tools\\x.exe', ['a b'])).toBe('C:\\my^ tools\\x.exe ^"a^ b^"');
  });

  it('the model catches the quoting this replaced', () => {
    // #1782 doubled % and quotes, which leaves %% on a command line.
    const old = (a: string): string => '"' + a.replace(/%/g, '%%').replace(/"/g, '""') + '"';
    const line = stripCarets(expandPercent(`claude.exe ${old('100%')}`));
    expect(splitMsvcrt(line).slice(1)).not.toEqual(['100%']);
  });
});

describe('resolveNodeShim', () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  async function writeShim(name: string, body: string, script = 'cli.js'): Promise<string> {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'node-shim-'));
    await fs.promises.writeFile(path.join(tmp, script), '');
    const shim = path.join(tmp, name);
    await fs.promises.writeFile(shim, body);
    return shim;
  }

  // The templates npm's cmd-shim writes, current and older; pnpm's matches the older one.
  const CURRENT = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\cli.js" %*', '',
  ].join('\r\n');
  const OLDER = [
    '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\cli.js" %*', ') ELSE (', '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\cli.js" %*', ')', '',
  ].join('\r\n');

  it.each([['current', CURRENT], ['older', OLDER]])('resolves the %s npm template to node and its script', async (_label, body) => {
    const shim = await writeShim('claude.cmd', body);
    expect(resolveNodeShim(shim)).toEqual({ node: 'node', script: path.join(tmp!, 'cli.js') });
  });

  it('prefers node.exe beside the shim, as the shim does', async () => {
    const shim = await writeShim('claude.cmd', CURRENT);
    await fs.promises.writeFile(path.join(tmp!, 'node.exe'), '');
    expect(resolveNodeShim(shim)?.node).toBe(path.join(tmp!, 'node.exe'));
  });

  it('ignores a shim that passes interpreter flags', async () => {
    const shim = await writeShim('claude.cmd', CURRENT.replace('"%_prog%"  ', '"%_prog%" --no-warnings '));
    expect(resolveNodeShim(shim)).toBeNull();
  });

  it('ignores a shim whose script is missing', async () => {
    const shim = await writeShim('claude.cmd', CURRENT.replace('cli.js', 'gone.js'));
    expect(resolveNodeShim(shim)).toBeNull();
  });

  it('ignores other batch files, non-batch files and missing files', async () => {
    const shim = await writeShim('claude.cmd', '@echo off\r\n"node" "cli.js" %*\r\n');
    expect(resolveNodeShim(shim)).toBeNull();
    const exe = await writeShim('claude.exe', CURRENT);
    expect(resolveNodeShim(exe)).toBeNull();
    expect(resolveNodeShim(path.join(tmp!, 'missing.cmd'))).toBeNull();
  });
});
