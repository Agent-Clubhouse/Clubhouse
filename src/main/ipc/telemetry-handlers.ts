import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import {
  getTelemetryState,
  handleRendererEmit,
  handleRendererReady,
  initRendererBridge,
  type RendererBridgeDeps,
} from '../telemetry/renderer-bridge';

/**
 * Renderer → main telemetry IPC (spec §6.2). Registered at module load in
 * src/main/index.ts, before any window exists, so no renderer message is
 * missed. All three are inert while telemetry is off.
 */
export function registerTelemetryHandlers(deps: RendererBridgeDeps): void {
  initRendererBridge(deps);
  // Fire-and-forget batches; the bridge re-validates every item.
  ipcMain.on(IPC.TELEMETRY.EMIT, (event, raw: unknown) => handleRendererEmit(event.sender, raw));
  ipcMain.on(IPC.TELEMETRY.RENDERER_READY, (event) => handleRendererReady(event.sender));
  ipcMain.handle(IPC.TELEMETRY.GET_STATE, () => getTelemetryState());
}
