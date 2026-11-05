import { describe, expect, it } from 'vitest';
import {
  adoptNativeMcpServer,
  agentMetadata,
  MAX_SKILL_FILE_BYTES,
  nameIssues,
  previewPayload,
  sourceIssues,
  validateComposition,
  validatePayload,
} from './validation';
import type { CatalogEntry, ValidationCode, ValidationIssue } from '../../../shared/asset-catalog-types';

/** Synthetic: the shape of a real token, with no real credential behind it. */
const FAKE_GH_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const FAKE_JWT = `eyJhbGciOiJub25l.${'eyJzdWIiOiIxIn0'}.${'c2lnbmF0dXJl'}`;
const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

function issuesOf(result: { ok: boolean; issues?: ValidationIssue[] }): ValidationIssue[] {
  return result.ok ? [] : result.issues ?? [];
}

function codes(result: { ok: boolean; issues?: ValidationIssue[] }): ValidationCode[] {
  return issuesOf(result).map((issue) => issue.code);
}

const stdio = { serverKey: 'workiq', transport: 'stdio', command: 'npx', args: ['-y', '@microsoft/workiq', 'mcp'] };
const skill = { skillName: 'code-review', files: [{ path: 'SKILL.md', content: '# Review' }] };
const preset = { instruction: 'doc-1', skills: ['skill-1'], mcps: ['mcp-1'] };

