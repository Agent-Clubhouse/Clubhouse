/**
 * A CLI's error for an MCP server that failed to start, safe to show in the
 * chat and Details (#2896, D91): its first line, URL queries cut, and any
 * secret-shaped text redacted. Clubhouse never reads the values of a server's
 * variables, so one can only appear if the CLI printed it, and the redaction
 * catches the common shapes then.
 */
import { mcpErrorLine } from '../../shared/mcp-start-problems';
import { redactSecretValues } from '../telemetry/diag-redaction';

export function safeMcpErrorLine(error: string | null | undefined): string | undefined {
  const line = mcpErrorLine(error);
  return line ? redactSecretValues(line) : undefined;
}
