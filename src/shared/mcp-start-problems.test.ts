import { describe, expect, it } from 'vitest';
import { mcpErrorLine, missingEnvNotice, missingEnvReason, missingMcpEnv } from './mcp-start-problems';

describe('MCP start problems (#2896, D91)', () => {
  it('finds servers whose variables aren\'t set, by name, and skips the Clubhouse server', () => {
    const servers = {
      workiq: { command: 'npx', env_vars: ['WORKIQ_TENANT', 'WORKIQ_REGION'] },
      jira: { command: 'jira-mcp', env_vars: ['JIRA_URL'] },
      plain: { command: 'x' },
      clubhouse: { command: 'bridge', env_vars: ['CLUBHOUSE_HOOK_NONCE'] },
    };
    const env = { WORKIQ_REGION: 'eu', JIRA_URL: '', PATH: '/bin' };
    expect(missingMcpEnv(servers, env)).toEqual([
      { server: 'workiq', missingEnv: ['WORKIQ_TENANT'] },
      { server: 'jira', missingEnv: ['JIRA_URL'] },
    ]);
  });

  it('says what is missing without any value', () => {
    expect(missingEnvReason(['A'])).toBe('A isn\'t set in your environment.');
    expect(missingEnvReason(['A', 'B', 'C'])).toBe('A, B and C aren\'t set in your environment.');
    expect(missingEnvNotice({ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] })).toBe('MCP server workiq can\'t start: WORKIQ_TENANT isn\'t set in your environment.');
  });

  it('keeps the first line of a CLI error, without URL queries, and cuts it to 200 characters', () => {
    expect(mcpErrorLine('\n  exited with code 1\nstack')).toBe('exited with code 1');
    expect(mcpErrorLine('GET https://x.test/mcp?token=abc returned 401')).toBe('GET https://x.test/mcp?… returned 401');
    expect(mcpErrorLine(null)).toBeUndefined();
    expect(mcpErrorLine('x'.repeat(300))!.length).toBe(201);
  });
});
