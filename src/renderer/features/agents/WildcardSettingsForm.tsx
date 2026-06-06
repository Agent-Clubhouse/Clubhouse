import { useCallback, useEffect, useState } from 'react';
import { AgentWildcardSettings, SourceControlProvider } from '../../../shared/types';
import { WildcardLibraryField, LibraryOption } from './WildcardLibraryField';

interface Props {
  projectPath: string;
  agentId: string;
  /** True while the agent is running — fields become read-only. */
  disabled: boolean;
  /** Bump to force a re-read from disk. */
  refreshKey: number;
}

/** Editable form state derived from the resolved wildcard actuals. */
interface FormState {
  buildCommand: string;
  testCommand: string;
  lintCommand: string;
  sourceControlProvider: '' | SourceControlProvider;
  mission: string;
  persona: string;
}

function ReadOnlyField({ token, value }: { token: string; value: string }) {
  return (
    <div>
      <span className="text-xs font-mono text-ctp-text">{token}</span>
      <input
        type="text"
        value={value}
        readOnly
        tabIndex={-1}
        className="mt-1 w-full bg-surface-0/60 border border-surface-1 rounded px-2 py-1 text-sm text-ctp-subtext0 cursor-default select-text"
      />
    </div>
  );
}

function CommandField({
  token,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  token: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <span className="text-xs font-mono text-ctp-text">{token}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text placeholder:text-ctp-overlay0 focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}

/**
 * Simple per-agent wildcard editor shown when Clubhouse Mode manages an agent
 * (per-agent override disabled). Each supported wildcard gets a field populated
 * with its current actual; edits are saved as per-agent overrides to
 * `.clubhouse/agents.json` — the same surface the self-edit guide documents.
 */
export function WildcardSettingsForm({ projectPath, agentId, disabled, refreshKey }: Props) {
  const [data, setData] = useState<AgentWildcardSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [internalRefresh, setInternalRefresh] = useState(0);

  const load = useCallback(async () => {
    if (!projectPath) return;
    try {
      const w = await window.clubhouse.agentSettings.getAgentWildcards(projectPath, agentId);
      setData(w);
      if (w) {
        setForm({
          buildCommand: w.buildCommand.override ?? '',
          testCommand: w.testCommand.override ?? '',
          lintCommand: w.lintCommand.override ?? '',
          sourceControlProvider: w.sourceControlProvider.override ?? '',
          mission: w.mission.override ?? '',
          persona: w.persona.override ?? '',
        });
        setDirty(false);
      }
    } catch {
      setData(null);
    }
  }, [projectPath, agentId]);

  useEffect(() => {
    load();
  }, [load, refreshKey, internalRefresh]);

  if (!data || !form) {
    return <p className="text-xs text-ctp-subtext0/60">Loading wildcard settings…</p>;
  }

  const update = (patch: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.clubhouse.agent.updateDurableConfig(projectPath, agentId, {
        buildCommand: form.buildCommand.trim(),
        testCommand: form.testCommand.trim(),
        lintCommand: form.lintCommand.trim(),
        sourceControlProvider: form.sourceControlProvider || null,
        mission: form.mission,
        persona: form.persona,
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const missionOptions: LibraryOption[] = data.missions.map((m) => ({ id: m.id }));
  const personaOptions: LibraryOption[] = data.personas.map((p) => ({ id: p.id, label: `${p.name} (${p.id})`, source: p.source }));

  // Personas can be authored project-scoped or in the user-global library
  // (reusable across projects). Default the editor's scope to where the
  // currently-selected persona already lives.
  const personaScopeOptions = [
    { value: 'project', label: 'This project (.clubhouse/personas/)' },
    { value: 'user', label: 'All my projects (~/.clubhouse/personas/)' },
  ];
  const selectedPersonaSource = data.personas.find((p) => p.id === form.persona)?.source;
  const personaInitialScope = selectedPersonaSource === 'user' ? 'user' : 'project';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Wildcards</h3>
        <button
          onClick={handleSave}
          disabled={disabled || !dirty || saving}
          className={`text-xs px-3 py-1 rounded transition-colors ${
            disabled ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed' :
            dirty
              ? 'bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer'
              : 'bg-surface-1 text-ctp-subtext0 cursor-default'
          }`}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <p className="text-xs text-ctp-subtext0/60">
        These are this agent&apos;s wildcard values. Edits save as per-agent overrides to
        <span className="font-mono"> .clubhouse/agents.json</span> — the same setting an agent
        edits from the Clubhouse self-edit guide. Leave a field blank to inherit the project default.
      </p>

      {/* Identity — read-only computed actuals */}
      <section className="space-y-2">
        <h4 className="text-xs text-ctp-subtext0/60 uppercase tracking-wider">Identity (read-only)</h4>
        <ReadOnlyField token="@@AgentName" value={data.agentName} />
        <ReadOnlyField token="@@StandbyBranch" value={data.standbyBranch} />
        <ReadOnlyField token="@@Path" value={data.agentPath} />
      </section>

      {/* Commands + provider — editable per-agent overrides */}
      <section className="space-y-2">
        <h4 className="text-xs text-ctp-subtext0/60 uppercase tracking-wider">Commands &amp; provider</h4>
        <CommandField
          token="@@BuildCommand"
          value={form.buildCommand}
          placeholder={data.buildCommand.resolved}
          disabled={disabled}
          onChange={(v) => update({ buildCommand: v })}
        />
        <CommandField
          token="@@TestCommand"
          value={form.testCommand}
          placeholder={data.testCommand.resolved}
          disabled={disabled}
          onChange={(v) => update({ testCommand: v })}
        />
        <CommandField
          token="@@LintCommand"
          value={form.lintCommand}
          placeholder={data.lintCommand.resolved}
          disabled={disabled}
          onChange={(v) => update({ lintCommand: v })}
        />
        <div>
          <span className="text-xs font-mono text-ctp-text">@@SourceControlProvider</span>
          <select
            value={form.sourceControlProvider}
            disabled={disabled}
            onChange={(e) => update({ sourceControlProvider: e.target.value as '' | SourceControlProvider })}
            className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">Inherit project default ({data.sourceControlProvider.resolved})</option>
            <option value="github">github</option>
            <option value="azure-devops">azure-devops</option>
          </select>
        </div>
      </section>

      {/* Mission + persona — authorable library fields */}
      <section className="space-y-3">
        <h4 className="text-xs text-ctp-subtext0/60 uppercase tracking-wider">Mission &amp; persona</h4>
        <WildcardLibraryField
          token="@@Mission"
          help="The mission body substituted for @@Mission. Authored under .clubhouse/missions/."
          noun="mission"
          value={form.mission}
          projectDefault={data.mission.projectDefault}
          options={missionOptions}
          disabled={disabled}
          onChange={(id) => update({ mission: id })}
          loadContent={(id) => window.clubhouse.agentSettings.readSourceMissionContent(projectPath, id)}
          saveContent={(id, content) => window.clubhouse.agentSettings.writeSourceMissionContent(projectPath, id, content)}
          deleteItem={(id) => window.clubhouse.agentSettings.deleteSourceMission(projectPath, id)}
          onLibraryChanged={() => setInternalRefresh((n) => n + 1)}
        />
        <WildcardLibraryField
          token="@@Persona"
          help="The persona body substituted for @@Persona. Built-ins seed the list; save to this project or to your user-global library (~/.clubhouse/personas/) to reuse across projects. Project overrides user overrides built-in."
          noun="persona"
          value={form.persona}
          projectDefault={data.persona.projectDefault}
          options={personaOptions}
          disabled={disabled}
          scopeOptions={personaScopeOptions}
          initialScope={personaInitialScope}
          onChange={(id) => update({ persona: id })}
          loadContent={(id) => window.clubhouse.agentSettings.readSourcePersonaContent(projectPath, id)}
          saveContent={(id, content, scope) => window.clubhouse.agentSettings.writeSourcePersonaContent(projectPath, id, content, scope === 'user' ? 'user' : 'project')}
          deleteItem={(id, scope) => window.clubhouse.agentSettings.deleteSourcePersona(projectPath, id, scope === 'user' ? 'user' : 'project')}
          onLibraryChanged={() => setInternalRefresh((n) => n + 1)}
        />
      </section>
    </div>
  );
}
