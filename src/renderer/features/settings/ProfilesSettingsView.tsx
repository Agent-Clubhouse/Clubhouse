import { useEffect, useState, useCallback } from 'react';
import { useProfileStore } from '../../stores/profileStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import type { OrchestratorProfile } from '../../../shared/types';

function generateId(): string {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface EditFormProps {
  profile: OrchestratorProfile;
  onSave: (p: OrchestratorProfile) => void;
  onCancel: () => void;
}

function ProfileEditForm({ profile, onSave, onCancel }: EditFormProps) {
  const [name, setName] = useState(profile.name);
  const [orchestrator, setOrchestrator] = useState(profile.orchestrator);
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>(
    Object.entries(profile.env).length > 0
      ? Object.entries(profile.env).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }]
  );
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));
  const getProfileEnvKeys = useProfileStore((s) => s.getProfileEnvKeys);
  const [suggestedKeys, setSuggestedKeys] = useState<string[]>([]);

  const loadSuggestions = useCallback(async () => {
    const keys = await getProfileEnvKeys(orchestrator);
    setSuggestedKeys(keys);
    // If creating a new profile with empty env, pre-populate with the suggested key
    if (envEntries.length === 1 && !envEntries[0].key && !envEntries[0].value && keys.length > 0) {
      setEnvEntries([{ key: keys[0], value: '' }]);
    }
  }, [orchestrator, getProfileEnvKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  const handleSave = () => {
    if (!name.trim()) return;
    const env: Record<string, string> = {};
    for (const { key, value } of envEntries) {
      if (key.trim()) env[key.trim()] = value;
    }
    onSave({ ...profile, name: name.trim(), orchestrator, env });
  };

  const updateEntry = (index: number, field: 'key' | 'value', val: string) => {
    const next = [...envEntries];
    next[index] = { ...next[index], [field]: val };
    setEnvEntries(next);
  };

  const addEntry = () => {
    const nextKey = suggestedKeys.find((k) => !envEntries.some((e) => e.key === k)) || '';
    setEnvEntries([...envEntries, { key: nextKey, value: '' }]);
  };

  const removeEntry = (index: number) => {
    if (envEntries.length === 1) {
      setEnvEntries([{ key: '', value: '' }]);
      return;
    }
    setEnvEntries(envEntries.filter((_, i) => i !== index));
  };

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

      <div className="space-y-2">
        <label className="block text-xs text-ctp-subtext0">Orchestrator</label>
        <select
          value={orchestrator}
          onChange={(e) => setOrchestrator(e.target.value)}
          className="w-full px-3 py-1.5 text-sm rounded-lg bg-ctp-base border border-surface-2
            text-ctp-text focus:outline-none focus:border-ctp-accent/50"
        >
          {enabledOrchestrators.map((o) => (
            <option key={o.id} value={o.id}>{o.displayName}</option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="block text-xs text-ctp-subtext0">Environment Variables</label>
        {suggestedKeys.length > 0 && (
          <p className="text-[10px] text-ctp-subtext0/60">
            Suggested keys for this orchestrator: {suggestedKeys.map((k) => (
              <code key={k} className="bg-ctp-surface0/30 px-1 rounded mx-0.5">{k}</code>
            ))}
          </p>
        )}
        {envEntries.map((entry, i) => (
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
      orchestrator: 'claude-code',
      env: {},
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

  const getOrchestratorName = (id: string) => {
    return allOrchestrators.find((o) => o.id === id)?.displayName || id;
  };

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Profiles</h2>
        <p className="text-sm text-ctp-subtext0 mb-4">
          Named profiles allow switching between different accounts or configurations per orchestrator
          (e.g. Work vs Personal). Each profile injects environment variables when spawning agents.
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
                        {getOrchestratorName(p.orchestrator)}
                      </span>
                    </div>
                    <div className="text-xs text-ctp-subtext0 mt-0.5 font-mono">
                      {Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join(', ') || 'No env vars set'}
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
            Once created, profiles can be assigned in <strong>Orchestrators & Agents</strong> settings at the project level
            or per individual agent in the agent config panel. The profile's environment variables are injected
            when the agent spawns.
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
