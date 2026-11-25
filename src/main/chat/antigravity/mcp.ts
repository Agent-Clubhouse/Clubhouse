/**
 * The MCP seam this driver uses: the bridge builder and server planner from
 * the provider's mcp-config module (#3793). Injected, so tests pass their own.
 */

import type { buildAntigravityAcpBridgeServer, planAntigravityAcpMcpServers } from '../../orchestrators/antigravity/mcp-config';

export type { AcpHttpMcpServer, AcpMcpServer, AcpStdioMcpServer } from '../../orchestrators/antigravity/mcp-config';

export interface AntigravityAcpMcp {
  buildAntigravityAcpBridgeServer: typeof buildAntigravityAcpBridgeServer;
  planAntigravityAcpMcpServers: typeof planAntigravityAcpMcpServers;
}
