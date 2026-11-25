/** The Antigravity ACP chat driver, for registration by the provider integration (#3797). */

import type { ChatDriver } from '../../../shared/chat/runtime';
import { buildAntigravityAcpBridgeServer, planAntigravityAcpMcpServers } from '../../orchestrators/antigravity/mcp-config';
import type { AcpDriverDeps } from '../acp/driver';
import { createAntigravityAcpDriver } from './driver';

export { ANTIGRAVITY_LEVEL_POLICY, ANTIGRAVITY_LOGIN_HINT, antigravityAcpArgs, antigravityAcpLaunchSpec } from './launch';
export { AntigravityChatStartError, antigravityMcpServers, createAntigravityAcpDriver } from './driver';

/** The driver with the real MCP module. `logDir` is Clubhouse's own log folder for `--log-file`. */
export function antigravityAcpDriver(deps: AcpDriverDeps & { logDir?: string } = {}): ChatDriver {
  return createAntigravityAcpDriver({ ...deps, mcp: { buildAntigravityAcpBridgeServer, planAntigravityAcpMcpServers } });
}
