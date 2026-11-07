import { describe, it, expect } from 'vitest';
import { replaceWildcards, WildcardContext } from './wildcard-replacer';

const ctx: WildcardContext = {
  agentName: 'bold-falcon',
  standbyBranch: 'bold-falcon/standby',
  agentPath: '.clubhouse/agents/bold-falcon/',
};

describe('replaceWildcards', () => {
  it('replaces @@AgentName', () => {
    expect(replaceWildcards('Hello @@AgentName!', ctx)).toBe('Hello bold-falcon!');
  });

  it('replaces @@StandbyBranch', () => {
    expect(replaceWildcards('Branch: @@StandbyBranch', ctx)).toBe('Branch: bold-falcon/standby');
  });

  it('replaces @@Path', () => {
    expect(replaceWildcards('Scope to @@Path', ctx)).toBe('Scope to .clubhouse/agents/bold-falcon/');
  });

  it('replaces multiple wildcards on the same line', () => {
    const input = '@@AgentName on branch @@StandbyBranch at @@Path';
    expect(replaceWildcards(input, ctx)).toBe(
      'bold-falcon on branch bold-falcon/standby at .clubhouse/agents/bold-falcon/',
    );
  });

  it('replaces multiple occurrences of the same wildcard', () => {
    expect(replaceWildcards('@@AgentName and @@AgentName', ctx)).toBe(
      'bold-falcon and bold-falcon',
    );
  });

  it('returns text unchanged when no wildcards are present', () => {
    const input = 'No wildcards here';
    expect(replaceWildcards(input, ctx)).toBe(input);
  });

  it('handles wildcards inside JSON strings', () => {
    const json = '{"allow": ["Read(@@Path**)", "Edit(@@Path**)"]}';
    expect(replaceWildcards(json, ctx)).toBe(
      '{"allow": ["Read(.clubhouse/agents/bold-falcon/**)", "Edit(.clubhouse/agents/bold-falcon/**)"]}',
    );
  });

  it('handles empty string', () => {
    expect(replaceWildcards('', ctx)).toBe('');
  });

  it('handles multiline text', () => {
    const input = 'Name: @@AgentName\nBranch: @@StandbyBranch\nPath: @@Path';
    expect(replaceWildcards(input, ctx)).toBe(
      'Name: bold-falcon\nBranch: bold-falcon/standby\nPath: .clubhouse/agents/bold-falcon/',
    );
  });
});

describe('@@SourceControlProvider replacement', () => {
  it('replaces @@SourceControlProvider with value', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'github' };
    expect(replaceWildcards('Provider: @@SourceControlProvider', ctxWithScp)).toBe(
      'Provider: github',
    );
  });

  it('replaces @@SourceControlProvider with empty string when not set', () => {
    expect(replaceWildcards('Provider: @@SourceControlProvider', ctx)).toBe('Provider: ');
  });

  it('replaces multiple occurrences of @@SourceControlProvider', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'azure-devops' };
    expect(replaceWildcards('@@SourceControlProvider/@@SourceControlProvider', ctxWithScp)).toBe(
      'azure-devops/azure-devops',
    );
  });
});

describe('what stays as written (D10, D60)', () => {
  it('leaves @@If / @@EndIf blocks alone: only Clubhouse Mode resolved them (managed-agents/legacy-migration)', () => {
    const input = 'Agent: @@AgentName\n@@If(github)\nPR for @@AgentName\n@@EndIf';
    expect(replaceWildcards(input, { ...ctx, sourceControlProvider: 'github' })).toBe('Agent: bold-falcon\n@@If(github)\nPR for bold-falcon\n@@EndIf');
  });

  it('leaves @@Mission and @@Persona exactly as written', () => {
    expect(replaceWildcards('@@AgentName: @@Mission / @@Persona', ctx)).toBe('bold-falcon: @@Mission / @@Persona');
  });
});

describe('@@BuildCommand / @@TestCommand / @@LintCommand replacement', () => {
  it('replaces @@BuildCommand with configured value', () => {
    const ctxWithCmd = { ...ctx, buildCommand: 'cargo build' };
    expect(replaceWildcards('Run: @@BuildCommand', ctxWithCmd)).toBe('Run: cargo build');
  });

  it('replaces @@TestCommand with configured value', () => {
    const ctxWithCmd = { ...ctx, testCommand: 'cargo test' };
    expect(replaceWildcards('Run: @@TestCommand', ctxWithCmd)).toBe('Run: cargo test');
  });

  it('replaces @@LintCommand with configured value', () => {
    const ctxWithCmd = { ...ctx, lintCommand: 'cargo clippy' };
    expect(replaceWildcards('Run: @@LintCommand', ctxWithCmd)).toBe('Run: cargo clippy');
  });

  it('falls back to npm defaults when commands not set', () => {
    expect(replaceWildcards('@@BuildCommand', ctx)).toBe('npm run build');
    expect(replaceWildcards('@@TestCommand', ctx)).toBe('npm test');
    expect(replaceWildcards('@@LintCommand', ctx)).toBe('npm run lint');
  });

  it('replaces all three commands in the same text', () => {
    const ctxWithCmds = {
      ...ctx,
      buildCommand: 'make build',
      testCommand: 'make test',
      lintCommand: 'make lint',
    };
    const input = '1. @@BuildCommand\n2. @@TestCommand\n3. @@LintCommand';
    expect(replaceWildcards(input, ctxWithCmds)).toBe('1. make build\n2. make test\n3. make lint');
  });
});