describe('MCP definitions', () => {
  it('accepts stdio and URL transports and rejects mismatched fields', () => {
    expect(validatePayload('mcp', stdio).ok).toBe(true);
    expect(validatePayload('mcp', { serverKey: 'a', transport: 'http', url: 'https://example.test/mcp' }).ok).toBe(true);
    expect(codes(validatePayload('mcp', { serverKey: 'a', transport: 'stdio', url: 'https://example.test' }))).toContain('invalid_transport_fields');
    expect(codes(validatePayload('mcp', { serverKey: 'a', transport: 'http', command: 'x', url: 'https://example.test' }))).toContain('invalid_transport_fields');
    expect(codes(validatePayload('mcp', { serverKey: 'a', transport: 'sse', url: 'file:///etc/passwd' }))).toContain('invalid_url');
  });

  it('rejects an unknown field: a schema with a gap would let a header or provider through', () => {
    expect(codes(validatePayload('mcp', { ...stdio, headers: { Authorization: 'x' } }))).toContain('unknown_field');
  });

  it('reserves Clubhouse namespaces for built-ins', () => {
    for (const serverKey of ['clubhouse', 'Clubhouse-bridge', 'clubhouse_x', 'clubhouse.y']) {
      expect(codes(validatePayload('mcp', { ...stdio, serverKey }))).toContain('reserved_namespace');
      expect(validatePayload('mcp', { ...stdio, serverKey }, true).ok).toBe(true);
    }
    expect(validatePayload('mcp', { ...stdio, serverKey: 'clubhouses' }).ok).toBe(true);
    expect(codes(validatePayload('mcp', { ...stdio, env: { CLUBHOUSE_NONCE: '1' } }))).toContain('reserved_namespace');
    expect(codes(validatePayload('mcp', { ...stdio, envVars: ['CLUBHOUSE_NONCE'] }))).toContain('reserved_namespace');
  });

  it('rejects object-key traps in ids and env names', () => {
    expect(codes(validatePayload('mcp', { ...stdio, serverKey: '__proto__' }))).not.toEqual([]);
    expect(codes(validatePayload('mcp', { ...stdio, env: JSON.parse('{"__proto__":"x"}') }))).toContain('invalid_identifier');
  });

  describe('secrets', () => {
    it.each([
      ['a secret-named env literal', { env: { API_TOKEN: 'abc' } }, 'env.API_TOKEN'],
      ['a token value under an innocent name', { env: { NOTE: FAKE_GH_TOKEN } }, 'env.NOTE'],
      ['a flag with a value after it', { args: ['--token', 'abc'] }, 'args[0]'],
      ['a flag with an inline value', { args: ['--api-key=abc'] }, 'args[0]'],
      ['a bare token argument', { args: [FAKE_JWT] }, 'args[0]'],
      ['a token in the command', { command: `run ${FAKE_GH_TOKEN}` }, 'command'],
    ])('rejects %s, naming the place and not the value', (_label, patch, path) => {
      const result = validatePayload('mcp', { ...stdio, ...patch });
      expect(issuesOf(result)).toContainEqual({ code: 'secret_value', path });
      expect(JSON.stringify(result)).not.toContain('abc');
      expect(JSON.stringify(result)).not.toContain(FAKE_GH_TOKEN);
      expect(JSON.stringify(result)).not.toContain(FAKE_JWT);
    });

    it('rejects credentials in a URL', () => {
      const http = { serverKey: 'a', transport: 'http' };
      expect(issuesOf(validatePayload('mcp', { ...http, url: 'https://user:hunter2@example.test/' }))).toContainEqual({ code: 'secret_value', path: 'url' });
      expect(issuesOf(validatePayload('mcp', { ...http, url: 'https://example.test/?api_key=hunter2' }))).toContainEqual({ code: 'secret_value', path: 'url' });
    });

    it('rejects credentials in an upstream package source', () => {
      const upstream = { package: 'https://user:hunter2@registry.example.test/pkg' };
      expect(issuesOf(validatePayload('mcp', { ...stdio, upstream }))).toContainEqual({ code: 'secret_value', path: 'upstream' });
    });

    it('allows a forwarded reference, and counts that are not secrets', () => {
      expect(validatePayload('mcp', { ...stdio, envVars: ['GITHUB_TOKEN'] }).ok).toBe(true);
      expect(validatePayload('mcp', { ...stdio, env: { MAX_TOKENS: '4000', LOG_LEVEL: 'debug' } }).ok).toBe(true);
      expect(validatePayload('mcp', { ...stdio, args: ['--max-tokens', '4000', '--verbose'] }).ok).toBe(true);
    });

    it('a name is either literal or forwarded, not both', () => {
      expect(validatePayload('mcp', { ...stdio, env: { LOG_LEVEL: 'x' }, envVars: ['LOG_LEVEL'] }).ok).toBe(false);
    });
  });

  it('marks an upstream version as floating unless it is exact', () => {
    const projection = (version?: string) => {
      const result = validatePayload('mcp', { ...stdio, upstream: { package: '@microsoft/workiq', ...(version && { version }) } });
      if (result.ok !== true || result.projection.kind !== 'mcp') throw new Error('expected a valid mcp');
      return result.projection.upstream;
    };
    expect(projection()?.floating).toBe(true);
    expect(projection('latest')?.floating).toBe(true);
    expect(projection('^1.2.0')?.floating).toBe(true);
    expect(projection('1.2.0')?.floating).toBe(false);
  });
});

