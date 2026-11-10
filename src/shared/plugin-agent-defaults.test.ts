import { describe, it, expect } from 'vitest';
import { ALL_PLUGIN_PARTS_REMOVED, assertPluginAgentDefaultsParts, withPluginParts } from './plugin-agent-defaults';

const block = (id: string, text: string) => `<!-- plugin:${id}:start -->\n${text}\n<!-- plugin:${id}:end -->`;

describe('withPluginParts (#3262)', () => {
  it('appends, replaces and removes the plugin\'s instruction block, keeping the rest', () => {
    const appended = withPluginParts({ instructions: 'Base' }, 'foo', { instructions: 'One' });
    expect(appended?.instructions).toBe(`Base\n\n${block('foo', 'One')}`);
    const replaced = withPluginParts({ instructions: `Base\n\n${block('foo', 'One')}\n\n${block('bar', 'B')}` }, 'foo', { instructions: 'Two' });
    expect(replaced?.instructions).toBe(`Base\n\n${block('bar', 'B')}\n\n${block('foo', 'Two')}`);
    expect(withPluginParts({ instructions: `Base\n\n${block('foo', 'One')}` }, 'foo', { instructions: null })?.instructions).toBe('Base');
  });

  it('replaces only its own tagged rules, per kind', () => {
    const next = withPluginParts(
      { permissions: { allow: ['Read(**)', 'Old /* plugin:foo */', 'B /* plugin:bar */'], deny: ['D /* plugin:foo */'] } },
      'foo',
      { allow: ['New'] },
    );
    expect(next?.permissions).toEqual({ allow: ['Read(**)', 'B /* plugin:bar */', 'New /* plugin:foo */'], deny: ['D /* plugin:foo */'] });
  });

  it('replaces only its own prefixed MCP servers', () => {
    const current = { mcpJson: JSON.stringify({ mcpServers: { mine: { command: 'a' }, 'plugin-foo-old': {}, 'plugin-bar-x': {} } }) };
    const next = withPluginParts(current, 'foo', { mcpServers: { srv: { command: 'p' } } });
    expect(JSON.parse(next!.mcpJson!).mcpServers).toEqual({ mine: { command: 'a' }, 'plugin-bar-x': {}, 'plugin-foo-srv': { command: 'p' } });
  });

  it('returns null when nothing would change, so nothing is written', () => {
    expect(withPluginParts({}, 'foo', ALL_PLUGIN_PARTS_REMOVED)).toBeNull();
    expect(withPluginParts({ permissions: { allow: ['A /* plugin:foo */'] } }, 'foo', { allow: ['A'] })).toBeNull();
    const mcpJson = JSON.stringify({ mcpServers: { 'plugin-foo-srv': { command: 'p' } } });
    expect(withPluginParts({ mcpJson }, 'foo', { mcpServers: { srv: { command: 'p' } } })).toBeNull();
  });

  it('removes every part on uninstall and leaves other keys alone', () => {
    const next = withPluginParts({
      instructions: `Base\n\n${block('foo', 'X')}`,
      permissions: { allow: ['Read(**)', 'A /* plugin:foo */'], deny: ['D /* plugin:foo */'] },
      mcpJson: JSON.stringify({ mcpServers: { 'plugin-foo-srv': {} } }),
      buildCommand: 'make',
    }, 'foo', ALL_PLUGIN_PARTS_REMOVED);
    expect(next).toEqual({
      instructions: 'Base',
      permissions: { allow: ['Read(**)'], deny: [] },
      mcpJson: JSON.stringify({ mcpServers: {} }, null, 2),
      buildCommand: 'make',
    });
  });

  it('treats a plugin id with regex characters literally', () => {
    const next = withPluginParts({ instructions: `Base\n\n${block('a.b', 'X')}\n\n${block('axb', 'Y')}` }, 'a.b', { instructions: null });
    expect(next?.instructions).toBe(`Base\n\n${block('axb', 'Y')}`);
  });
});

describe('assertPluginAgentDefaultsParts', () => {
  it('accepts the known parts and refuses anything else', () => {
    expect(() => assertPluginAgentDefaultsParts({ instructions: 'x', allow: ['a'], deny: null, mcpServers: {} })).not.toThrow();
    expect(() => assertPluginAgentDefaultsParts({ buildCommand: 'x' })).toThrow('Unknown plugin agent default: buildCommand');
    expect(() => assertPluginAgentDefaultsParts({ buildCommand: null })).toThrow('Unknown plugin agent default: buildCommand');
    expect(() => assertPluginAgentDefaultsParts({ allow: 'a' })).toThrow(/allow/);
    expect(() => assertPluginAgentDefaultsParts({ mcpServers: [] })).toThrow(/MCP/);
    expect(() => assertPluginAgentDefaultsParts([])).toThrow();
  });
});
