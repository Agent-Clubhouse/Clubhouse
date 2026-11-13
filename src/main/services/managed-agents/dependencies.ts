/**
 * What an imported skill or MCP server says it depends on (#2855), read from
 * its own manifests and never run or installed: a SKILL.md's `allowed-tools`,
 * `compatibility` and `dependencies`, a bundled package.json or
 * requirements.txt, and the package an MCP command fetches. Names only,
 * bounded and redacted. Whether a dependency is installed or works is not checked.
 */
import { redactSecretValues } from '../../telemetry/diag-redaction';
import type { ManagedMcpContent, ManagedPartContent, ManagedSkillContent } from '../../../shared/managed-agents-types';

export interface DeclaredDependency {
  kind: 'tool' | 'mcp_server' | 'environment' | 'declared' | 'npm' | 'pip' | 'command' | 'remote';
  name: string;
  /** Where it was declared: a bundle file, or the MCP definition. */
  from: string;
}

export interface DeclaredDependencies {
  status: 'declared' | 'none_declared';
  declared: DeclaredDependency[];
  /** More were declared than the preview lists. */
  truncated?: true;
  note: string;
}

const MAX_DEPENDENCIES = 50;
const MAX_NAME = 200;
const NOTE = 'Read from the bundle\'s own manifests. Nothing was installed, run or checked; dependencies outside them are not known.';

function text(content: ManagedSkillContent, file: string): string | undefined {
  const f = content.files.find((x) => x.path === file && x.encoding !== 'base64');
  return f?.content;
}

/** The value of a front-matter key: a scalar, an inline [a, b] list, or a block "- a" list. */
function frontMatterValues(skillMd: string, key: string): string[] {
  const front = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!front) return [];
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((l) => l.match(/^([A-Za-z_-]+):/)?.[1] === key);
  if (at < 0) return [];
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const inline = lines[at].slice(lines[at].indexOf(':') + 1).trim();
  if (inline.startsWith('[')) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  if (inline) return [unquote(inline)];
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (!item) break;
    items.push(unquote(item[1]));
  }
  return items;
}

function skillDependencies(content: ManagedSkillContent): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  const skillMd = text(content, 'SKILL.md') ?? '';
  for (const entry of frontMatterValues(skillMd, 'allowed-tools')) {
    // "Bash(git:*) Read" and "Bash(git:*), Read" both list tools.
    for (const tool of entry.split(/[\s,]+(?![^(]*\))/).filter(Boolean)) {
      const server = tool.match(/^mcp__(.+?)__/)?.[1];
      out.push(server ? { kind: 'mcp_server', name: server, from: 'SKILL.md allowed-tools' } : { kind: 'tool', name: tool, from: 'SKILL.md allowed-tools' });
    }
  }
  for (const value of frontMatterValues(skillMd, 'compatibility')) out.push({ kind: 'environment', name: value, from: 'SKILL.md compatibility' });
  for (const value of frontMatterValues(skillMd, 'dependencies')) out.push({ kind: 'declared', name: value, from: 'SKILL.md dependencies' });
  const pkg = text(content, 'package.json');
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = parsed[field];
        if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) out.push({ kind: 'npm', name, from: `package.json ${field}` });
      }
    } catch {
      // telemetry-exempt: a package.json that isn't JSON declares nothing readable; the preview lists the file itself.
    }
  }
  const requirements = text(content, 'requirements.txt');
  if (requirements) {
    for (const line of requirements.split(/\r?\n/)) {
      const name = line.replace(/#.*/, '').trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
      if (name && !line.trim().startsWith('-')) out.push({ kind: 'pip', name, from: 'requirements.txt' });
    }
  }
  return out;
}

/**
 * How each launcher reads its options before the package: the options that
 * name the package, the ones that take a value, and the ones that don't. An
 * option it doesn't know might take the next argument, so the package is unknown.
 */
