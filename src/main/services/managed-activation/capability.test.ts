import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDeliveryCapability, establishDeliveryCapability } from './capability';
import { validateSkillText } from './owned-output';
let dir: string; let binary: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capability-')); binary = path.join(dir, 'fake-claude'); await fs.writeFile(binary, 'if (process.argv[2] === "--version") console.log("2.1.316 (Claude Code)"); else if (process.argv[2] === "--help") console.log("  --append-system-prompt-file <path>\\n  --plugin-dir <path>"); else process.exit(99);', { mode: 0o700 }); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
describe('installed-path flag capability, never provider readiness', () => {
  it('runs only help/version on a fake fixture and binds evidence to that exact binary', async () => {
    const evidence = await establishDeliveryCapability(binary, 'darwin', async (fixture, args) => (await promisify(execFile)(process.execPath, [fixture, ...args])).stdout);
    expect(evidence).toMatchObject({ version: '2.1.316', platform: 'darwin', flags: ['--append-system-prompt-file', '--plugin-dir'] });
    await assertDeliveryCapability(evidence, binary, 'darwin');
    const other = path.join(dir, 'other-claude'); await fs.copyFile(binary, other);
    await expect(assertDeliveryCapability(evidence, other, 'darwin')).rejects.toMatchObject({ code: 'activation_capability_stale' });
    await fs.appendFile(binary, '\n# changed');
    await expect(assertDeliveryCapability(evidence, binary, 'darwin')).rejects.toMatchObject({ code: 'activation_capability_stale' });
  });
  it.each(['linux', 'win32'] as const)('blocks %s without executing even help', async (platform) => {
    const execute = vi.fn(); await expect(establishDeliveryCapability(binary, platform, execute)).rejects.toMatchObject({ code: 'activation_unsupported' }); expect(execute).not.toHaveBeenCalled();
  });
  it.each(['2.1.315', '3.0.0', 'unknown', '2.1.316-beta'])('blocks unknown/older capability version %s', async (version) => {
    await expect(establishDeliveryCapability(binary, 'darwin', async () => version)).rejects.toMatchObject({ code: 'activation_capability_unproven' });
  });
  it('does not treat version alone as flag evidence', async () => {
    await expect(establishDeliveryCapability(binary, 'darwin', async (_binary, args) => args[0] === '--version' ? '2.1.316' : '--plugin-dir <path>')).rejects.toMatchObject({ code: 'activation_capability_unproven' });
  });
});
describe('fail-closed selected skill grammar', () => {
  it('preserves plain content and a narrow non-operational frontmatter subset', () => {
    expect(() => validateSkillText('---\nname: review\ndescription: Review a change\n---\nKeep @@AgentName.', 'review')).not.toThrow();
    expect(() => validateSkillText('# Review\nLiteral code and supporting files.', 'review')).not.toThrow();
  });
  it.each([
    'allowed-tools: Bash', 'hooks: {}', 'context: fork', 'agent: Explore', 'model: fast',
    '"allowed-tools": Bash', "'description': safe", 'description: safe\ndescription: other',
    'description: &alias safe', 'description: *alias', 'description: !tag safe', 'description: {x: y}',
    'description: |\n  safe\nallowed-tools: Bash', '? description\n: safe', 'name: another',
  ])('refuses ambiguous or operational frontmatter: %s', (frontmatter) => {
    expect(() => validateSkillText(`---\n${frontmatter}\n---\nBody`, 'review')).toThrow('activation_skill_unsupported');
  });
  it.each(['---\nunterminated', '--- yaml\nname: review', '# Body\n!`run-command`'])('refuses malformed frontmatter and dynamic command interpolation', (text) => {
    expect(() => validateSkillText(text, 'review')).toThrow('activation_skill_unsupported');
  });
});
