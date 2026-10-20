/**
 * Annex terminal metadata shared by the satellite (server) and the controller
 * (client).
 */
import type { WindowsPtyInfo } from './windows-pty';

/**
 * The satellite's OS and PTY backend, sent in the Annex snapshot as
 * `ptyHost`. A controller needs it to give a remote terminal xterm's
 * `windowsPty` hint, because only the satellite knows whether its PTY is
 * ConPTY (#2352). Satellites before this field send nothing, and their
 * terminals get no hint.
 */
export interface AnnexPtyHost {
  platform: string;
  ptyBackend: 'conpty' | 'winpty' | null;
  /** Windows build number, when known. */
  windowsBuild?: number;
}

/**
 * Response headers on `GET /api/v1/agents/:id/buffer`. The body stays the
 * plain serialized buffer, so older controllers that ignore the headers keep
 * working.
 */
export const ANNEX_BUFFER_HEADERS = {
  /** Satellite output seq the buffer includes (see `unseenPtySuffix`). */
  seq: 'x-clubhouse-output-seq',
  /** The satellite PTY's size, so a controller mirror wraps like the PTY. */
  cols: 'x-clubhouse-pty-cols',
  rows: 'x-clubhouse-pty-rows',
} as const;

export function annexPtyHost(platform: string, windowsPty: WindowsPtyInfo | undefined): AnnexPtyHost {
  return {
    platform,
    ptyBackend: windowsPty?.backend ?? null,
    ...(windowsPty?.buildNumber !== undefined && { windowsBuild: windowsPty.buildNumber }),
  };
}

/**
 * The `windowsPty` hint for a terminal whose PTY runs on a satellite, or
 * undefined when the satellite is not Windows or did not say. The value comes
 * off the network, so it is checked field by field.
 */
export function windowsPtyForHost(host: unknown): WindowsPtyInfo | undefined {
  if (!host || typeof host !== 'object') return undefined;
  const { platform, ptyBackend, windowsBuild } = host as Record<string, unknown>;
  if (platform !== 'win32') return undefined;
  if (ptyBackend !== 'conpty' && ptyBackend !== 'winpty') return undefined;
  return typeof windowsBuild === 'number' && Number.isInteger(windowsBuild) && windowsBuild > 0
    ? { backend: ptyBackend, buildNumber: windowsBuild }
    : { backend: ptyBackend };
}
