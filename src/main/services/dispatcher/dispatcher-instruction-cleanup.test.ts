import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OrchestratorProvider } from '../../orchestrators/types';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { removeLegacyMemoryIndexCopies, withoutLegacyMemoryIndex } from './dispatcher-instruction-cleanup';

/** A beta.7 file: the role text, a person's own line, then the memory index copied in. */
function beta7File(opts: { eol?: string; after?: string } = {}): string {
  const eol = opts.eol ?? '\n';
  const head = ['# Dispatcher', '', 'Role text from an older build.', '', 'MY OWN RULE: never page me before 9am.', ''].join(eol);
  const index = ['# Dispatcher memory', '', ...Array.from({ length: 200 }, (_, i) => `- **Entry ${i}:** ${'detail '.repeat(8)}`)].join(eol);
  return `${head}${eol}## Your memory index${eol}${eol}This is \`memory/index.md\` as it was when this file was written.${eol}${eol}${index}${eol}${opts.after ?? ''}`;
}

describe('withoutLegacyMemoryIndex', () => {
  it('cuts the copied index and keeps the text before it', () => {
    const cleaned = withoutLegacyMemoryIndex(beta7File())!;
    expect(cleaned).toBe('# Dispatcher\n\nRole text from an older build.\n\nMY OWN RULE: never page me before 9am.\n');
  });

  it('keeps CRLF line ends', () => {
    const cleaned = withoutLegacyMemoryIndex(beta7File({ eol: '\r\n' }))!;
    expect(cleaned).toBe('# Dispatcher\r\n\r\nRole text from an older build.\r\n\r\nMY OWN RULE: never page me before 9am.\r\n');
  });

  it('leaves alone a file with no copy, a fixed lookup, or a heading of the person\'s own', () => {
    expect(withoutLegacyMemoryIndex('# Dispatcher\n\nText.\n')).toBeNull();
    expect(withoutLegacyMemoryIndex('# D\n\n## Your memory index\n\nBefore handling a task, call read_memory.\n')).toBeNull();
    expect(withoutLegacyMemoryIndex('# D\n\n## Your memory index\n\nMy own notes on the index.\n')).toBeNull();
    expect(withoutLegacyMemoryIndex('Intro ## Your memory index\n\nThis is `memory/index.md` as it was when this file was written.\n')).toBeNull();
  });
});

describe('removeLegacyMemoryIndexCopies', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-cleanup-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function provider(id: string, file: string): OrchestratorProvider {
    return {
      id,
      readInstructions: vi.fn(async (d: string) => {
        try { return fs.readFileSync(path.join(d, file), 'utf-8'); } catch { return ''; }
      }),
      writeInstructions: vi.fn(async (d: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
        fs.writeFileSync(path.join(d, file), content);
      }),
    } as unknown as OrchestratorProvider;
  }

  it('bounds every inactive CLI\'s file, keeps the person\'s text, and leaves the active file to its writer', async () => {
    const claude = provider('claude-code', 'CLAUDE.md');
    const codex = provider('codex-cli', 'AGENTS.md');
    const copilot = provider('copilot-cli', path.join('.github', 'copilot-instructions.md'));
    const original = beta7File();
    expect(Buffer.byteLength(original)).toBeGreaterThan(14 * 1024);
    for (const file of ['CLAUDE.md', 'AGENTS.md', path.join('.github', 'copilot-instructions.md')]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), original);
    }

    await removeLegacyMemoryIndexCopies(dir, claude, [claude, codex, copilot]);

    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(original);
    for (const file of ['AGENTS.md', path.join('.github', 'copilot-instructions.md')]) {
      const text = fs.readFileSync(path.join(dir, file), 'utf-8');
      expect(Buffer.byteLength(text)).toBeLessThan(200);
      expect(text).toContain('MY OWN RULE: never page me before 9am.');
      expect(text).not.toContain('Your memory index');
    }
    // What was cut is kept, whole, outside the instruction files.
    const backups = fs.readdirSync(path.join(dir, '.clubhouse', 'instruction-backups')).sort();
    expect(backups).toHaveLength(2);
    for (const name of backups) expect(fs.readFileSync(path.join(dir, '.clubhouse', 'instruction-backups', name), 'utf-8')).toBe(original);
    expect(claude.writeInstructions).not.toHaveBeenCalled();
  });

  it('keeps text a person added after the copied index, in the backup', async () => {
    const claude = provider('claude-code', 'CLAUDE.md');
    const codex = provider('codex-cli', 'AGENTS.md');
    const edited = beta7File({ after: '\nAdded later by me.\n' });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), edited);

    await removeLegacyMemoryIndexCopies(dir, claude, [claude, codex]);

    const [name] = fs.readdirSync(path.join(dir, '.clubhouse', 'instruction-backups'));
    expect(fs.readFileSync(path.join(dir, '.clubhouse', 'instruction-backups', name), 'utf-8')).toContain('Added later by me.');
  });

  it('does nothing the second time, writes no empty file for a CLI never used, and survives one bad file', async () => {
    const claude = provider('claude-code', 'CLAUDE.md');
    const codex = provider('codex-cli', 'AGENTS.md');
    const copilot = provider('copilot-cli', path.join('.github', 'copilot-instructions.md'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), beta7File());
    (copilot.readInstructions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('instructions_unreadable'));

    await removeLegacyMemoryIndexCopies(dir, claude, [claude, copilot, codex]);
    const once = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
    expect(once).not.toContain('Your memory index');
    expect(fs.existsSync(path.join(dir, '.github'))).toBe(false);

    await removeLegacyMemoryIndexCopies(dir, claude, [claude, copilot, codex]);
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe(once);
    expect(fs.readdirSync(path.join(dir, '.clubhouse', 'instruction-backups'))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
  });
});
