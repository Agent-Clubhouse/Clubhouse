import { useEffect, useState, useCallback } from 'react';
import { useProfileStore } from '../../stores/profileStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { Modal } from '../../components/Modal';
import { SettingsPage, SettingsSection, SettingsBlock, settingsButton, settingsInput, settingsLabel, settingsHelp } from './SettingsLayout';
import type { OrchestratorProfile, OrchestratorProfileEntry } from '../../../shared/types';

const CODE_CLASS = 'font-mono text-ctp-subtext1';

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
    <div className="space-y-1.5">
      {suggestedKeys.length > 0 && (
        <p className={settingsHelp}>
          Suggested keys {suggestedKeys.map((k) => (
            <code key={k} className={`${CODE_CLASS} mx-0.5`}>{k}</code>
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
            aria-label="Variable name"
            list={`env-keys-${i}`}
            className={`${settingsInput} w-48 font-mono`}
          />
          <datalist id={`env-keys-${i}`}>
            {suggestedKeys.map((k) => <option key={k} value={k} />)}
          </datalist>
          <span className="text-ctp-overlay1 text-xs">=</span>
          <input
            type="text"
            value={entry.value}
            onChange={(e) => updateEntry(i, 'value', e.target.value)}
            placeholder="value (~ expands to home dir)"
            aria-label="Variable value"
            className={`${settingsInput} flex-1 min-w-0 font-mono`}
          />
          <button
            type="button"
            onClick={() => removeEntry(i)}
            className={settingsButton.icon}
            title="Remove"
            aria-label="Remove variable"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
      <button type="button" onClick={addEntry} className={settingsButton.quiet}>
        Add variable
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
    <div className="py-2 border-t border-surface-0 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ctp-text">{orchestratorName}</span>
        <button type="button" onClick={onRemove} className={settingsButton.danger}>
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
  }, [Object.keys(orchestrators).join(','), getProfileEnvKeys]);  

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
    <SettingsBlock className="space-y-3">
      <div>
        <label htmlFor={`profile-name-${profile.id}`} className={settingsLabel}>Profile name</label>
        <input
          id={`profile-name-${profile.id}`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Work, Personal"
          className={`${settingsInput} w-full`}
        />
      </div>

      <div>
        <div className={settingsLabel}>Orchestrators</div>
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
          <p className={`${settingsHelp} py-1`}>No orchestrators yet. Add one below.</p>
        )}

        {availableToAdd.length > 0 && (
          <div className="flex items-center gap-2 pt-2 border-t border-surface-0">
            <select
              id="add-orchestrator-select"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  handleAddOrchestrator(e.target.value);
                  e.target.value = '';
                }
              }}
              aria-label="Add orchestrator"
              className={`${settingsInput} w-[200px]`}
            >
              <option value="" disabled>Add orchestrator…</option>
              {availableToAdd.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className={settingsButton.ghost}>
          Cancel
        </button>
        <button type="button" onClick={handleSave} disabled={!name.trim()} className={settingsButton.primary}>
          Save
        </button>
      </div>
    </SettingsBlock>
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
    <SettingsPage
      title="Profiles"
      description="Switch between accounts or configurations, like work and personal. A profile holds env vars for one or more orchestrators."
      actions={
        <button type="button" onClick={handleCreate} disabled={editingId !== null} className={settingsButton.primary}>
          New profile
        </button>
      }
    >
      <p className={`${settingsHelp} mt-3`}>
        For Claude Code, set <code className={CODE_CLASS}>CLAUDE_CONFIG_DIR</code> to a separate directory, like{' '}
        <code className={CODE_CLASS}>~/.claude-work</code>. Then run <code className={CODE_CLASS}>/login</code> once with that profile to cache its credentials.
      </p>

      <SettingsSection title="Saved profiles" meta={profiles.length > 0 ? String(profiles.length) : undefined}>
        {profiles.map((p) => (
          <div key={p.id}>
            {editingId === p.id ? (
              <ProfileEditForm
                profile={p}
                onSave={handleSave}
                onCancel={() => {
                  setEditingId(null);
                  // If name is empty, it was just created, so remove it
                  if (!p.name) deleteProfile(p.id);
                }}
              />
            ) : (
              <div className="flex items-center gap-4 min-h-[46px] py-2 border-t border-surface-0" data-testid={`profile-row-${p.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] text-ctp-text">{p.name}</span>
                    <span className="text-xs text-ctp-overlay1">{getOrchestratorNames(p)}</span>
                  </div>
                  <div className="text-xs text-ctp-overlay1 mt-px font-mono truncate">
                    {Object.entries(p.orchestrators).map(([orchId, entry]) => {
                      const envStr = Object.entries(entry.env).map(([k, v]) => `${k}=${v}`).join(', ');
                      const orchName = allOrchestrators.find((o) => o.id === orchId)?.displayName || orchId;
                      return envStr ? `${orchName} ${envStr}` : null;
                    }).filter(Boolean).join(' · ') || 'No env vars set'}
                  </div>
                </div>
                <div className="flex-shrink-0 flex gap-1.5">
                  <button type="button" onClick={() => setEditingId(p.id)} className={settingsButton.ghost}>
                    Edit
                  </button>
                  <button type="button" onClick={() => setShowConfirmDelete(p.id)} className={settingsButton.danger}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {profiles.length === 0 && !editingId && (
          <SettingsBlock>
            <p className={settingsHelp}>No profiles configured yet.</p>
          </SettingsBlock>
        )}
      </SettingsSection>

      <SettingsSection title="Usage">
        <SettingsBlock>
          <p className={settingsHelp}>
            Assign a profile to a project in its Orchestrators &amp; agents settings. While a profile is active, agent
            creation only offers the orchestrators the profile configures, and the profile&apos;s env vars are injected
            when an agent starts.
          </p>
        </SettingsBlock>
      </SettingsSection>

      <Modal
        open={showConfirmDelete !== null}
        onClose={() => setShowConfirmDelete(null)}
        title="Delete profile?"
        width="w-[400px] max-w-[calc(100vw-32px)]"
      >
        <div data-testid="profile-delete-confirm">
          <p className={settingsHelp}>
            Agents that use this profile will fall back to the default configuration.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" onClick={() => setShowConfirmDelete(null)} className={settingsButton.ghost}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { if (showConfirmDelete) handleDelete(showConfirmDelete); }}
              className={settingsButton.danger}
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </SettingsPage>
  );
}
