/**
 * Satellite Lock Overlay (#867)
 *
 * Full-screen overlay shown when a remote controller is connected.
 * Displays the controller's identity and provides disconnect/pause/disable actions.
 */
import { AGENT_COLORS } from '../../../shared/name-generator';

interface LockState {
  locked: boolean;
  paused: boolean;
  controllerAlias: string;
  controllerIcon: string;
  controllerColor: string;
  controllerFingerprint: string;
}

interface Props {
  lockState: LockState;
  onDisconnect: () => void;
  onPause: () => void;
  onDisableAndDisconnect: () => void;
  /** Pixel offset from the top to account for visible banners above. */
  bannerOffset?: number;
}

function getColorHex(colorId: string): string {
  const color = AGENT_COLORS.find((c) => c.id === colorId);
  return color?.hex || '#6366f1';
}

export function SatelliteLockOverlay({ lockState, onDisconnect, onPause, onDisableAndDisconnect, bannerOffset = 0 }: Props) {
  if (!lockState.locked) return null;

  const colorHex = getColorHex(lockState.controllerColor);

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center transition-opacity ${
        lockState.paused ? 'bg-black/20 pointer-events-none' : 'bg-black/60'
      }`}
      style={{ backdropFilter: lockState.paused ? 'none' : 'blur(4px)' }}
    >
      {!lockState.paused && (
        <div className="flex flex-col items-center gap-6 text-center">
          {/* Controller icon */}
          <div
            className="w-24 h-24 rounded-full flex items-center justify-center text-white text-3xl font-bold shadow-lg"
            style={{ backgroundColor: colorHex }}
          >
            {lockState.controllerAlias.slice(0, 2).toUpperCase()}
          </div>

          {/* Controller info */}
          <div>
            <div className="text-xl font-semibold text-white">
              Controlled by {lockState.controllerAlias}
            </div>
            <div className="text-sm text-white/60 font-mono mt-1">
              {lockState.controllerFingerprint}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 mt-4">
            <button
              onClick={onDisconnect}
              className="px-5 py-2.5 rounded-lg bg-white/20 hover:bg-white/30 text-white
                text-sm font-medium transition-colors cursor-pointer backdrop-blur-sm"
            >
              Disconnect
            </button>
            <button
              onClick={onPause}
              className="px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/80
                text-sm font-medium transition-colors cursor-pointer backdrop-blur-sm"
            >
              Pause
            </button>
            <button
              onClick={onDisableAndDisconnect}
              className="px-5 py-2.5 rounded-lg bg-red-500/30 hover:bg-red-500/40 text-white
                text-sm font-medium transition-colors cursor-pointer backdrop-blur-sm"
            >
              Disconnect & Disable Annex
            </button>
          </div>
        </div>
      )}

      {lockState.paused && (
        <div
          className="fixed right-4 pointer-events-auto transition-[top] duration-200 ease-in-out"
          data-testid="satellite-pause-floatie"
          style={{ top: `${48 + bannerOffset}px`, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: colorHex }}
            />
            <span className="text-xs text-white/80">
              {lockState.controllerAlias} connected (paused)
            </span>
            <button
              onClick={onPause}
              className="text-xs text-white/60 hover:text-white transition-colors ml-1 cursor-pointer"
            >
              Resume
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
