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
  slotAssignments: {},
  eventSettings: {
    'agent-done': { ...DEFAULT_EVENT_SETTINGS },
    'error': { ...DEFAULT_EVENT_SETTINGS },
    'permission': { ...DEFAULT_EVENT_SETTINGS },
    'permission-granted': { ...DEFAULT_EVENT_SETTINGS },
    'permission-denied': { ...DEFAULT_EVENT_SETTINGS },
    'agent-wake': { ...DEFAULT_EVENT_SETTINGS },
    'agent-sleep': { ...DEFAULT_EVENT_SETTINGS },
    'agent-focus': { ...DEFAULT_EVENT_SETTINGS },
    'notification': { ...DEFAULT_EVENT_SETTINGS },
  },
};

/**
 * Migrate legacy settings that used a single `activePack` to the new
 * per-slot `slotAssignments` model.  Also ensures new event keys exist
 * in `eventSettings` for users upgrading from older versions.
 */
function migrateSettings(raw: Record<string, unknown>): SoundSettings {
  const settings = raw as unknown as SoundSettings & { activePack?: string | null };

  // Ensure slotAssignments exists
  if (!settings.slotAssignments) {
    settings.slotAssignments = {};
  }

  // Migrate legacy activePack → slotAssignments
  if (settings.activePack && Object.keys(settings.slotAssignments).length === 0) {
    for (const event of ALL_SOUND_EVENTS) {
      settings.slotAssignments[event] = { packId: settings.activePack };
    }
  }
  delete settings.activePack;

  // Migrate project overrides
  if (settings.projectOverrides) {
    for (const [pid, override] of Object.entries(settings.projectOverrides)) {
      if (override.activePack && !override.slotAssignments) {
        override.slotAssignments = {};
        for (const event of ALL_SOUND_EVENTS) {
          override.slotAssignments[event] = { packId: override.activePack };
        }
        delete override.activePack;
        settings.projectOverrides[pid] = override;
      }
    }
  }

  // Ensure all event keys exist in eventSettings
  if (!settings.eventSettings) {
    settings.eventSettings = { ...defaultSettings.eventSettings };
  } else {
    for (const event of ALL_SOUND_EVENTS) {
      if (!settings.eventSettings[event]) {
        settings.eventSettings[event] = { ...DEFAULT_EVENT_SETTINGS };
      }
    }
  }

  return settings;
}

const store = createSettingsStore<SoundSettings>('sound-settings.json', defaultSettings, migrateSettings);

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

  // Remove this pack from any slot assignments
  const settings = getSettings();
  let changed = false;
  const slots = { ...settings.slotAssignments };
  for (const [event, assignment] of Object.entries(slots)) {
    if (assignment?.packId === packId) {
      delete slots[event as SoundEvent];
      changed = true;
    }
  }

  // Also clean up project overrides
  const overrides = settings.projectOverrides ? { ...settings.projectOverrides } : undefined;
  if (overrides) {
    for (const [pid, override] of Object.entries(overrides)) {
      if (override.slotAssignments) {
        const pSlots = { ...override.slotAssignments };
        for (const [event, assignment] of Object.entries(pSlots)) {
          if (assignment?.packId === packId) {
            delete pSlots[event as SoundEvent];
            changed = true;
          }
        }
        overrides[pid] = { ...override, slotAssignments: pSlots };
      }
    }
  }

  if (changed) {
    saveSettings({ ...settings, slotAssignments: slots, projectOverrides: overrides });
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
 * Resolve the pack for a specific sound slot, considering project overrides.
 */
export function resolveSlotPack(event: SoundEvent, projectId?: string): string | null {
  const settings = getSettings();

  // Check project-level slot override first
  if (projectId) {
    const projectSlots = settings.projectOverrides?.[projectId]?.slotAssignments;
    if (projectSlots?.[event]) {
      return projectSlots[event]!.packId;
    }
  }

  // Fall back to global slot assignment
  return settings.slotAssignments[event]?.packId ?? null;
}

/**
 * @deprecated Use resolveSlotPack instead. Kept for backward compatibility.
 */
export function resolveActivePack(projectId?: string): string | null {
  const settings = getSettings();
  // Find any assigned pack (take the first one found)
  for (const event of ALL_SOUND_EVENTS) {
    if (projectId) {
      const projectSlots = settings.projectOverrides?.[projectId]?.slotAssignments;
      if (projectSlots?.[event]) return projectSlots[event]!.packId;
    }
    if (settings.slotAssignments[event]) return settings.slotAssignments[event]!.packId;
  }
  return null;
}
