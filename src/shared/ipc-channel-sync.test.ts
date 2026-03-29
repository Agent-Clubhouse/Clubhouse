/**
 * IPC Channel Sync Test — structural test verifying that every channel defined
 * in ipc-channels.ts is wired up in both handler registration (main process)
 * and preload bridge exposure (renderer process).
 *
 * This catches silent runtime failures where:
 * - A channel is defined but has no handler (renderer invokes into nothing)
 * - A channel is defined but not exposed in preload (renderer can't call it)
 * - A handler or preload references a channel that no longer exists
 *
 * Channel definitions are imported at runtime (not parsed with regex), making
 * the test resilient to formatting changes in ipc-channels.ts. Cross-file
 * wiring checks use simple string presence which is stable across formatters.
 *
 * @see https://github.com/Agent-Clubhouse/Clubhouse/issues/238
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from './ipc-channels';

const ROOT = path.resolve(__dirname, '..');

/** Read a file relative to src/ */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

/** Read all handler files and concatenate their contents */
function readAllHandlerFiles(): string {
  const handlersDir = path.join(ROOT, 'main', 'ipc');
  const files = fs.readdirSync(handlersDir)
    .filter((f) => f.endsWith('-handlers.ts') && !f.endsWith('.test.ts'));
  return files.map((f) => fs.readFileSync(path.join(handlersDir, f), 'utf-8')).join('\n');
}

/**
 * Build a dotted path map from the IPC object at runtime.
 * e.g. IPC.PTY.DATA -> 'pty:data'
 *
 * This replaces the old regex-based `extractChannelMap` which parsed the
 * source text line-by-line and was fragile to formatting changes.
 */
function buildChannelMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [group, channels] of Object.entries(IPC)) {
    for (const [key, value] of Object.entries(channels as Record<string, string>)) {
      map.set(`IPC.${group}.${key}`, value);
    }
  }
  return map;
}

// ─── Channel classification ───────────────────────────────────────────────
//
// Some channels are "event-only" — they are sent from main→renderer via
// webContents.send() and the renderer listens with ipcRenderer.on().
// These channels do NOT need an ipcMain.handle() or ipcMain.on() registration.
//
// Some channels are bidirectional (e.g. HUB_STATE_CHANGED is sent from renderer
// to main AND from main to renderer). These still need main-side handling.
//
// Channels that are renderer→main (ipcRenderer.send or ipcRenderer.invoke)
// MUST have a corresponding ipcMain.handle() or ipcMain.on().

/**
 * Channels that are ONLY used for main→renderer events.
 * The main process sends these via webContents.send() and the renderer
 * subscribes via ipcRenderer.on(). No ipcMain handler is needed.
 */
const MAIN_TO_RENDERER_ONLY_CHANNELS = new Set([
  'IPC.PTY.DATA',
  'IPC.PTY.EXIT',
  'IPC.AGENT.HOOK_EVENT',
  'IPC.AGENT.AGENT_WAKING',
  'IPC.AGENT.STRUCTURED_EVENT',
  'IPC.APP.NOTIFICATION_CLICKED',
  'IPC.APP.OPEN_SETTINGS',
  'IPC.APP.OPEN_ABOUT',
  'IPC.APP.THEME_CHANGED',

  'IPC.APP.UPDATE_STATUS_CHANGED',
  'IPC.ANNEX.STATUS_CHANGED',
  'IPC.ANNEX.AGENT_SPAWNED',
  'IPC.ANNEX.PAIRING_LOCKED',
  'IPC.ANNEX.PEERS_CHANGED',
  'IPC.ANNEX.LOCK_STATE_CHANGED',
  'IPC.ANNEX_CLIENT.SATELLITES_CHANGED',
  'IPC.ANNEX_CLIENT.SATELLITE_EVENT',
  'IPC.ANNEX_CLIENT.DISCOVERED_CHANGED',
  'IPC.MARKETPLACE.PLUGIN_UPDATES_CHANGED',
  'IPC.MCP_BINDING.TOOL_ACTIVITY',
  // Canvas command bridge: REQUEST is main→renderer push, RESULT is handled in canvas-command.ts
  'IPC.CANVAS_CMD.REQUEST',
  'IPC.CANVAS_CMD.RESULT',
  'IPC.WINDOW.NAVIGATE_TO_AGENT',
  'IPC.WINDOW.REQUEST_AGENT_STATE',
  'IPC.WINDOW.REQUEST_HUB_STATE',
  'IPC.WINDOW.REQUEST_HUB_MUTATION',
  'IPC.FILE.WATCH_EVENT',
  'IPC.PLUGIN_MCP.TOOL_CALL',
  'IPC.APP.RESUME_STATUS_UPDATE',
  'IPC.APP.DEV_SIMULATE_UPDATE_RESTART', // Dev-only: handler registered behind !app.isPackaged guard
]);

/**
 * Channels where the renderer sends to main AND main also broadcasts back.
 * These need main-side handling (ipcMain.on) but are also used as events.
 * Kept for documentation purposes.
 */
