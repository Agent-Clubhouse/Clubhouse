import { describe, expect, it } from 'vitest';
import { safeMcpErrorLine } from './mcp-error-text';

describe('safeMcpErrorLine (#2896, D95)', () => {
  it('keeps the first line, an exit code or stderr line, and redacts secret shapes', () => {
    expect(safeMcpErrorLine('MCP server exited with code 1\nError: boom')).toBe('MCP server exited with code 1');
    const redacted = safeMcpErrorLine('Authorization failed: Bearer abcdefghijklmnop')!;
    expect(redacted).toContain('Authorization failed');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(safeMcpErrorLine('token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa rejected')).not.toContain('ghp_aaaa');
    expect(safeMcpErrorLine('')).toBeUndefined();
  });

  it('redacts before it cuts, so a token across the 200th character is still caught', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const text = `${'x'.repeat(185)} ${token} tail`;
    const line = safeMcpErrorLine(text)!;
    expect(line).not.toContain('ghp_aaaaaaaa');
    expect(line).not.toMatch(/a{10}/);
    expect(line.length).toBeLessThanOrEqual(201);
  });
});
