import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule, ModelOption } from '../../../../shared/plugin-types';
import type { Automation, RunRecord } from './types';
import { matchesCron, describeSchedule, PRESETS } from './cron';

// ── Storage keys ────────────────────────────────────────────────────────
const AUTOMATIONS_KEY = 'automations';
const runsKey = (automationId: string) => `runs:${automationId}`;
const MAX_RUNS = 50;

// ── activate() ──────────────────────────────────────────────────────────

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const storage = api.storage.projectLocal;

  // Track agent → automation mapping for runs in flight
  const pendingRuns = new Map<string, string>();

  // 1. onStatusChange — detect agent completion
  const statusSub = api.agents.onStatusChange((agentId, status, prevStatus) => {
    const automationId = pendingRuns.get(agentId);
    if (!automationId) return;

    const isCompleted =
      (prevStatus === 'running' && status === 'sleeping') ||
      (prevStatus === 'running' && status === 'error');

    if (!isCompleted) return;

    pendingRuns.delete(agentId);

    // Look up summary from completed agents
    const completed = api.agents.listCompleted();
    const info = completed.find((c) => c.id === agentId);

    const runStatus = status === 'sleeping' ? 'completed' as const : 'failed' as const;

    // Update run record in storage
    storage.read(runsKey(automationId)).then((raw) => {
      const runs: RunRecord[] = Array.isArray(raw) ? raw : [];
      const idx = runs.findIndex((r) => r.agentId === agentId);
      if (idx !== -1) {
        runs[idx] = {
          ...runs[idx],
          status: runStatus,
          summary: info?.summary ?? null,
          exitCode: info?.exitCode ?? null,
          completedAt: Date.now(),
        };
      }
      storage.write(runsKey(automationId), runs);
    });

    // Update lastRunAt on the automation
    storage.read(AUTOMATIONS_KEY).then((raw) => {
      const automations: Automation[] = Array.isArray(raw) ? raw : [];
      const auto = automations.find((a) => a.id === automationId);
      if (auto) {
        auto.lastRunAt = Date.now();
        storage.write(AUTOMATIONS_KEY, automations);
      }
    });
  });
  ctx.subscriptions.push(statusSub);

  // 2. Cron tick — every 30 seconds
  const tickInterval = setInterval(async () => {
    const now = new Date();
    const raw = await storage.read(AUTOMATIONS_KEY);
    const automations: Automation[] = Array.isArray(raw) ? raw : [];

    for (const auto of automations) {
      if (!auto.enabled) continue;
      if (!matchesCron(auto.cronExpression, now)) continue;

      // Prevent re-firing within the same minute
      if (auto.lastRunAt) {
        const lastRun = new Date(auto.lastRunAt);
        if (
          lastRun.getMinutes() === now.getMinutes() &&
          lastRun.getHours() === now.getHours() &&
          lastRun.getDate() === now.getDate() &&
          lastRun.getMonth() === now.getMonth() &&
          lastRun.getFullYear() === now.getFullYear()
        ) {
          continue;
        }
      }

      // Fire the agent
      try {
        const agentId = await api.agents.runQuick(auto.prompt, {
          model: auto.model || undefined,
        });

        pendingRuns.set(agentId, auto.id);

        // Record the run
        const runsRaw = await storage.read(runsKey(auto.id));
        const runs: RunRecord[] = Array.isArray(runsRaw) ? runsRaw : [];
        runs.unshift({
          agentId,
          automationId: auto.id,
          startedAt: Date.now(),
          status: 'running',
          summary: null,
          exitCode: null,
          completedAt: null,
        });
        // Cap at MAX_RUNS
        if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
        await storage.write(runsKey(auto.id), runs);

        // Update lastRunAt
        auto.lastRunAt = Date.now();
        await storage.write(AUTOMATIONS_KEY, automations);
      } catch {
        // Agent spawn failed — skip silently
      }
    }
  }, 30_000);

  ctx.subscriptions.push({ dispose: () => clearInterval(tickInterval) });

  // 3. Register create command
  const cmdSub = api.commands.register('create', () => {
    // Command fires from header — the MainPanel handles creation via storage
  });
  ctx.subscriptions.push(cmdSub);
}

