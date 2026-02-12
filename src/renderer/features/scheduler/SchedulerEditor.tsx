import { useState, useEffect } from 'react';
import { useSchedulerStore } from '../../stores/schedulerStore';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { AgentAvatarWithRing } from '../agents/AgentAvatar';
import { MODEL_OPTIONS } from '../../../shared/models';
import { describeSchedule } from '../../../shared/cron';

const SCHEDULE_PRESETS = [
  { label: 'Every 15m', cron: '*/15 * * * *' },
  { label: 'Every 30m', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 6h', cron: '0 */6 * * *' },
  { label: 'Daily 9 AM', cron: '0 9 * * *' },
  { label: 'Weekly Mon', cron: '0 9 * * 1' },
];

export function SchedulerEditor() {
  const { jobs, selectedJobId, updateJob } = useSchedulerStore();
  const agents = useAgentStore((s) => s.agents);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const job = jobs.find((j) => j.id === selectedJobId);

  const [name, setName] = useState('');
  const [cronExpression, setCronExpression] = useState('');
  const [agentType, setAgentType] = useState<'quick' | 'durable'>('quick');
  const [agentId, setAgentId] = useState<string | undefined>();
  const [model, setModel] = useState('default');
  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);

  const durableAgents = Object.values(agents).filter(
    (a) => a.kind === 'durable' && a.projectId === activeProjectId
  );

  // Sync form state when selected job changes
  useEffect(() => {
    if (!job) return;
    setName(job.name);
    setCronExpression(job.cronExpression);
    setAgentType(job.agentType);
    setAgentId(job.agentId);
    setModel(job.model || 'default');
    setPrompt(job.prompt);
    setEnabled(job.enabled);
    setDirty(false);
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <div className="text-center text-ctp-subtext0">
          <svg className="mx-auto mb-3" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <p className="text-sm">Select a job or create one</p>
        </div>
      </div>
    );
  }

  const markDirty = () => setDirty(true);

  const handleSave = async () => {
    await updateJob(job.id, {
      name,
      cronExpression,
      agentType,
      agentId,
      model: agentType === 'quick' ? model : undefined,
      prompt,
      enabled,
    });
    setDirty(false);
  };

  return (
    <div className="h-full bg-ctp-base flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-surface-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${enabled ? 'bg-green-500' : 'bg-ctp-overlay0'}`} />
          <h2 className="text-sm font-semibold text-ctp-text">{name || 'Untitled Job'}</h2>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="w-2 h-2 rounded-full bg-orange-400" title="Unsaved changes" />}
          <button
            onClick={handleSave}
            disabled={!dirty}
            className="px-3 py-1 text-xs rounded bg-indigo-500/80 text-white hover:bg-indigo-500 cursor-pointer font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Name */}
        <div>
          <label className="block text-xs font-medium text-ctp-subtext0 mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); markDirty(); }}
            className="w-full px-3 py-2 text-sm rounded-lg border border-surface-0 bg-ctp-mantle text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-indigo-500"
            placeholder="Job name"
          />
        </div>

        {/* Schedule */}
        <div>
          <label className="block text-xs font-medium text-ctp-subtext0 mb-1.5">Schedule</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {SCHEDULE_PRESETS.map((preset) => (
              <button
                key={preset.cron}
                onClick={() => { setCronExpression(preset.cron); markDirty(); }}
                className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors ${
                  cronExpression === preset.cron
                    ? 'border-indigo-500 bg-indigo-500/10 text-ctp-text'
                    : 'border-surface-0 text-ctp-subtext0 hover:border-surface-2 hover:bg-surface-0'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={cronExpression}
            onChange={(e) => { setCronExpression(e.target.value); markDirty(); }}
            className="w-full px-3 py-2 text-sm rounded-lg border border-surface-0 bg-ctp-mantle text-ctp-text font-mono placeholder:text-ctp-overlay0 focus:outline-none focus:border-indigo-500"
            placeholder="* * * * *  (min hour dom month dow)"
          />
          <p className="text-xs text-ctp-overlay0 mt-1">{describeSchedule(cronExpression)}</p>
        </div>

        {/* Agent Type */}
        <div>
          <label className="block text-xs font-medium text-ctp-subtext0 mb-1.5">Agent</label>
          <div className="flex gap-2 mb-2">
            <button
              onClick={() => { setAgentType('quick'); markDirty(); }}
              className={`px-3 py-1.5 text-xs rounded-lg border cursor-pointer transition-colors ${
                agentType === 'quick'
                  ? 'border-indigo-500 bg-indigo-500/10 text-ctp-text'
                  : 'border-surface-0 text-ctp-subtext0 hover:border-surface-2 hover:bg-surface-0'
              }`}
            >
              Quick Agent
            </button>
            <button
              onClick={() => { setAgentType('durable'); markDirty(); }}
              className={`px-3 py-1.5 text-xs rounded-lg border cursor-pointer transition-colors ${
                agentType === 'durable'
                  ? 'border-indigo-500 bg-indigo-500/10 text-ctp-text'
                  : 'border-surface-0 text-ctp-subtext0 hover:border-surface-2 hover:bg-surface-0'
              }`}
            >
              Durable Agent
            </button>
          </div>

          {/* Quick agent model selector */}
          {agentType === 'quick' && (
            <div className="mt-2">
              <label className="block text-xs text-ctp-overlay0 mb-1">Model</label>
              <select
                value={model}
                onChange={(e) => { setModel(e.target.value); markDirty(); }}
                className="px-2 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2 text-ctp-text focus:outline-none focus:border-indigo-500"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Durable agent selector */}
          {agentType === 'durable' && (
            <div className="space-y-1 mt-2">
              {durableAgents.length === 0 && (
                <p className="text-xs text-ctp-overlay0">No durable agents in this project</p>
              )}
              {durableAgents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => { setAgentId(agent.id); markDirty(); }}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer flex items-center gap-3 ${
                    agentId === agent.id
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-surface-0 hover:border-surface-2 hover:bg-surface-0'
                  }`}
                >
                  <AgentAvatarWithRing agent={agent} />
                  <span className="text-sm text-ctp-text truncate flex-1">{agent.name}</span>
                  <span className="text-xs text-ctp-subtext0">{agent.status}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Prompt */}
        <div>
          <label className="block text-xs font-medium text-ctp-subtext0 mb-1.5">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); markDirty(); }}
            placeholder="What should the agent do?"
            className="w-full px-3 py-2 text-sm rounded-lg border border-surface-0 bg-ctp-mantle text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-indigo-500 resize-none"
            rows={6}
          />
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-ctp-subtext0">Enabled</label>
          <button
            onClick={() => { setEnabled(!enabled); markDirty(); }}
            className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${
              enabled ? 'bg-green-500' : 'bg-surface-2'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Last run info */}
        {job.lastRunAt && (
          <p className="text-xs text-ctp-overlay0">
            Last run: {new Date(job.lastRunAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
