import { describe, expect, it } from 'vitest';
import { DIAG_MAX_META_BYTES, DIAG_MAX_STRING_CHARS } from '../../shared/telemetry/diag';
import { createDiagRedactor, isContentKey, isSecretKey, REDACTED } from './diag-redaction';

const HOME = '/Users/sam-tester';
const r = createDiagRedactor({ homeDir: HOME });

describe('diag redaction', () => {
  it('replaces the home directory and keeps the rest of the path and the error text', () => {
    expect(r.text(`ENOENT: no such file, open '${HOME}/src/app/.clubhouse/agents.json'`)).toBe(
      "ENOENT: no such file, open '<home>/src/app/.clubhouse/agents.json'",
    );
    // Paths outside home and raw ids stay: that is what diag lines are for.
    expect(r.text('cwd /opt/repo session 3f2a9c1e-7b4d-4e8f-9a6b-2c1d0e9f8a7b')).toBe('cwd /opt/repo session 3f2a9c1e-7b4d-4e8f-9a6b-2c1d0e9f8a7b');
  });

  it('replaces a Windows home in every spelling', () => {
    const win = createDiagRedactor({ homeDir: 'C:\\Users\\Sam' });
    expect(win.text('C:\\Users\\Sam\\repo and c:/users/sam/repo and C:\\\\Users\\\\Sam\\\\x')).toBe('<home>\\repo and <home>/repo and <home>\\\\x');
  });

  it('redacts secrets in text', () => {
    const cases: Array<[string, string]> = [
      ['Authorization: Bearer abcdef123456.xyz', `Authorization: Bearer ${REDACTED}`],
      ['GET https://api.example.com/x?token=s3cr3t&page=2', `GET https://api.example.com/x?token=${REDACTED}&page=2`],
      ['config {"apiKey": "my key value", "n": 1}', `config {"apiKey": "${REDACTED}", "n": 1}`],
      ["password='hunter2 two'", `password='${REDACTED}'`],
      ['client_secret=abc', `client_secret=${REDACTED}`],
      ['spawn claude --api-key sk-live-1 --model x', `spawn claude --api-key ${REDACTED} --model x`],
      ['clone https://bob:pa55@github.com/o/r.git', `clone https://${REDACTED}@github.com/o/r.git`],
      ['key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA used', `key ${REDACTED} used`],
      ['gh ghp_abcdefghijklmnopqrstuvwxyz0123 ok', `gh ${REDACTED} ok`],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', `jwt ${REDACTED}`],
      ['aws AKIAABCDEFGHIJKLMNOP', `aws ${REDACTED}`],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', REDACTED],
    ];
    for (const [input, expected] of cases) expect(r.text(input), input).toBe(expected);
    // Ordinary prose about tokens is left alone.
    expect(r.text('Failed to refresh the token for this agent')).toBe('Failed to refresh the token for this agent');
  });

  it('caps strings at 2,000 characters', () => {
    const out = r.text('x'.repeat(DIAG_MAX_STRING_CHARS * 5));
    expect(out.startsWith('x'.repeat(DIAG_MAX_STRING_CHARS))).toBe(true);
    expect(out.length).toBeLessThan(DIAG_MAX_STRING_CHARS + 20);
    expect(out).toMatch(/…\[cut\]$/);
  });

  it('never writes prompt or response content, tool or RPC arguments, or env values (#1919)', () => {
    const mission = 'MISSION-CANARY fix the login bug';
    const out = r.meta({
      prompt: mission,
      systemPrompt: mission,
      appendSystemPrompt: mission,
      mission,
      args: ['-p', mission, '--model', 'opus'],
      params: { sessionId: 's', prompt: [{ type: 'text', text: mission }] },
      messages: [{ role: 'user', content: mission }],
      content: mission,
      response: mission,
      env: { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxxxxxxxxxxxx', PATH: '/usr/bin' },
      method: 'session/prompt',
      id: 7,
    });
    expect(JSON.stringify(out)).not.toContain('MISSION-CANARY');
    expect(JSON.stringify(out)).not.toContain('sk-ant');
    expect(JSON.stringify(out)).not.toContain('/usr/bin');
    expect(out).toMatchObject({
      prompt: `<redacted: ${mission.length} chars>`,
      args: '<redacted: 4 items>',
      params: '<redacted: 2 keys>',
      messages: '<redacted: 1 items>',
      // Which variables were set is kept; their values never are.
      env: { ANTHROPIC_API_KEY: REDACTED, PATH: REDACTED },
      method: 'session/prompt',
      id: 7,
    });
  });

  it('redacts secret-named keys at any depth, but keeps numeric counts', () => {
    const out = r.meta({
      headers: { Authorization: 'Bearer abc', Cookie: 'a=b', accept: 'json' },
      auth: { access_token: 'tok', refreshToken: 'tok2', expiresIn: 3600 },
      apiKey: 'k',
      usage: { inputTokens: 1200, maxTokens: 4096 },
      hasToken: true,
    });
    expect(out).toEqual({
      headers: { Authorization: REDACTED, Cookie: REDACTED, accept: 'json' },
      auth: { access_token: REDACTED, refreshToken: REDACTED, expiresIn: 3600 },
      apiKey: REDACTED,
      usage: { inputTokens: 1200, maxTokens: 4096 },
      hasToken: true,
    });
  });

  it('keeps error details with home and secrets redacted', () => {
    const err = Object.assign(new Error(`spawn ${HOME}/bin/claude ENOENT token=abc`), { code: 'ENOENT' });
    const out = r.meta({ error: err, stderr: `warning in ${HOME}/x`, exitCode: 1, lastOutput: 'Error: login required' });
    expect(out.error).toMatchObject({ name: 'Error', message: `spawn <home>/bin/claude ENOENT token=${REDACTED}`, code: 'ENOENT' });
    expect(String((out.error as { stack: string }).stack)).not.toContain(HOME);
    expect(out).toMatchObject({ stderr: 'warning in <home>/x', exitCode: 1, lastOutput: 'Error: login required' });
  });

  it('handles values JSON cannot', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const out = r.meta({
      circular,
      big: 10n,
      fn: () => 1,
      nan: Number.NaN,
      when: new Date(0),
      buf: Buffer.from('abc'),
      deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
      list: Array.from({ length: 100 }, (_, i) => i),
    });
    expect(out.circular).toEqual({ a: 1, self: '<circular>' });
    expect(out).toMatchObject({ big: '10', nan: 'NaN', when: '1970-01-01T00:00:00.000Z', buf: '<binary: 3 bytes>' });
    expect('fn' in out).toBe(false);
    expect(JSON.stringify(out.deep)).toContain('<too deep>');
    expect((out.list as unknown[]).length).toBe(65);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('caps meta at 8 KB, keeping the first keys', () => {
    const out = r.meta({ first: 'kept', a: 'a'.repeat(1900), b: 'b'.repeat(1900), c: 'c'.repeat(1900), d: 'd'.repeat(1900), e: 'e'.repeat(1900), f: { nested: 'f'.repeat(1900) } });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(DIAG_MAX_META_BYTES);
    expect(out.first).toBe('kept');
    expect(out.a).toBe('a'.repeat(1900));
    expect(out['<truncated>']).toBeDefined();
    // Small meta passes untouched.
    expect(r.meta({ x: 1 })).toEqual({ x: 1 });
  });

  it('classifies keys', () => {
    for (const k of ['prompt', 'systemPrompt', 'user_prompt', 'args', 'params', 'env', 'toolInput', 'messages']) expect(isContentKey(k), k).toBe(true);
    for (const k of ['lastOutput', 'stderr', 'error', 'message', 'method', 'path', 'sessionId']) expect(isContentKey(k), k).toBe(false);
    for (const k of ['token', 'accessToken', 'api_key', 'Authorization', 'clientSecret', 'password', 'cookie']) expect(isSecretKey(k), k).toBe(true);
    for (const k of ['author', 'sessionId', 'path', 'method']) expect(isSecretKey(k), k).toBe(false);
  });
});