export function deactivate(): void {
  // subscriptions auto-disposed
}

// ── helpers ─────────────────────────────────────────────────────────────

function generateId(): string {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ── MainPanel ───────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const storage = api.storage.projectLocal;

  const [automations, setAutomations] = useState<Automation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Editor state
  const [editName, setEditName] = useState('');
  const [editCron, setEditCron] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editEnabled, setEditEnabled] = useState(true);
  const [editPreset, setEditPreset] = useState('custom');

  // ── Load automations on mount + poll ────────────────────────────────
  const loadAutomations = useCallback(async () => {
    const raw = await storage.read(AUTOMATIONS_KEY);
    const list: Automation[] = Array.isArray(raw) ? raw : [];
    setAutomations(list);
    if (!loaded) setLoaded(true);
  }, [storage, loaded]);

  useEffect(() => {
    loadAutomations();
    const iv = setInterval(loadAutomations, 10_000);
    return () => clearInterval(iv);
  }, [loadAutomations]);

  // ── Load model options ──────────────────────────────────────────────
  useEffect(() => {
    api.agents.getModelOptions().then(setModelOptions);
  }, [api]);

  // ── Sync editor when selection changes ──────────────────────────────
  const selected = automations.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    if (selected) {
      setEditName(selected.name);
      setEditCron(selected.cronExpression);
      setEditModel(selected.model);
      setEditPrompt(selected.prompt);
      setEditEnabled(selected.enabled);
      const preset = PRESETS.find((p) => p.value === selected.cronExpression);
      setEditPreset(preset ? preset.value : 'custom');
    }
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load runs for selected automation ───────────────────────────────
  const loadRuns = useCallback(async () => {
    if (!selectedId) { setRuns([]); return; }
    const raw = await storage.read(runsKey(selectedId));
    setRuns(Array.isArray(raw) ? raw : []);
  }, [storage, selectedId]);

  useEffect(() => {
    loadRuns();
    const iv = setInterval(loadRuns, 5_000);
    return () => clearInterval(iv);
  }, [loadRuns]);

  // ── Actions ─────────────────────────────────────────────────────────
  const createAutomation = useCallback(async () => {
    const auto: Automation = {
      id: generateId(),
      name: 'New Automation',
      cronExpression: '0 * * * *',
      model: '',
      prompt: '',
      enabled: false,
      createdAt: Date.now(),
      lastRunAt: null,
    };
    const next = [...automations, auto];
    await storage.write(AUTOMATIONS_KEY, next);
    setAutomations(next);
    setSelectedId(auto.id);
  }, [automations, storage]);

  const saveAutomation = useCallback(async () => {
    if (!selectedId) return;
    const next = automations.map((a) =>
      a.id === selectedId
        ? { ...a, name: editName, cronExpression: editCron, model: editModel, prompt: editPrompt, enabled: editEnabled }
        : a,
    );
    await storage.write(AUTOMATIONS_KEY, next);
    setAutomations(next);
  }, [selectedId, automations, storage, editName, editCron, editModel, editPrompt, editEnabled]);

  const deleteAutomation = useCallback(async () => {
    if (!selectedId) return;
    const next = automations.filter((a) => a.id !== selectedId);
    await storage.write(AUTOMATIONS_KEY, next);
    await storage.delete(runsKey(selectedId));
    setAutomations(next);
    setSelectedId(next.length > 0 ? next[0].id : null);
  }, [selectedId, automations, storage]);

  const toggleEnabled = useCallback(async (id: string) => {
    const next = automations.map((a) =>
      a.id === id ? { ...a, enabled: !a.enabled } : a,
    );
    await storage.write(AUTOMATIONS_KEY, next);
    setAutomations(next);
    if (id === selectedId) setEditEnabled(!editEnabled);
  }, [automations, storage, selectedId, editEnabled]);

  // Stable refs for callbacks
  const actionsRef = useRef({ createAutomation, saveAutomation, deleteAutomation, toggleEnabled });
  actionsRef.current = { createAutomation, saveAutomation, deleteAutomation, toggleEnabled };

  if (!loaded) {
    return React.createElement('div', { className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs' }, 'Loading automations...');
  }

  // ── Render ──────────────────────────────────────────────────────────
  return React.createElement('div', { className: 'flex h-full bg-ctp-base' },
    // ── Left sidebar: automation list ──────────────────────────────────
    React.createElement('div', { className: 'w-64 flex-shrink-0 border-r border-ctp-surface0 bg-ctp-mantle flex flex-col' },
      // Header
      React.createElement('div', { className: 'flex items-center justify-between px-3 py-2 border-b border-ctp-surface0' },
        React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, 'Automations'),
        React.createElement('button', {
          className: 'px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: () => actionsRef.current.createAutomation(),
          title: 'Add automation',
        }, '+ Add'),
      ),
      // List
      React.createElement('div', { className: 'flex-1 overflow-y-auto' },
        automations.length === 0
          ? React.createElement('div', { className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center' }, 'No automations yet')
          : automations.map((auto) =>
              React.createElement('div', {
                key: auto.id,
                className: `flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-ctp-surface0 transition-colors ${
                  auto.id === selectedId ? 'bg-ctp-surface0' : 'hover:bg-ctp-surface0/50'
                }`,
                onClick: () => setSelectedId(auto.id),
              },
                // Enabled dot
                React.createElement('button', {
                  className: `w-2 h-2 rounded-full flex-shrink-0 ${auto.enabled ? 'bg-ctp-green' : 'bg-ctp-surface2'}`,
                  onClick: (e: React.MouseEvent) => { e.stopPropagation(); actionsRef.current.toggleEnabled(auto.id); },
                  title: auto.enabled ? 'Disable' : 'Enable',
                }),
                React.createElement('div', { className: 'flex-1 min-w-0' },
                  React.createElement('div', { className: 'text-xs text-ctp-text truncate' }, auto.name || 'Untitled'),
                  React.createElement('div', { className: 'text-[10px] text-ctp-subtext0 truncate' }, describeSchedule(auto.cronExpression)),
                ),
              ),
            ),
      ),
    ),

    // ── Right: editor + runs ──────────────────────────────────────────
    selected
      ? React.createElement('div', { className: 'flex-1 flex flex-col min-w-0 overflow-y-auto' },
          // Editor section
          React.createElement('div', { className: 'p-4 border-b border-ctp-surface0 space-y-3' },
            // Name
            React.createElement('div', null,
              React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Name'),
              React.createElement('input', {
                type: 'text',
                className: 'w-full px-2 py-1 text-xs bg-ctp-surface0 text-ctp-text rounded border border-ctp-surface1 focus:border-ctp-blue focus:outline-none',
                value: editName,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditName(e.target.value),
              }),
            ),
            // Schedule
            React.createElement('div', null,
              React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Schedule'),
              React.createElement('div', { className: 'flex gap-2' },
                React.createElement('select', {
                  className: 'flex-1 px-2 py-1 text-xs bg-ctp-surface0 text-ctp-text rounded border border-ctp-surface1 focus:border-ctp-blue focus:outline-none',
                  value: editPreset,
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                    const val = e.target.value;
                    setEditPreset(val);
                    if (val !== 'custom') setEditCron(val);
                  },
                },
                  PRESETS.map((p) =>
                    React.createElement('option', { key: p.value, value: p.value }, p.label),
                  ),
                  React.createElement('option', { value: 'custom' }, 'Custom'),
                ),
              ),
              editPreset === 'custom' && React.createElement('input', {
                type: 'text',
                className: 'w-full mt-1 px-2 py-1 text-xs bg-ctp-surface0 text-ctp-text rounded border border-ctp-surface1 focus:border-ctp-blue focus:outline-none font-mono',
                value: editCron,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditCron(e.target.value),
                placeholder: '* * * * *',
              }),
              React.createElement('div', { className: 'text-[10px] text-ctp-subtext0 mt-1' }, describeSchedule(editCron)),
            ),
            // Model
            React.createElement('div', null,
              React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Model'),
              React.createElement('select', {
                className: 'w-full px-2 py-1 text-xs bg-ctp-surface0 text-ctp-text rounded border border-ctp-surface1 focus:border-ctp-blue focus:outline-none',
                value: editModel,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setEditModel(e.target.value),
              },
                React.createElement('option', { value: '' }, 'Default'),
                modelOptions.map((m) =>
                  React.createElement('option', { key: m.id, value: m.id }, m.label),
                ),
              ),
            ),
            // Prompt
            React.createElement('div', null,
              React.createElement('label', { className: 'block text-xs text-ctp-subtext1 mb-1' }, 'Prompt'),
              React.createElement('textarea', {
                className: 'w-full px-2 py-1 text-xs bg-ctp-surface0 text-ctp-text rounded border border-ctp-surface1 focus:border-ctp-blue focus:outline-none resize-y min-h-[80px] font-mono',
                rows: 4,
                value: editPrompt,
                onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setEditPrompt(e.target.value),
                placeholder: 'Enter the mission for the agent...',
              }),
            ),
            // Enabled toggle
            React.createElement('div', { className: 'flex items-center gap-2' },
              React.createElement('button', {
                className: `relative w-8 h-4 rounded-full transition-colors ${editEnabled ? 'bg-ctp-green' : 'bg-ctp-surface2'}`,
                onClick: () => setEditEnabled(!editEnabled),
              },
                React.createElement('span', {
                  className: `absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${editEnabled ? 'left-4' : 'left-0.5'}`,
                }),
              ),
              React.createElement('span', { className: 'text-xs text-ctp-subtext1' }, editEnabled ? 'Enabled' : 'Disabled'),
            ),
            // Action buttons
            React.createElement('div', { className: 'flex gap-2 pt-1' },
              React.createElement('button', {
                className: 'px-3 py-1 text-xs bg-ctp-blue text-ctp-base rounded hover:opacity-90 transition-opacity',
                onClick: () => actionsRef.current.saveAutomation(),
              }, 'Save'),
              React.createElement('button', {
                className: 'px-3 py-1 text-xs bg-ctp-surface1 text-ctp-text rounded hover:bg-ctp-surface2 transition-colors',
                onClick: () => actionsRef.current.deleteAutomation(),
              }, 'Delete'),
            ),
          ),

          // Runs section
          React.createElement('div', { className: 'p-4' },
            React.createElement('div', { className: 'text-xs font-medium text-ctp-text mb-2' }, 'Run History'),
            runs.length === 0
              ? React.createElement('div', { className: 'text-xs text-ctp-subtext0' }, 'No runs yet')
              : React.createElement('div', { className: 'space-y-1' },
                  runs.slice(0, 20).map((run) =>
                    React.createElement('div', {
                      key: run.agentId,
                      className: 'flex items-center gap-2 px-2 py-1.5 bg-ctp-mantle rounded text-xs',
                    },
                      React.createElement('span', {
                        className: `w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          run.status === 'running' ? 'bg-ctp-yellow' :
                          run.status === 'completed' ? 'bg-ctp-green' :
                          'bg-ctp-red'
                        }`,
                      }),
                      React.createElement('span', { className: 'text-ctp-subtext0 flex-shrink-0' }, formatTime(run.startedAt)),
                      React.createElement('span', { className: 'text-ctp-text truncate flex-1' },
                        run.status === 'running' ? 'Running...' :
                        run.summary || (run.status === 'completed' ? 'Completed' : 'Failed'),
                      ),
                      run.exitCode !== null && React.createElement('span', {
                        className: `text-[10px] ${run.exitCode === 0 ? 'text-ctp-green' : 'text-ctp-red'}`,
                      }, `exit ${run.exitCode}`),
                    ),
                  ),
                ),
          ),
        )
      : React.createElement('div', { className: 'flex-1 flex items-center justify-center text-ctp-subtext0 text-xs' },
          automations.length === 0
            ? 'Create an automation to get started'
            : 'Select an automation to edit',
        ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
