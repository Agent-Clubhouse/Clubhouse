import { describe, expect, it } from 'vitest';
import { declaredDependencies } from './dependencies';
import type { ManagedSkillContent } from '../../../shared/managed-agents-types';

const skill = (files: Record<string, string>): ManagedSkillContent =>
  ({ kind: 'skill', skillName: 's', files: Object.entries(files).map(([path, content]) => ({ path, content })) });

describe('declared dependencies in an import preview (#2855)', () => {
  it('says none_declared rather than not_confirmed when the manifests declare nothing', () => {
    expect(declaredDependencies(skill({ 'SKILL.md': '---\nname: s\n---\nBody' }))).toMatchObject({ status: 'none_declared', declared: [] });
    expect(declaredDependencies({ kind: 'mcp', serverKey: 'x', transport: 'stdio' })).toMatchObject({ status: 'none_declared' });
  });

  it('reads SKILL.md front matter and bundled package manifests, never the body', () => {
    const result = declaredDependencies(skill({
      'SKILL.md': '---\nname: s\nallowed-tools: Bash(git:*), Read mcp__tickets__search\ncompatibility: "Needs git 2.40"\ndependencies:\n  - ripgrep\n---\nallowed-tools: Body-only',
      'package.json': JSON.stringify({ dependencies: { lodash: '^4' }, devDependencies: { vitest: '1' } }),
      'requirements.txt': '# tools\nrequests>=2\n-r other.txt\npyyaml==6 # parse\n',
      'nested/package.json': JSON.stringify({ dependencies: { ignored: '1' } }),
    }));
    expect(result.status).toBe('declared');
    expect(result.declared.map((d) => `${d.kind}:${d.name}`)).toEqual([
      'tool:Bash(git:*)', 'tool:Read', 'mcp_server:tickets', 'environment:Needs git 2.40', 'declared:ripgrep', 'npm:lodash', 'pip:requests', 'pip:pyyaml',
    ]);
  });

  it('names the package an MCP launcher fetches, the command, or the remote host only', () => {
    expect(declaredDependencies({ kind: 'mcp', serverKey: 'gh', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }).declared)
      .toEqual([{ kind: 'command', name: 'npx', from: 'MCP command' }, { kind: 'npm', name: '@modelcontextprotocol/server-github', from: 'MCP command' }]);
    expect(declaredDependencies({ kind: 'mcp', serverKey: 'f', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }).declared.map((d) => d.kind)).toEqual(['command', 'pip']);
    const remote = declaredDependencies({ kind: 'mcp', serverKey: 'r', transport: 'http', url: 'https://mcp.example.com/path?token=secret' });
    expect(remote.declared).toEqual([{ kind: 'remote', name: 'mcp.example.com', from: 'MCP url' }]);
    expect(JSON.stringify(remote)).not.toContain('secret');
  });

  it('bounds the list', () => {
    const deps = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`pkg-${i}`, '1']));
    const result = declaredDependencies(skill({ 'SKILL.md': 'x', 'package.json': JSON.stringify({ dependencies: deps }) }));
    expect(result.declared).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});
