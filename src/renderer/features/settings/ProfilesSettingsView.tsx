import { useEffect, useState, useCallback } from 'react';
import { useProfileStore } from '../../stores/profileStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import type { OrchestratorProfile, OrchestratorProfileEntry } from '../../../shared/types';

function generateId(): string {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Env var editor for a single orchestrator entry ---

interface EnvEditorProps {
  entries: Array<{ key: string; value: string }>;
  suggestedKeys: string[];
  onChange: (entries: Array<{ key: string; value: string }>) => void;
}

function EnvVarEditor({ entries, suggestedKeys, onChange }: EnvEditorProps) {
  const updateEntry = (index: number, field: 'key' | 'value', val: string) => {
    const next = [...entries];
    next[index] = { ...next[index], [field]: val };
    onChange(next);
  };

  const addEntry = () => {
    const nextKey = suggestedKeys.find((k) => !entries.some((e) => e.key === k)) || '';
    onChange([...entries, { key: nextKey, value: '' }]);
  };

  const removeEntry = (index: number) => {
    if (entries.length === 1) {
      onChange([{ key: '', value: '' }]);
      return;
    }
    onChange(entries.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      {suggestedKeys.length > 0 && (
        <p className="text-[10px] text-ctp-subtext0/60">
          Suggested keys: {suggestedKeys.map((k) => (
            <code key={k} className="bg-ctp-surface0/30 px-1 rounded mx-0.5">{k}</code>
          ))}
        </p>
      )}
      {entries.map((entry, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            type="text"
            value={entry.key}
            onChange={(e) => updateEntry(i, 'key', e.target.value)}
            placeholder="KEY"
            list={`env-keys-${i}`}
            className="w-48 px-2 py-1 text-xs font-mono rounded bg-ctp-base border border-surface-2
              text-ctp-text focus:outline-none focus:border-ctp-accent/50"
          />
          <datalist id={`env-keys-${i}`}>
            {suggestedKeys.map((k) => <option key={k} value={k} />)}
          </datalist>
          <span className="text-ctp-subtext0 text-xs">=</span>
          <input
            type="text"
            value={entry.value}
            onChange={(e) => updateEntry(i, 'value', e.target.value)}
            placeholder="value (~ expands to home dir)"
            className="flex-1 px-2 py-1 text-xs font-mono rounded bg-ctp-base border border-surface-2
              text-ctp-text focus:outline-none focus:border-ctp-accent/50"
          />
          <button
            onClick={() => removeEntry(i)}
            className="text-ctp-subtext0 hover:text-ctp-red text-xs cursor-pointer"
            title="Remove"
          >
            x
          </button>
        </div>
      ))}
      <button
        onClick={addEntry}
        className="text-xs text-ctp-accent hover:underline cursor-pointer"
      >
        + Add variable
      </button>
    </div>
  );
}

// --- Orchestrator section within the profile edit form ---

interface OrchestratorSectionProps {
  orchestratorName: string;
  entry: OrchestratorProfileEntry;
  suggestedKeys: string[];
  onUpdate: (entry: OrchestratorProfileEntry) => void;
  onRemove: () => void;
}

function OrchestratorSection({ orchestratorName, entry, suggestedKeys, onUpdate, onRemove }: OrchestratorSectionProps) {
  const entries = Object.entries(entry.env).length > 0
    ? Object.entries(entry.env).map(([key, value]) => ({ key, value }))
    : [{ key: '', value: '' }];

  const handleEnvChange = (newEntries: Array<{ key: string; value: string }>) => {
    const env: Record<string, string> = {};
    for (const { key, value } of newEntries) {
      if (key.trim()) env[key.trim()] = value;
    }
    onUpdate({ env });
  };

  return (
    <div className="p-3 rounded-lg bg-ctp-base border border-surface-1 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ctp-text">{orchestratorName}</span>
        <button
          onClick={onRemove}
          className="text-[10px] text-ctp-red hover:underline cursor-pointer"
        >
          Remove
        </button>
      </div>
      <EnvVarEditor entries={entries} suggestedKeys={suggestedKeys} onChange={handleEnvChange} />
    </div>
  );
}

// --- Profile edit form ---

interface EditFormProps {
  profile: OrchestratorProfile;
  onSave: (p: OrchestratorProfile) => void;
  onCancel: () => void;
}

function ProfileEditForm({ profile, onSave, onCancel }: EditFormProps) {
  const [name, setName] = useState(profile.name);
  const [orchestrators, setOrchestrators] = useState<Record<string, OrchestratorProfileEntry>>(
    profile.orchestrators
  );
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));
  const getProfileEnvKeys = useProfileStore((s) => s.getProfileEnvKeys);
  const [suggestedKeysMap, setSuggestedKeysMap] = useState<Record<string, string[]>>({});

  // Load suggested keys for all configured orchestrators
  const loadSuggestions = useCallback(async () => {
    const map: Record<string, string[]> = {};
    for (const orchId of Object.keys(orchestrators)) {
      map[orchId] = await getProfileEnvKeys(orchId);
    }
    setSuggestedKeysMap(map);
  }, [Object.keys(orchestrators).join(','), getProfileEnvKeys]); // eslint-disable-line

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({ ...profile, name: name.trim(), orchestrators });
  };

  const handleAddOrchestrator = async (orchId: string) => {
    const keys = await getProfileEnvKeys(orchId);
    const initialEnv: Record<string, string> = {};
    if (keys.length > 0) initialEnv[keys[0]] = '';
    setOrchestrators({ ...orchestrators, [orchId]: { env: initialEnv } });
    setSuggestedKeysMap((prev) => ({ ...prev, [orchId]: keys }));
  };

  const handleRemoveOrchestrator = (orchId: string) => {
    const next = { ...orchestrators };
    delete next[orchId];
    setOrchestrators(next);
  };

  const handleUpdateOrchestrator = (orchId: string, entry: OrchestratorProfileEntry) => {
    setOrchestrators({ ...orchestrators, [orchId]: entry });
  };

  const availableToAdd = enabledOrchestrators.filter((o) => !orchestrators[o.id]);

  return (
    <div className="p-4 rounded-lg bg-ctp-mantle border border-surface-0 space-y-4">
      <div className="space-y-2">
        <label className="block text-xs text-ctp-subtext0">Profile Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Work, Personal"
          className="w-full px-3 py-1.5 text-sm rounded-lg bg-ctp-base border border-surface-2
            text-ctp-text focus:outline-none focus:border-ctp-accent/50"
        />
      </div>

      <div className="space-y-3">
        <label className="block text-xs text-ctp-subtext0">Orchestrators</label>
        {Object.entries(orchestrators).map(([orchId, entry]) => {
          const orchName = allOrchestrators.find((o) => o.id === orchId)?.displayName || orchId;
          return (
            <OrchestratorSection
              key={orchId}
              orchestratorName={orchName}
              entry={entry}
              suggestedKeys={suggestedKeysMap[orchId] || []}
              onUpdate={(updated) => handleUpdateOrchestrator(orchId, updated)}
              onRemove={() => handleRemoveOrchestrator(orchId)}
            />
          );
        })}

        {Object.keys(orchestrators).length === 0 && (
          <p className="text-xs text-ctp-subtext0/60">No orchestrators configured. Add one below.</p>
        )}

        {availableToAdd.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              id="add-orchestrator-select"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  handleAddOrchestrator(e.target.value);
                  e.target.value = '';
                }
              }}
              className="px-2 py-1 text-xs rounded bg-ctp-base border border-surface-2
                text-ctp-text focus:outline-none focus:border-ctp-accent/50"
            >
              <option value="" disabled>+ Add Orchestrator</option>
              {availableToAdd.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-lg bg-surface-1 text-ctp-subtext0
            hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim()}
          className="px-3 py-1.5 text-xs rounded-lg bg-ctp-blue text-white
            hover:bg-ctp-blue/80 cursor-pointer transition-colors disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function ProfilesSettingsView() {
  const profiles = useProfileStore((s) => s.profiles);
  const loadProfiles = useProfileStore((s) => s.loadProfiles);
  const saveProfile = useProfileStore((s) => s.saveProfile);
  const deleteProfile = useProfileStore((s) => s.deleteProfile);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const loadOrchestratorSettings = useOrchestratorStore((s) => s.loadSettings);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    loadProfiles();
    loadOrchestratorSettings();
  }, [loadProfiles, loadOrchestratorSettings]);

  const handleCreate = () => {
    const newProfile: OrchestratorProfile = {
      id: generateId(),
      name: '',
      orchestrators: {},
    };
    setEditingId(newProfile.id);
    // Temporarily add to show the edit form
    saveProfile(newProfile);
  };

  const handleSave = async (p: OrchestratorProfile) => {
    await saveProfile(p);
    setEditingId(null);
  };

  const handleDelete = async (profileId: string) => {
    await deleteProfile(profileId);
    setShowConfirmDelete(null);
  };

  const getOrchestratorNames = (profile: OrchestratorProfile): string => {
    const ids = Object.keys(profile.orchestrators);
    if (ids.length === 0) return 'No orchestrators';
    return ids.map((id) => allOrchestrators.find((o) => o.id === id)?.displayName || id).join(', ');
  };

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Profiles</h2>
        <p className="text-sm text-ctp-subtext0 mb-4">
          Named profiles allow switching between different accounts or configurations
          (e.g. Work vs Personal). Each profile can hold env configs for multiple orchestrators.
          When a profile is active on a project, only its configured orchestrators appear in agent creation.
        </p>

        <div className="mb-4 px-3 py-2 rounded-lg bg-ctp-info/10 border border-ctp-info/20 text-xs text-ctp-info">
          For Claude Code, set <code className="bg-ctp-info/10 px-1 rounded">CLAUDE_CONFIG_DIR</code> to
          a separate directory (e.g. <code className="bg-ctp-info/10 px-1 rounded">~/.claude-work</code>).
          Run <code className="bg-ctp-info/10 px-1 rounded">/login</code> once via that profile to cache credentials.
        </div>

        <div className="space-y-3 mb-6">
          {profiles.map((p) => (
            <div key={p.id}>
              {editingId === p.id ? (
                <ProfileEditForm
                  profile={p}
                  onSave={handleSave}
                  onCancel={() => {
                    setEditingId(null);
                    // If name is empty, it was just created — remove it
                    if (!p.name) deleteProfile(p.id);
                  }}
                />
              ) : (
                <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-ctp-text font-medium">{p.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-1 text-ctp-subtext0">
                        {getOrchestratorNames(p)}
                      </span>
                    </div>
                    <div className="text-xs text-ctp-subtext0 mt-0.5 font-mono">
                      {Object.entries(p.orchestrators).map(([orchId, entry]) => {
                        const envStr = Object.entries(entry.env).map(([k, v]) => `${k}=${v}`).join(', ');
                        const orchName = allOrchestrators.find((o) => o.id === orchId)?.shortName || orchId;
                        return envStr ? `${orchName}: ${envStr}` : null;
                      }).filter(Boolean).join(' | ') || 'No env vars set'}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingId(p.id)}
                      className="text-xs text-ctp-accent hover:underline cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setShowConfirmDelete(p.id)}
                      className="text-xs text-ctp-red hover:underline cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {profiles.length === 0 && !editingId && (
            <p className="text-sm text-ctp-subtext0">No profiles configured yet.</p>
          )}
        </div>

        <button
          onClick={handleCreate}
          disabled={editingId !== null}
          className="px-4 py-2 text-sm rounded-lg bg-ctp-blue text-white
            hover:bg-ctp-blue/80 cursor-pointer transition-colors disabled:opacity-50"
        >
          + New Profile
        </button>

        {/* Usage instructions */}
        <div className="mt-8 space-y-2">
          <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Usage</h3>
          <p className="text-xs text-ctp-subtext0">
            Once created, assign a profile in <strong>Orchestrators & Agents</strong> settings at the project level.
            When a profile is active, only orchestrators configured in that profile appear in agent creation.
            The profile's environment variables are injected when the agent spawns.
          </p>
        </div>

        {/* Confirm delete dialog */}
        {showConfirmDelete && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-ctp-base border border-surface-1 rounded-xl p-6 max-w-md mx-4 shadow-xl">
              <h3 className="text-sm font-semibold text-ctp-text mb-2">Delete Profile?</h3>
              <p className="text-xs text-ctp-subtext0 mb-4">
                Agents referencing this profile will fall back to the default configuration.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowConfirmDelete(null)}
                  className="px-3 py-1.5 text-xs rounded-lg bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(showConfirmDelete)}
                  className="px-3 py-1.5 text-xs rounded-lg bg-ctp-red text-white hover:bg-ctp-red/80 cursor-pointer transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
