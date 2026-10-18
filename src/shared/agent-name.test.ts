import { describe, it, expect } from 'vitest';
import {
  validateAgentGitName,
  assertAgentGitName,
  AGENT_FOLDER_NAME_MAX_LENGTH,
  AGENT_BRANCH_NAME_MAX_LENGTH,
} from './agent-name';
import { generateDurableName } from './name-generator';

describe('validateAgentGitName (#2221)', () => {
  it.each(['bold-falcon', 'agent_1', 'A', 'x9', '_private', 'a'.repeat(AGENT_FOLDER_NAME_MAX_LENGTH)])(
    'accepts folder name %j', (name) => {
      expect(validateAgentGitName(name, 'folder')).toBeNull();
    },
  );

  it('accepts every generated durable name', () => {
    for (let i = 0; i < 200; i++) expect(validateAgentGitName(generateDurableName(), 'folder')).toBeNull();
  });

  it.each([
    '', ' ', 'my agent', '$(id)', '`id`', 'a;b', 'a|b', 'a&b', 'a>b', 'a"b', "a'b", 'a\nb', 'a\tb', 'a\0b',
    '../x', '..', 'a..b', '.x', '-x', '--help', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a~b', 'a^b', 'a@{1}',
    'p\u0430ypal', '\uff41gent', 'a\u200db', 'caf\u00e9', 'CON', 'nul', 'Com1', 'lpt9',
    'a'.repeat(AGENT_FOLDER_NAME_MAX_LENGTH + 1),
  ])('rejects folder name %j', (name) => {
    expect(validateAgentGitName(name, 'folder')).toMatch(/^Agent name /);
  });

  it.each(['bold-falcon/standby', 'a/b/c', 'durable_1_x/cleanup'])('accepts branch name %j', (name) => {
    expect(validateAgentGitName(name, 'branch')).toBeNull();
  });

  it.each([
    '', '/a', 'a/', 'a//b', 'a/-b', '-a/b', 'a/.b', 'a/../b', 'a b/c', 'a/b:c', 'a/$(id)', 'a/b\n',
    `a/${'b'.repeat(AGENT_BRANCH_NAME_MAX_LENGTH)}`,
  ])('rejects branch name %j', (name) => {
    expect(validateAgentGitName(name, 'branch')).toMatch(/^Branch name /);
  });

  it('rejects non-strings', () => {
    expect(validateAgentGitName(undefined)).not.toBeNull();
    expect(validateAgentGitName(42)).not.toBeNull();
  });

  it('assertAgentGitName throws an Invalid ... name error', () => {
    expect(() => assertAgentGitName('../x')).toThrow(/^Invalid agent name: /);
    expect(() => assertAgentGitName('-x/y', 'branch')).toThrow(/^Invalid branch name: /);
    expect(() => assertAgentGitName('ok-name')).not.toThrow();
  });
});