const _BIDIRECTIONAL_CHANNELS = new Set([
  'IPC.WINDOW.HUB_STATE_CHANGED',
]);

describe('IPC Channel Sync', () => {
  const channelMap = buildChannelMap();
  const allHandlersSource = readAllHandlerFiles();
  const preloadSource = readSrc('preload/index.ts');

  describe('all channels defined in ipc-channels.ts have a handler registered', () => {
    for (const [dottedPath, channelValue] of channelMap) {
      if (MAIN_TO_RENDERER_ONLY_CHANNELS.has(dottedPath)) continue;

      it(`${dottedPath} ('${channelValue}') has a handler in src/main/ipc/`, () => {
        // Handler files reference channels via the IPC constant (e.g. IPC.PTY.SPAWN_SHELL)
        // or the raw channel string. Check for either.
        const shortPath = dottedPath.replace('IPC.', '');
        const hasConstRef = allHandlersSource.includes(shortPath) ||
          allHandlersSource.includes(dottedPath);
        const hasStringRef = allHandlersSource.includes(`'${channelValue}'`);
        expect(
          hasConstRef || hasStringRef,
          `Channel ${dottedPath} ('${channelValue}') is defined in ipc-channels.ts but has no handler registered in src/main/ipc/`,
        ).toBe(true);
      });
    }
  });

  describe('all channels defined in ipc-channels.ts are exposed in preload', () => {
    for (const [dottedPath, channelValue] of channelMap) {
      it(`${dottedPath} ('${channelValue}') is referenced in src/preload/index.ts`, () => {
        // Preload references channels via IPC.GROUP.KEY constants
        const shortPath = dottedPath.replace('IPC.', '');
        const hasConstRef = preloadSource.includes(shortPath) ||
          preloadSource.includes(dottedPath);
        const hasStringRef = preloadSource.includes(`'${channelValue}'`);
        expect(
          hasConstRef || hasStringRef,
          `Channel ${dottedPath} ('${channelValue}') is defined in ipc-channels.ts but not exposed in src/preload/index.ts`,
        ).toBe(true);
      });
    }
  });

  describe('handler files only reference channels that exist in ipc-channels.ts', () => {
    const allDottedPaths = new Set(channelMap.keys());

    it('no phantom channel references in handler files', () => {
      // Extract IPC.X.Y references from handler source — this pattern
      // matches property access identifiers which are formatting-resilient
      const ipcRefPattern = /IPC\.(\w+)\.(\w+)/g;
      let match: RegExpExecArray | null;
      const phantoms: string[] = [];

      while ((match = ipcRefPattern.exec(allHandlersSource)) !== null) {
        const ref = match[0];
        if (!allDottedPaths.has(ref)) {
          phantoms.push(ref);
        }
      }

      expect(
        phantoms,
        `Handler files reference IPC channels that don't exist in ipc-channels.ts: ${phantoms.join(', ')}`,
      ).toEqual([]);
    });
  });

  describe('preload only references channels that exist in ipc-channels.ts', () => {
    const allDottedPaths = new Set(channelMap.keys());

    it('no phantom channel references in preload', () => {
      const ipcRefPattern = /IPC\.(\w+)\.(\w+)/g;
      let match: RegExpExecArray | null;
      const phantoms: string[] = [];

      while ((match = ipcRefPattern.exec(preloadSource)) !== null) {
        const ref = match[0];
        if (!allDottedPaths.has(ref)) {
          phantoms.push(ref);
        }
      }

      expect(
        phantoms,
        `Preload references IPC channels that don't exist in ipc-channels.ts: ${phantoms.join(', ')}`,
      ).toEqual([]);
    });
  });

  describe('channel string values are unique (no duplicates)', () => {
    it('every channel string is unique', () => {
      const seen = new Map<string, string>();
      const dupes: string[] = [];

      for (const [dottedPath, value] of channelMap) {
        if (seen.has(value)) {
          dupes.push(`${value} is used by both ${seen.get(value)} and ${dottedPath}`);
        }
        seen.set(value, dottedPath);
      }

      expect(dupes, `Duplicate channel strings found: ${dupes.join('; ')}`).toEqual([]);
    });
  });

  describe('channel string values match their namespace', () => {
    it('every channel string starts with its group prefix', () => {
      const mismatches: string[] = [];
      for (const [dottedPath, value] of channelMap) {
        // Extract group from dotted path: IPC.PTY.DATA -> pty
        // Replace underscores with dashes since channel strings use dashes (e.g. ANNEX_CLIENT -> annex-client)
        const group = dottedPath.split('.')[1].toLowerCase().replace(/_/g, '-');
        const prefix = value.split(':')[0];
        if (group !== prefix) {
          mismatches.push(`${dottedPath} has value '${value}' but expected prefix '${group}:'`);
        }
      }
      expect(
        mismatches,
        `Channel string/group prefix mismatches: ${mismatches.join('; ')}`,
      ).toEqual([]);
    });
  });
});