describe('native MCP adoption', () => {
  it('turns a same-name reference into the forwarded reference, and keeps plain literals', () => {
    const result = adoptNativeMcpServer('github', { command: 'gh-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG_LEVEL: 'debug' } });
    expect(result).toMatchObject({ ok: true, payload: { envVars: ['GITHUB_TOKEN'], env: { LOG_LEVEL: 'debug' } } });
    expect(JSON.stringify(result)).not.toContain('${GITHUB_TOKEN}');
  });

  it('keeps native env_vars and infers the transport', () => {
    expect(adoptNativeMcpServer('a', { command: 'x', env_vars: ['FOO'] })).toMatchObject({ ok: true, payload: { transport: 'stdio', envVars: ['FOO'] } });
    expect(adoptNativeMcpServer('a', { url: 'https://example.test' })).toMatchObject({ ok: true, payload: { transport: 'http' } });
    expect(adoptNativeMcpServer('a', { type: 'sse', url: 'https://example.test' })).toMatchObject({ ok: true, payload: { transport: 'sse' } });
  });

  it.each([
    ['a literal secret', { command: 'x', env: { API_KEY: 'abc123' } }, 'env.API_KEY', 'secret_value'],
    ['a reference under another name', { command: 'x', env: { API_KEY: '${OTHER}' } }, 'env.API_KEY', 'secret_value'],
    ['auth headers', { url: 'https://example.test', headers: { Authorization: 'Bearer abc123' } }, 'headers', 'secret_value'],
    ['a field this catalog does not model', { command: 'x', timeout: 5 }, 'timeout', 'unsupported_native_field'],
    ['an unknown transport', { command: 'x', type: 'pipe' }, 'type', 'unsupported_native_field'],
  ])('blocks %s rather than dropping or copying it', (_label, raw, path, code) => {
    const result = adoptNativeMcpServer('a', raw);
    expect(result.ok).toBe(false);
    expect(issuesOf(result)).toContainEqual({ code, path });
    expect(JSON.stringify(result)).not.toContain('abc123');
  });

  it('never adopts over the Clubhouse bridge key', () => {
    expect(codes(adoptNativeMcpServer('clubhouse', { command: 'x' }))).toContain('reserved_namespace');
  });
});

describe('skill bundles', () => {
  it('requires a complete bundle', () => {
    expect(validatePayload('skill', skill).ok).toBe(true);
    expect(codes(validatePayload('skill', { skillName: 'a', files: [{ path: 'notes.md', content: 'x' }] }))).toContain('missing_skill_entrypoint');
    expect(codes(validatePayload('skill', { skillName: 'a', files: 'nope' }))).toContain('invalid_shape');
  });

  it('sorts files, so the same bundle always hashes the same', () => {
    const result = validatePayload('skill', { skillName: 'a', files: [{ path: 'b.md', content: '' }, { path: 'SKILL.md', content: '' }, { path: 'a/c.md', content: '' }] });
    expect(result.ok === true && result.payload.files.map((file) => file.path)).toEqual(['SKILL.md', 'a/c.md', 'b.md']);
  });

  it.each([
    '../evil.md', 'a/../../evil.md', '/etc/passwd', 'C:\\evil.md', 'C:/evil.md', 'a\\b.md', 'a//b.md', 'a/./b.md',
    'CON', 'nul.txt', 'lpt1/x.md', 'trailing.', 'trailing /x', 'stream:ads', 'what?.md', 'tab\there',
  ])('rejects the unsafe or non-portable path %j', (path) => {
    const files = [{ path: 'SKILL.md', content: '' }, { path, content: '' }];
    expect(codes(validatePayload('skill', { skillName: 'a', files }))).toContain('invalid_skill_path');
  });

  it('rejects paths that collide on a case-insensitive disk, and a file beside its own directory', () => {
    const base = { path: 'SKILL.md', content: '' };
    expect(codes(validatePayload('skill', { skillName: 'a', files: [base, { path: 'A.md', content: '' }, { path: 'a.md', content: '' }] }))).toContain('duplicate_skill_path');
    expect(codes(validatePayload('skill', { skillName: 'a', files: [base, { path: 'd', content: '' }, { path: 'd/x.md', content: '' }] }))).toContain('duplicate_skill_path');
  });

  it('rejects an unsafe skill name, which becomes a directory', () => {
    for (const skillName of ['../x', 'a/b', 'aux', 'x.', '__proto__']) {
      expect(codes(validatePayload('skill', { ...skill, skillName }))).toContain('invalid_identifier');
    }
    expect(codes(validatePayload('skill', { ...skill, skillName: 'clubhouse-mission' }))).toContain('reserved_namespace');
  });

  it('rejects credential files and token content, including in base64', () => {
    const base = { path: 'SKILL.md', content: '' };
    for (const path of ['.env', '.env.local', 'config/.npmrc', 'id_rsa', 'deploy.pem', 'credentials.json']) {
      expect(codes(validatePayload('skill', { skillName: 'a', files: [base, { path, content: '' }] }))).toContain('credential_file');
    }
    expect(codes(validatePayload('skill', { skillName: 'a', files: [{ path: 'SKILL.md', content: FAKE_GH_TOKEN }] }))).toContain('secret_value');
    const encoded = Buffer.from(FAKE_PEM).toString('base64');
    expect(codes(validatePayload('skill', { skillName: 'a', files: [base, { path: 'x.bin', content: encoded, encoding: 'base64' }] }))).toContain('secret_value');
  });

  it('rejects invalid base64 and oversized files', () => {
    const base = { path: 'SKILL.md', content: '' };
    expect(codes(validatePayload('skill', { skillName: 'a', files: [base, { path: 'x.bin', content: '***', encoding: 'base64' }] }))).toContain('invalid_encoding');
    expect(codes(validatePayload('skill', { skillName: 'a', files: [base, { path: 'x.md', content: 'x'.repeat(MAX_SKILL_FILE_BYTES + 1) }] }))).toContain('too_large');
  });
});

describe('instruction documents', () => {
  it('accepts wildcards as written and rejects empty text', () => {
    const result = validatePayload('instruction', { content: 'You are @@AgentName in @@Path.' });
    expect(result.ok === true && result.payload.content).toBe('You are @@AgentName in @@Path.');
    expect(validatePayload('instruction', { content: '  \n' }).ok).toBe(false);
  });

  it('rejects a token, which immutable revisions could never give back', () => {
    expect(codes(validatePayload('instruction', { content: `key ${FAKE_PEM}` }))).toContain('secret_value');
  });

  it('allows prose about secrets', () => {
    expect(validatePayload('instruction', { content: 'Never print a token: ask for the password instead.' }).ok).toBe(true);
  });

  it('rejects persona front matter: launch settings stay out of documents', () => {
    expect(codes(validatePayload('instruction', { content: '---\nmodel: claude-opus-4-8\n---\nBody' }))).toContain('launch_settings_in_instruction');
    expect(codes(validatePayload('instruction', { content: '---\norchestrator: codex-cli\n---\nBody' }))).toContain('launch_settings_in_instruction');
    expect(validatePayload('instruction', { content: '---\nA rule, then text\n---\nBody' }).ok).toBe(true);
  });
});

describe('Agent Presets', () => {
  it('accepts one instruction and operational defaults', () => {
    const result = validatePayload('preset', {
      ...preset,
      operationalDefaults: { agentAccess: 'auto', orchestrate: true, access: 'same', control: 'ask-before-start', maxHelpers: 3, crossProjectHelpers: false, connectToDispatcher: true },
    });
    expect(result.ok).toBe(true);
  });

  it.each(['provider', 'orchestrator', 'model', 'effort', 'reasoningEffort', 'reasoning_effort', 'contextWindow', 'context-window', 'routing', 'providerRouting', 'Model'])(
    'rejects the launch setting %s, at the top and inside defaults',
    (field) => {
      expect(codes(validatePayload('preset', { ...preset, [field]: 'x' }))).toContain('forbidden_preset_field');
      expect(codes(validatePayload('preset', { ...preset, operationalDefaults: { [field]: 'x' } }))).toContain('forbidden_preset_field');
    },
  );

  it('requires exactly one instruction document', () => {
    expect(codes(validatePayload('preset', { skills: [], mcps: [] }))).toContain('invalid_instruction_cardinality');
    expect(codes(validatePayload('preset', { instruction: ['a', 'b'], skills: [], mcps: [] }))).toContain('invalid_instruction_cardinality');
    expect(codes(validatePayload('preset', { ...preset, instructions: ['a', 'b'] }))).toContain('invalid_instruction_cardinality');
  });

  it('has no nested presets or snippets', () => {
    expect(codes(validatePayload('preset', { ...preset, presets: ['p'] }))).toContain('nested_preset');
    expect(codes(validatePayload('preset', { ...preset, snippets: ['s'] }))).toContain('unknown_field');
  });

  it('rejects duplicates and invalid operational values, without clamping', () => {
    expect(codes(validatePayload('preset', { ...preset, skills: ['a', 'a'] }))).toContain('duplicate_reference');
    for (const operationalDefaults of [{ maxHelpers: 100000 }, { maxHelpers: null }, { access: 'root' }, { control: 'nope' }, { agentAccess: 'same' }, { orchestrate: 'yes' }]) {
      expect(codes(validatePayload('preset', { ...preset, operationalDefaults }))).toContain('invalid_operational_default');
    }
  });
});

describe('names, provenance, compositions', () => {
  it('checks names', () => {
    expect(nameIssues('Release notes')).toEqual([]);
    expect(nameIssues('')).toEqual([{ code: 'invalid_name', path: 'name' }]);
    expect(nameIssues('a\nb')).toEqual([{ code: 'invalid_name', path: 'name' }]);
    expect(nameIssues(FAKE_GH_TOKEN)).toEqual([{ code: 'secret_value', path: 'name' }]);
  });

  it('keeps provenance to ids, and copies out of ordinary saves', () => {
    expect(sourceIssues({ kind: 'user' })).toEqual([]);
    expect(sourceIssues({ kind: 'builtin', builtinId: 'orchestrator' })).toEqual([]);
    expect(sourceIssues({ kind: 'import', from: 'project-skill', projectId: 'p1', nativeName: 'code-review' })).toEqual([]);
    expect(sourceIssues({ kind: 'import', from: 'project-skill', nativeName: '/Users/someone/skill' })).not.toEqual([]);
    expect(sourceIssues({ kind: 'import', from: 'project-skill', path: '/Users/someone' })).not.toEqual([]);
    expect(sourceIssues({ kind: 'copy', originAssetId: 'a', originRevision: 1 })).not.toEqual([]);
  });

  it('a composition can name nothing but assets', () => {
    const valid = { basePresetId: null, additions: [], removals: [], instructionAssetId: null };
    expect(validateComposition(valid).ok).toBe(true);
    for (const field of ['sessionId', 'worktreePath', 'wires', 'helpers', 'provider', 'model']) {
      expect(codes(validateComposition({ ...valid, [field]: 'x' }))).toContain('unknown_field');
    }
    expect(codes(validateComposition({ ...valid, additions: ['../x'] }))).toContain('invalid_identifier');
    expect(codes(validateComposition({ ...valid, additions: ['a', 'a'] }))).toContain('duplicate_reference');
  });
});

describe('redaction', () => {
  it('previews an MCP definition with no env values, URL query or userinfo', () => {
    const preview = previewPayload('mcp', {
      serverKey: 'a',
      transport: 'http',
      url: 'https://user:hunter2@example.test/mcp?state=hunter3',
      env: { LOG_LEVEL: 'hunter4' },
      envVars: ['GITHUB_TOKEN'],
    });
    const text = JSON.stringify(preview);
    for (const secret of ['hunter2', 'hunter3', 'hunter4', 'user:']) expect(text).not.toContain(secret);
    expect(preview).toMatchObject({ url: 'https://example.test/mcp', envNames: ['LOG_LEVEL'], envVars: ['GITHUB_TOKEN'] });
  });

  it('scrubs text it is handed, and shows binary files by size', () => {
    expect(JSON.stringify(previewPayload('instruction', { content: `x ${FAKE_GH_TOKEN} y` }))).not.toContain(FAKE_GH_TOKEN);
    const preview = previewPayload('skill', {
      skillName: 'a',
      files: [{ path: 'SKILL.md', content: FAKE_JWT }, { path: 'x.bin', content: 'aGk=', encoding: 'base64' }],
    });
    expect(JSON.stringify(preview)).not.toContain(FAKE_JWT);
    expect(preview).toMatchObject({ files: [{ path: 'SKILL.md' }, { path: 'x.bin', bytes: 2 }] });
    expect(JSON.stringify(preview)).not.toContain('aGk=');
  });

  it('tells an agent the kind of provenance and no more', () => {
    const entry: CatalogEntry = {
      id: 'a',
      kind: 'skill',
      name: 'Skill',
      owner: { kind: 'agent', agentId: 'agent-1' },
      source: { kind: 'import', from: 'project-skill', projectId: 'secret-project', nativeName: 'secret-name' },
      createdAt: '',
      headRevision: 2,
      revisions: [],
    };
    const metadata = agentMetadata(entry);
    expect(metadata).toEqual({ id: 'a', kind: 'skill', name: 'Skill', headRevision: 2, ownerKind: 'agent', sourceKind: 'import' });
    expect(JSON.stringify(metadata)).not.toContain('secret');
  });
});
