import { app, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createSettingsStore } from './settings-store';
import {
  SoundSettings,
  SoundPackInfo,
  SoundEvent,
  ALL_SOUND_EVENTS,
  SUPPORTED_SOUND_EXTENSIONS,
} from '../../shared/types';

// ── Settings persistence ──────────────────────────────────────────────

const DEFAULT_EVENT_SETTINGS = {
  enabled: true,
  volume: 80,
};

const defaultSettings: SoundSettings = {
  activePack: null,
  eventSettings: {
    'agent-done': { ...DEFAULT_EVENT_SETTINGS },
    'error': { ...DEFAULT_EVENT_SETTINGS },
    'permission': { ...DEFAULT_EVENT_SETTINGS },
    'notification': { ...DEFAULT_EVENT_SETTINGS },
  },
};

const store = createSettingsStore<SoundSettings>('sound-settings.json', defaultSettings);

export const getSettings = store.get;
export const saveSettings = store.save;

// ── Sound packs directory ─────────────────────────────────────────────

function getSoundPacksDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'sounds');
}

function ensureSoundPacksDir(): string {
  const dir = getSoundPacksDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isSupportedSoundFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (SUPPORTED_SOUND_EXTENSIONS as readonly string[]).includes(ext);
}

function readPackManifest(packDir: string): { name?: string; description?: string; author?: string } {
  const manifestPath = path.join(packDir, 'manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

function discoverSoundsInPack(packDir: string): Partial<Record<SoundEvent, string>> {
  const sounds: Partial<Record<SoundEvent, string>> = {};
  try {
    const files = fs.readdirSync(packDir);
    for (const event of ALL_SOUND_EVENTS) {
      const match = files.find((f) => {
        const name = path.basename(f, path.extname(f));
        return name === event && isSupportedSoundFile(f);
      });
      if (match) {
        sounds[event] = match;
      }
    }
  } catch {
    // Directory not readable
  }
  return sounds;
}

// ── Public API ────────────────────────────────────────────────────────

export function listSoundPacks(): SoundPackInfo[] {
  const dir = getSoundPacksDir();
  if (!fs.existsSync(dir)) return [];

  const packs: SoundPackInfo[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packDir = path.join(dir, entry.name);
      const manifest = readPackManifest(packDir);
      const sounds = discoverSoundsInPack(packDir);

      // Only include directories that have at least one sound file
      if (Object.keys(sounds).length === 0) continue;

      packs.push({
        id: entry.name,
        name: manifest.name || entry.name,
        description: manifest.description,
        author: manifest.author,
        sounds,
        source: 'user',
      });
    }
  } catch {
    // Directory not readable
  }
  return packs;
}

/**
 * Register sounds contributed by a plugin.
 * The plugin's sound files are expected in `pluginPath/sounds/`.
 */
const pluginSoundPacks = new Map<string, SoundPackInfo>();

export function registerPluginSounds(pluginId: string, pluginPath: string, packName?: string): SoundPackInfo | null {
  const soundsDir = path.join(pluginPath, 'sounds');
  if (!fs.existsSync(soundsDir)) return null;

  const sounds = discoverSoundsInPack(soundsDir);
  if (Object.keys(sounds).length === 0) return null;

  const manifest = readPackManifest(soundsDir);
  const pack: SoundPackInfo = {
    id: `plugin:${pluginId}`,
    name: packName || manifest.name || pluginId,
    description: manifest.description,
    author: manifest.author,
    sounds,
    source: 'plugin',
    pluginId,
  };
  pluginSoundPacks.set(pluginId, pack);
  return pack;
}

export function unregisterPluginSounds(pluginId: string): void {
  pluginSoundPacks.delete(pluginId);
}

export function getAllSoundPacks(): SoundPackInfo[] {
  const userPacks = listSoundPacks();
  const pluginPacks = Array.from(pluginSoundPacks.values());
  return [...userPacks, ...pluginPacks];
}

/**
 * Import a sound pack from a directory selected by the user.
 * Copies the directory contents into ~/.clubhouse/sounds/<dirName>.
 */
export async function importSoundPack(): Promise<SoundPackInfo | null> {
  const result = await dialog.showOpenDialog({
    title: 'Import Sound Pack',
    properties: ['openDirectory'],
    message: 'Select a folder containing sound files (agent-done.mp3, error.mp3, etc.)',
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const sourcePath = result.filePaths[0];
  const dirName = path.basename(sourcePath);
  const targetDir = path.join(ensureSoundPacksDir(), dirName);

  // Check if pack already exists
  if (fs.existsSync(targetDir)) {
    const overwrite = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      title: 'Sound Pack Exists',
      message: `A sound pack named "${dirName}" already exists. Replace it?`,
    });
    if (overwrite !== 0) return null;
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  // Copy directory
  fs.cpSync(sourcePath, targetDir, { recursive: true });

  // Validate it has sounds
  const sounds = discoverSoundsInPack(targetDir);
  if (Object.keys(sounds).length === 0) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'No Sound Files Found',
      message: 'The selected folder does not contain any recognized sound files.\nExpected files like: agent-done.mp3, error.wav, permission.ogg, notification.mp3',
    });
    return null;
  }

  const manifest = readPackManifest(targetDir);
  return {
    id: dirName,
    name: manifest.name || dirName,
    description: manifest.description,
    author: manifest.author,
    sounds,
    source: 'user',
  };
}