interface LauncherOptions { names: string[]; values: string[]; flags: string[] }
const LAUNCHERS: Record<'npx' | 'bunx' | 'dlx' | 'uvx' | 'pipx', LauncherOptions> = {
  npx: { names: ['-p', '--package'], values: ['-c', '--call', '--cache', '--registry', '--userconfig', '-w', '--workspace'],
    flags: ['-y', '--yes', '--no', '--no-install', '-q', '--quiet', '--silent', '--offline', '--prefer-offline', '--prefer-online', '--ignore-existing'] },
  bunx: { names: ['-p', '--package'], values: [], flags: ['--bun', '--no-install', '--silent', '--verbose'] },
  dlx: { names: ['-p', '--package'], values: ['-c', '--reporter', '--registry'], flags: ['-q', '--quiet', '--silent', '--shell-mode'] },
  uvx: { names: ['--from'],
    values: ['-p', '--python', '--with', '--with-editable', '--with-requirements', '--index', '--index-url', '--default-index', '--extra-index-url',
      '-i', '-f', '--find-links', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease', '--exclude-newer', '--link-mode',
      '-c', '--constraints', '--overrides', '--cache-dir', '--directory', '--project', '--config-file', '--python-preference',
      '-P', '--upgrade-package', '--reinstall-package', '--refresh-package'],
    flags: ['-q', '--quiet', '-v', '--verbose', '--isolated', '-n', '--no-cache', '--offline', '--refresh', '-U', '--upgrade', '--reinstall',
      '--no-config', '--no-progress', '--native-tls', '--compile-bytecode', '--managed-python', '--no-managed-python', '--no-python-downloads'] },
  pipx: { names: ['--spec'], values: ['--python', '--pip-args', '--index-url', '--backend', '--fetch-python'],
    flags: ['-q', '--quiet', '-v', '--verbose', '--no-cache', '--system-site-packages', '--path', '--pypackages'] },
};

/** The package a launcher fetches, or 'unknown' when an option it can't read comes first. */
function launchedPackage(args: string[], options: LauncherOptions): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return args[i + 1];
    if (!arg.startsWith('-')) return arg;
    const eq = arg.indexOf('=');
    const option = eq > 0 ? arg.slice(0, eq) : arg;
    if (options.names.includes(option)) return eq > 0 ? arg.slice(eq + 1) : args[i + 1];
    if (options.values.includes(option)) { if (eq < 0) i++; continue; }
    if (options.flags.includes(option) || eq > 0) continue;
    return 'unknown';
  }
  return undefined;
}

function mcpDependencies(content: ManagedMcpContent): DeclaredDependency[] {
  if (content.transport !== 'stdio') {
    try {
      return content.url ? [{ kind: 'remote', name: new URL(content.url).hostname, from: 'MCP url' }] : [];
    } catch {
      // telemetry-exempt: an unparseable url names no host; the preview already shows the transport.
      return [];
    }
  }
  const command = content.command?.split(/[\\/]/).pop();
  if (!command) return [];
  const args = content.args ?? [];
  const runner = command.replace(/\.(cmd|exe)$/i, '').toLowerCase();
  const out: DeclaredDependency[] = [{ kind: 'command', name: command, from: 'MCP command' }];
  const pkg = runner === 'npx' || runner === 'bunx' ? launchedPackage(args, LAUNCHERS[runner])
    : (runner === 'pnpm' || runner === 'yarn') && args[0] === 'dlx' ? launchedPackage(args.slice(1), LAUNCHERS.dlx)
      : runner === 'uvx' ? launchedPackage(args, LAUNCHERS.uvx)
        : runner === 'pipx' && args[0] === 'run' ? launchedPackage(args.slice(1), LAUNCHERS.pipx) : undefined;
  if (pkg) {
    out.push({ kind: runner === 'uvx' || runner === 'pipx' ? 'pip' : 'npm', name: pkg,
      from: pkg === 'unknown' ? 'MCP command (an option before the package that Clubhouse can\'t read)' : 'MCP command' });
  }
  return out;
}

export function declaredDependencies(content: ManagedPartContent): DeclaredDependencies {
  const all = content.kind === 'skill' ? skillDependencies(content) : content.kind === 'mcp' ? mcpDependencies(content) : [];
  const seen = new Set<string>();
  const declared: DeclaredDependency[] = [];
  for (const d of all) {
    const name = redactSecretValues(d.name).slice(0, MAX_NAME);
    const key = `${d.kind}\u0000${name}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    declared.push({ ...d, name });
  }
  return {
    status: declared.length ? 'declared' : 'none_declared',
    declared: declared.slice(0, MAX_DEPENDENCIES),
    ...(declared.length > MAX_DEPENDENCIES && { truncated: true as const }),
    note: NOTE,
  };
}
