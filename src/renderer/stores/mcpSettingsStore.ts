/**
 * MCP Settings Store — renderer-side Zustand store for the Clubhouse MCP bridge feature.
 *
 * Uses the managed settings factory (generic settings bridge) so no custom
 * IPC channels or preload methods are needed.
 */

import { createSettingsStore } from './settings-store-factory';
import { MCP_SETTINGS } from '../../shared/settings-definitions';

export const useMcpSettingsStore = createSettingsStore(MCP_SETTINGS);