export function deleteSoundPack(packId: string): boolean {
  // Don't allow deleting plugin packs through this method
  if (packId.startsWith('plugin:')) return false;

  const packDir = path.join(getSoundPacksDir(), packId);
  if (!fs.existsSync(packDir)) return false;

  fs.rmSync(packDir, { recursive: true, force: true });

  // If the deleted pack was active, reset to default
  const settings = getSettings();
  if (settings.activePack === packId) {
    saveSettings({ ...settings, activePack: null });
  }

  return true;
}

/**
 * Read a sound file and return it as a base64 data URL.
 * Returns null if the sound file doesn't exist.
 */
export function getSoundData(packId: string, event: SoundEvent): string | null {
  let packDir: string;

  if (packId.startsWith('plugin:')) {
    const pluginId = packId.slice('plugin:'.length);
    const pack = pluginSoundPacks.get(pluginId);
    if (!pack) return null;
    // Plugin sounds live in the plugin's sounds/ directory
    const pluginPath = pack.pluginId ? getPluginSoundsDir(pluginId) : null;
    if (!pluginPath) return null;
    packDir = pluginPath;
  } else {
    packDir = path.join(getSoundPacksDir(), packId);
  }

  if (!fs.existsSync(packDir)) return null;

  // Find the sound file for this event
  try {
    const files = fs.readdirSync(packDir);
    const match = files.find((f) => {
      const name = path.basename(f, path.extname(f));
      return name === event && isSupportedSoundFile(f);
    });

    if (!match) return null;

    const filePath = path.join(packDir, match);
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(match).toLowerCase();
    const mimeType = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'audio/ogg';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

function getPluginSoundsDir(pluginId: string): string | null {
  const pack = pluginSoundPacks.get(pluginId);
  if (!pack) return null;
  // Reconstruct the sounds dir from the plugin registry
  // Plugin packs store their path during registration
  const pluginsDir = path.join(app.getPath('home'), '.clubhouse', 'plugins');
  const pluginDir = path.join(pluginsDir, pluginId, 'sounds');
  return fs.existsSync(pluginDir) ? pluginDir : null;
}

/**
 * Resolve the active pack for a given project, considering project overrides.
 */
export function resolveActivePack(projectId?: string): string | null {
  const settings = getSettings();
  if (projectId && settings.projectOverrides?.[projectId]?.activePack !== undefined) {
    return settings.projectOverrides[projectId].activePack ?? null;
  }
  return settings.activePack;
}
