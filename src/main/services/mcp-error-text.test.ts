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
});
