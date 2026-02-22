import { describe, it, expect } from 'vitest';
import { replaceWildcards, unreplaceWildcards, WildcardContext } from './wildcard-replacer';

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

describe('@@If(value)...@@EndIf conditional blocks', () => {
  it('keeps block content when sourceControlProvider matches', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'github' };
    const input = '@@If(github)\nUse gh CLI\n@@EndIf';
    expect(replaceWildcards(input, ctxWithScp)).toBe('Use gh CLI\n');
  });

  it('strips block when sourceControlProvider does not match', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'azure-devops' };
    const input = '@@If(github)\nUse gh CLI\n@@EndIf';
    expect(replaceWildcards(input, ctxWithScp)).toBe('');
  });

  it('strips block when sourceControlProvider is not set', () => {
    const input = '@@If(github)\nUse gh CLI\n@@EndIf';
    expect(replaceWildcards(input, ctx)).toBe('');
  });

  it('handles multiple conditional blocks', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'github' };
    const input = [
      '@@If(github)',
      'GitHub section',
      '@@EndIf',
      '@@If(azure-devops)',
      'Azure section',
      '@@EndIf',
    ].join('\n');
    expect(replaceWildcards(input, ctxWithScp)).toBe('GitHub section\n');
  });

  it('preserves text outside conditional blocks', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'github' };
    const input = 'Before\n@@If(github)\nInside\n@@EndIf\nAfter';
    expect(replaceWildcards(input, ctxWithScp)).toBe('Before\nInside\nAfter');
  });

  it('handles multiline content in conditional blocks', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'github' };
    const input = '@@If(github)\nLine 1\nLine 2\nLine 3\n@@EndIf';
    expect(replaceWildcards(input, ctxWithScp)).toBe('Line 1\nLine 2\nLine 3\n');
  });

  it('replaces wildcards inside conditional blocks', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'github' };
    // Note: wildcards are replaced before conditional blocks are processed,
    // so @@AgentName is already replaced
    const input = 'Agent: @@AgentName\n@@If(github)\nPR for @@AgentName\n@@EndIf';
    // @@AgentName is replaced first, then conditionals are processed
    expect(replaceWildcards(input, ctxWithScp)).toBe(
      'Agent: bold-falcon\nPR for bold-falcon\n',
    );
  });
});

describe('unreplaceWildcards', () => {
  it('reverses agentName back to @@AgentName', () => {
    expect(unreplaceWildcards('Hello bold-falcon!', ctx)).toBe('Hello @@AgentName!');
  });

  it('reverses agentPath back to @@Path', () => {
    expect(unreplaceWildcards('Read(.clubhouse/agents/bold-falcon/**)', ctx)).toBe(
      'Read(@@Path**)',
    );
  });

  it('reverses standbyBranch back to @@StandbyBranch', () => {
    expect(unreplaceWildcards('Branch: bold-falcon/standby', ctx)).toBe(
      'Branch: @@StandbyBranch',
    );
  });

  it('uses longest-match-first to avoid partial replacements', () => {
    // agentPath contains agentName, so agentPath should be replaced first
    const input = 'Scope to .clubhouse/agents/bold-falcon/ and name bold-falcon';
    const result = unreplaceWildcards(input, ctx);
    expect(result).toBe('Scope to @@Path and name @@AgentName');
  });

  it('reverses sourceControlProvider', () => {
    const ctxWithScp = { ...ctx, sourceControlProvider: 'github' };
    expect(unreplaceWildcards('Provider: github', ctxWithScp)).toBe(
      'Provider: @@SourceControlProvider',
    );
  });

  it('returns text unchanged when no agent values are present', () => {
    const input = 'No agent-specific values here';
    expect(unreplaceWildcards(input, ctx)).toBe(input);
  });

  it('handles multiple occurrences', () => {
    const input = 'bold-falcon and bold-falcon again';
    expect(unreplaceWildcards(input, ctx)).toBe('@@AgentName and @@AgentName again');
  });

  it('handles empty string', () => {
    expect(unreplaceWildcards('', ctx)).toBe('');
  });

  it('round-trips with replaceWildcards for simple values', () => {
    const template = 'Read(@@Path**)';
    const resolved = replaceWildcards(template, ctx);
    expect(unreplaceWildcards(resolved, ctx)).toBe(template);
  });
});
