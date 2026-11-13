/**
 * New / edit action (#2953): trigger first, then steps, then the overlap rule.
 * Run now fires the saved action as a normal run. The footer says who usage
 * counts toward.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  AGENT_EVENT_KINDS,
  APP_EVENT_KINDS,
  DEVICE_EVENT_KINDS,
  EVENT_LABELS,
  GIT_EVENT_KINDS,
  GROUP_PROJECT_EVENT_KINDS,
  MAX_ACTION_STEPS,
  MAX_DELAY_MINUTES,
  MIN_ABSENCE_MINUTES,
  DEFAULT_ABSENCE_MINUTES,
  DEFAULT_COALESCE_SECONDS,
  MIN_COALESCE_SECONDS,
  MAX_COALESCE_SECONDS,
  ANY_AGENT_EVENT_KINDS,
  MISSED_RUN_LABELS,
  OVERLAP_LABELS,
  PRESET_LABELS,
  SCHEDULE_PRESETS,
  describeCron,
  nextCronTimes,
  parseCron,
  suggestActionName,
  QUICK_STEP_ACCESS,
  type ActionEventKind,
  type ActionInput,
  type ActionOwner,
  type ActionStepKind,
  type ActionView,
  type MissedRunRule,
  type OverlapRule,
  type SchedulePreset,
} from '../../../shared/actions';
import { accessLabel } from '../../../shared/agent-access';
import { HELPER_DIFFICULTIES, isHelperDifficulty } from '../../../shared/helper-routing';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useAnnexStore } from '../../stores/annexStore';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { settingsError, settingsHelp, settingsInput, settingsLabel, settingsTextArea } from '../settings/SettingsLayout';
import { draftCron, draftFrom, draftToInput, emptyStep, newDraft, type ActionDraft, type StepDraft } from './action-draft';
import { ownerLabel, useActionNames, type AgentOption, type ProjectOption } from './useActions';

const STEP_LABELS: Record<ActionStepKind, string> = {
  wake: 'Wake an agent',
  message: 'Message an agent',
  quick: 'Start a quick agent',
  sleep: 'Put an agent to sleep',
  notify: 'Notify me',
  group_post: 'Post to the group board',
  group_tap: 'Tap a group member',
};
const STEP_ORDER: ActionStepKind[] = ['wake', 'message', 'quick', 'sleep', 'notify', 'group_post', 'group_tap'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const selectClass = settingsInput;
const fieldGap = 'mt-3';

function Field({ label, htmlFor, help, children }: { label: string; htmlFor?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className={fieldGap}>
      <label className={settingsLabel} {...(htmlFor && { htmlFor })}>{label}</label>
      {children}
      {help && <div className={`${settingsHelp} mt-1`}>{help}</div>}
    </div>
  );
}

function formatRun(d: Date): string {
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function AgentSelect({ id, value, onChange, agents, projects, includeProjects, includeAny, placeholder }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  agents: AgentOption[];
  projects: ProjectOption[];
  /** Offer "Any agent in <project>" (values 'project:<id>'), with agents as 'agent:<id>'. */
  includeProjects?: boolean;
  includeAny?: boolean;
  placeholder: string;
}) {
  const byProject = projects.map((p) => ({ project: p, agents: agents.filter((a) => a.projectId === p.id) }))
    .filter((g) => g.agents.length > 0 || includeProjects);
  const other = agents.filter((a) => !projects.some((p) => p.id === a.projectId));
  const v = (a: AgentOption) => (includeProjects ? `agent:${a.id}` : a.id);
  return (
    <select id={id} className={`${selectClass} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {includeAny && <option value="any">Any readable agent</option>}
      {byProject.map(({ project, agents: list }) => (
        <optgroup key={project.id} label={project.name}>
          {includeProjects && <option value={`project:${project.id}`}>Any agent in {project.name}</option>}
          {list.map((a) => <option key={a.id} value={v(a)}>{a.name}</option>)}
        </optgroup>
      ))}
      {other.length > 0 && (
        <optgroup label="Other">
          {other.map((a) => <option key={a.id} value={v(a)}>{a.name}</option>)}
        </optgroup>
      )}
    </select>
  );
}

function StepEditor({ index, step, onChange, onRemove, agents, projects, canRemove }: {
  index: number;
  step: StepDraft;
  onChange: (s: StepDraft) => void;
  onRemove: () => void;
  agents: AgentOption[];
  projects: ProjectOption[];
  canRemove: boolean;
}) {
  const uid = useId();
  const orchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const set = (patch: Partial<StepDraft>) => onChange({ ...step, ...patch });
  const worktreeAgents = agents.filter((a) => a.projectId === step.projectId && a.worktreePath);
  return (
    <div className="py-3 border-t border-surface-0" data-testid={`action-step-${index}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-ctp-overlay1 w-12 flex-shrink-0">Step {index + 1}</span>
        <select aria-label={`Step ${index + 1} type`} className={`${selectClass} flex-1`} value={step.kind}
          onChange={(e) => onChange({ ...emptyStep(e.target.value as ActionStepKind), agentId: step.agentId, projectId: step.projectId, text: step.text })}>
          {STEP_ORDER.map((k) => <option key={k} value={k}>{STEP_LABELS[k]}</option>)}
        </select>
        {canRemove && <Button kind="quiet" onClick={onRemove} aria-label={`Remove step ${index + 1}`}>Remove</Button>}
      </div>
      {(step.kind === 'wake' || step.kind === 'message' || step.kind === 'sleep' || step.kind === 'group_tap') && (
        <Field label="Agent" htmlFor={`${uid}-agent`}>
          <AgentSelect id={`${uid}-agent`} value={step.agentId} onChange={(agentId) => set({ agentId })} agents={agents} projects={projects} placeholder="Pick an agent" />
        </Field>
      )}
      {step.kind === 'group_post' && <Field label="Topic" htmlFor={`${uid}-topic`}><input id={`${uid}-topic`} className={`${settingsInput} w-full`} value={step.topic} onChange={(e) => set({ topic: e.target.value })} /></Field>}
      {(step.kind === 'group_post' || step.kind === 'group_tap') && <Field label="Message" htmlFor={`${uid}-group-text`}><textarea id={`${uid}-group-text`} className={`${settingsTextArea} w-full`} value={step.text} onChange={(e) => set({ text: e.target.value })} /></Field>}
      {step.kind === 'quick' && (
        <>
          <Field label="Project" htmlFor={`${uid}-project`}>
            <select id={`${uid}-project`} className={`${selectClass} w-full`} value={step.projectId} onChange={(e) => set({ projectId: e.target.value, worktreeAgentId: '' })}>
              <option value="">Pick a project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Where it runs" htmlFor={`${uid}-where`}>
            <select id={`${uid}-where`} className={`${selectClass} w-full`} value={step.worktreeAgentId} onChange={(e) => set({ worktreeAgentId: e.target.value })}>
              <option value="">The project folder</option>
              {worktreeAgents.map((a) => <option key={a.id} value={a.id}>{a.name}’s worktree</option>)}
            </select>
          </Field>
          <Field label="Provider" htmlFor={`${uid}-provider`}>
            <select id={`${uid}-provider`} className={`${selectClass} w-full`} value={step.orchestrator} onChange={(e) => set({ orchestrator: e.target.value, model: '' })}>
              <option value="">The project’s provider</option>
              <option value="auto">Auto</option>
              {orchestrators.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          </Field>
          {step.orchestrator === 'auto' && (
            <Field label="Difficulty" htmlFor={`${uid}-difficulty`} help="Auto uses your helper routing settings to choose a provider and model.">
              <select id={`${uid}-difficulty`} className={`${selectClass} w-full`} value={step.difficulty}
                onChange={(e) => { if (isHelperDifficulty(e.target.value)) set({ difficulty: e.target.value }); }}>
                {HELPER_DIFFICULTIES.map((difficulty) => <option key={difficulty} value={difficulty}>{difficulty}</option>)}
              </select>
            </Field>
          )}
          <div className={`${settingsHelp} mt-1`} data-testid="action-form-quick-access">
            Agent steps run with {accessLabel(QUICK_STEP_ACCESS)}, so they never stop to ask.
          </div>
        </>
      )}
      {step.kind !== 'sleep' && (
        <Field
          label={step.kind === 'wake' ? 'Prompt (optional)' : step.kind === 'notify' ? 'Notice text' : step.kind === 'message' ? 'Message' : 'Prompt'}
          htmlFor={`${uid}-text`}
          help={step.kind === 'wake' ? 'It resumes its last session. If it’s already awake, it gets this as a message.'
            : step.kind === 'message' ? 'If it is asleep, it is woken with the message. Choose how a busy agent receives it below.'
              : step.kind === 'notify' ? 'Shown as a Clubhouse notification, following Settings > Notifications & alerts.' : undefined}
        >
          <textarea id={`${uid}-text`} rows={3} className={settingsTextArea} value={step.text} onChange={(e) => set({ text: e.target.value })} />
        </Field>
      )}
      {step.kind === 'message' && (
        <>
          <Field label="When the agent is busy" htmlFor={`${uid}-delivery`}
            help="Queue waits for its next turn. Steer uses the same mid-turn path as your messages, falling back to queue when unsupported.">
            <select id={`${uid}-delivery`} className={`${selectClass} w-full`} value={step.delivery || 'queue'}
              onChange={(e) => set({ delivery: e.target.value as 'queue' | 'steer' })}>
              <option value="queue">Queue for the next turn</option>
              <option value="steer">Steer the current turn</option>
            </select>
          </Field>
          <Field label="Keep only the latest queued message" htmlFor={`${uid}-latest`}
            help="A newer queued message from this action replaces its older messages. Other actions and your messages are unchanged.">
            <input id={`${uid}-latest`} type="checkbox" checked={step.latestOnly ?? false} onChange={(e) => set({ latestOnly: e.target.checked })} />
          </Field>
          <Field label="Maximum queue wait (minutes, optional)" htmlFor={`${uid}-max-wait`}
            help="An undelivered message is removed when this time passes and recorded as expired in history. Applies if steering falls back to queue too.">
            <input id={`${uid}-max-wait`} type="number" min={1} max={MAX_DELAY_MINUTES} step={1} className={`${settingsInput} w-32`}
              value={step.maxWaitMinutes} onChange={(e) => set({ maxWaitMinutes: e.target.value })} />
          </Field>
        </>
      )}
    </div>
  );
}

export function ActionForm({ open, action, initial, initialGroupProjectId, onClose, onSaved }: {
  open: boolean;
  /** Editing this action; otherwise a new one. */
  action?: ActionView;
  /** A pre-filled new action (a starter pattern, or "New action for <agent>"). */
  initial?: Partial<ActionInput>;
  initialGroupProjectId?: string;
  onClose: () => void;
  onSaved?: (a: ActionView) => void;
}) {
  const uid = useId();
  const { names, agents, projects } = useActionNames();
  const loadOrchestrators = useOrchestratorStore((s) => s.loadSettings);
  useEffect(() => { void loadOrchestrators(); }, [loadOrchestrators]);
  const [draft, setDraft] = useState<ActionDraft>(() => (action ? draftFrom(action) : initial ? draftFrom(initial) : newDraft()));
  const [openedDraft, setOpenedDraft] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [groupOwner, setGroupOwner] = useState('');
  const devices = useAnnexStore((s) => s.devices);
  const loadDevices = useAnnexStore((s) => s.loadDevices);
  const eventIsDevice = DEVICE_EVENT_KINDS.includes(draft.event);
  const eventIsGroup = GROUP_PROJECT_EVENT_KINDS.includes(draft.event);
  const eventIsIdle = draft.event === 'agent.idle' || draft.event === 'group_project.board_idle';
  const groupProjects = useGroupProjectStore((s) => s.projects);
  const loadGroupProjects = useGroupProjectStore((s) => s.loadProjects);
  useEffect(() => { if (open) void loadGroupProjects(); }, [open, loadGroupProjects]);
  useEffect(() => {
    if (open && draft.when === 'event' && eventIsDevice) void loadDevices();
  }, [open, draft.when, eventIsDevice, loadDevices]);

  useEffect(() => {
    if (!open) return;
    const next = action ? draftFrom(action) : initial ? draftFrom(initial) : newDraft();
    setDraft(next);
    setOpenedDraft(next);
    setError(null);
    setRunNote(null);
    setGroupOwner(action?.owner.kind === 'group_project' ? action.owner.groupProjectId : initialGroupProjectId ?? '');
  }, [open, action, initial, initialGroupProjectId]);

  const set = (patch: Partial<ActionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const converted = useMemo(() => draftToInput(draft), [draft]);
  const suggested = converted.ok ? suggestActionName(converted.input, names) : '';
  const cron = draft.when === 'schedule' ? draftCron(draft) : '';
  const parsedCron = cron ? parseCron(cron) : null;
  const nextRuns = parsedCron?.ok ? nextCronTimes(parsedCron.spec, Date.now(), 3) : [];
  const owner: ActionOwner = action?.owner ?? (groupOwner ? { kind: 'group_project', groupProjectId: groupOwner } : { kind: 'user' });

  const save = async () => {
    const result = draftToInput(draft);
    if (!result.ok) { setError(result.error); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = action
        ? await window.clubhouse.actions.update(action.id, result.input)
        : groupOwner ? await window.clubhouse.actions.create(result.input, groupOwner) : await window.clubhouse.actions.create(result.input);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      // telemetry-exempt: shown in the form, which keeps what was typed
      setError(ipcErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!action) return;
    setRunning(true);
    setRunNote(null);
    try {
      await window.clubhouse.actions.runNow(action.id);
      setRunNote('Started a run of the saved action. Its result shows on its card.');
    } catch (err) {
      // telemetry-exempt: shown in the form
      setError(ipcErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const eventIsGit = GIT_EVENT_KINDS.includes(draft.event);
  const eventIsApp = APP_EVENT_KINDS.includes(draft.event);
  const projectEvent = draft.event === 'project.added' || draft.event === 'project.removed';
  const networkDevices = devices.filter((d) => d.role === 'member' && (!draft.deviceKind || (d.kind === 'phone' ? 'phone' : 'computer') === draft.deviceKind));
  const sourceOptions = eventIsGroup ? (
    <select id={`${uid}-source`} className={`${selectClass} w-full`} value={draft.source} onChange={(e) => set({ source: e.target.value })}>
      <option value="">Pick a group project</option>
      {groupProjects.map((p) => <option key={p.id} value={`group_project:${p.id}`}>{p.name}</option>)}
    </select>
  ) : eventIsDevice ? (
    <select id={`${uid}-source`} className={`${selectClass} w-full`} value={draft.source} onChange={(e) => set({ source: e.target.value })}>
      <option value="">Any device</option>
      {draft.source.startsWith('device:') && !networkDevices.some((d) => `device:${d.fingerprint.toLowerCase()}` === draft.source) && (
        <option value={draft.source}>Previously selected device</option>
      )}
      {networkDevices.map((d) => <option key={d.fingerprint} value={`device:${d.fingerprint.toLowerCase()}`}>{d.alias || 'Unnamed device'}</option>)}
    </select>
  ) : projectEvent ? (
    <select id={`${uid}-source`} className={`${selectClass} w-full`} value={draft.source} onChange={(e) => set({ source: e.target.value })}>
      <option value="">Any project</option>
      {projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
    </select>
  ) : eventIsApp ? null : (
    <AgentSelect id={`${uid}-source`} value={draft.source} onChange={(source) => set({ source, ...(source === 'any' && { timing: 'coalesce' }) })} agents={agents} projects={projects}
      includeProjects includeAny={ANY_AGENT_EVENT_KINDS.includes(draft.event)} placeholder="Pick an agent or project" />
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={saving || running}
      dirty={JSON.stringify(draft) !== JSON.stringify(openedDraft)}
      title={action ? 'Edit action' : 'New action'}
      width="w-[560px]"
      testId="action-form"
      footer={(dismiss) => (
        <>
          <span className={`${settingsHelp} mr-auto`}>Usage counts toward {ownerLabel(owner, names) === 'You' ? 'you' : ownerLabel(owner, names)}.</span>
          {action && <Button kind="ghost" disabled={saving || running} onClick={() => { void runNow(); }}>Run now</Button>}
          <Button kind="ghost" onClick={dismiss} disabled={saving || running}>Cancel</Button>
          <Button kind="primary" disabled={saving || running} onClick={() => { void save(); }} data-testid="action-form-save">Save</Button>
        </>
      )}
    >
      <div className="max-h-[65vh] overflow-y-auto pr-1">
        {!action && <Field label="Owner" htmlFor={`${uid}-owner`}><select id={`${uid}-owner`} className={`${selectClass} w-full`} value={groupOwner} onChange={(e) => setGroupOwner(e.target.value)}>
          <option value="">You</option>
          {groupProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></Field>}
        <Field label="Name" htmlFor={`${uid}-name`}>
          <input id={`${uid}-name`} className={`${settingsInput} w-full`} value={draft.name} placeholder={suggested || 'Suggested from the trigger and steps'}
            onChange={(e) => set({ name: e.target.value })} />
        </Field>

        <h3 className="text-[13px] font-semibold text-ctp-text mt-5">When</h3>
        <Field label="Runs" htmlFor={`${uid}-when`}>
          <select id={`${uid}-when`} className={`${selectClass} w-full`} value={draft.when} onChange={(e) => set({ when: e.target.value as ActionDraft['when'] })} data-testid="action-form-when">
            <option value="schedule">On a schedule</option>
            <option value="event">After something happens</option>
            <option value="once">Once, at a time</option>
          </select>
        </Field>

        {draft.when === 'schedule' && (
          <>
            <div className="flex gap-3">
              <div className="flex-1">
                <Field label="Repeats" htmlFor={`${uid}-preset`}>
                  <select id={`${uid}-preset`} className={`${selectClass} w-full`} value={draft.preset}
                    onChange={(e) => set({ preset: e.target.value as SchedulePreset, ...(e.target.value === 'cron' && { cron: draftCron(draft) }) })}>
                    {SCHEDULE_PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABELS[p]}</option>)}
                  </select>
                </Field>
              </div>
              {draft.preset === 'weekly' && (
                <div className="flex-1">
                  <Field label="Day" htmlFor={`${uid}-day`}>
                    <select id={`${uid}-day`} className={`${selectClass} w-full`} value={draft.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                      {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </Field>
                </div>
              )}
              {(draft.preset === 'daily' || draft.preset === 'weekdays' || draft.preset === 'weekly') && (
                <div className="flex-1">
                  <Field label="Time" htmlFor={`${uid}-time`}>
                    <input id={`${uid}-time`} type="time" className={`${settingsInput} w-full`} value={draft.time} onChange={(e) => set({ time: e.target.value })} />
                  </Field>
                </div>
              )}
              {draft.preset === 'hourly' && (
                <div className="flex-1">
                  <Field label="Minutes past the hour" htmlFor={`${uid}-minute`}>
                    <input id={`${uid}-minute`} type="number" min={0} max={59} className={`${settingsInput} w-full`} value={draft.minute}
                      onChange={(e) => set({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} />
                  </Field>
                </div>
              )}
            </div>
            {draft.preset === 'cron' && (
              <Field label="Schedule line" htmlFor={`${uid}-cron`} help="Five parts: minute, hour, day of the month, month, day of the week. Local time.">
                <input id={`${uid}-cron`} className={`${settingsInput} w-full font-mono`} value={draft.cron} onChange={(e) => set({ cron: e.target.value })} />
              </Field>
            )}
            <div className={`${settingsHelp} mt-2`} data-testid="action-form-schedule-words">
              {parsedCron?.ok ? describeCron(cron) : parsedCron?.error}
              {nextRuns.length > 0 && <div>Next runs: {nextRuns.map(formatRun).join('; ')}</div>}
            </div>
            <Field label="If Clubhouse was closed or asleep at a run time" htmlFor={`${uid}-missed`}>
              <select id={`${uid}-missed`} className={`${selectClass} w-full`} value={draft.missed} onChange={(e) => set({ missed: e.target.value as MissedRunRule })}>
                {(Object.keys(MISSED_RUN_LABELS) as MissedRunRule[]).map((m) => <option key={m} value={m}>{MISSED_RUN_LABELS[m]}</option>)}
              </select>
            </Field>
          </>
        )}

        {draft.when === 'event' && (
          <>
            <Field label="What happens" htmlFor={`${uid}-event`}>
              <select id={`${uid}-event`} className={`${selectClass} w-full`} value={draft.event} onChange={(e) => {
                const event = e.target.value as ActionEventKind;
                if (GROUP_PROJECT_EVENT_KINDS.includes(event)) {
                  set({ event, source: draft.source.startsWith('group_project:') ? draft.source : '', ...(event === 'group_project.board_idle' && { timing: 'delay' }) });
                  return;
                }
                if (DEVICE_EVENT_KINDS.includes(event)) {
                  set({ event, ...(!eventIsDevice && { source: '', deviceKind: '', timing: 'delay', delayUnit: 'seconds', delay: '120' }) });
                  return;
                }
                // App events take no agent; project events may name a project.
                const keep = APP_EVENT_KINDS.includes(event) ? (event.startsWith('project.') && draft.source.startsWith('project:') ? draft.source : '') : draft.source.startsWith('project:') || draft.source.startsWith('agent:') || (draft.source === 'any' && ANY_AGENT_EVENT_KINDS.includes(event)) ? draft.source : '';
                set({ event, source: keep, ...(event === 'agent.idle' && { timing: 'delay' }) });
              }}>
                <optgroup label="Agent">{AGENT_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
                <optgroup label="Group project">{GROUP_PROJECT_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
                <optgroup label="Git">{GIT_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
                <optgroup label="App">{APP_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
                <optgroup label="Device">{DEVICE_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
              </select>
            </Field>
            {sourceOptions && (
              <Field label={eventIsGroup ? 'Group project' : eventIsDevice ? 'Device' : eventIsGit ? 'Repository' : projectEvent ? 'Project' : 'Agent'} htmlFor={`${uid}-source`}
                help={eventIsGit ? 'An agent means its worktree. A project means its folder and every agent worktree in it.' : undefined}>
                {sourceOptions}
              </Field>
            )}
            {draft.event === 'group_project.message_posted' && <Field label="Topic (optional)" htmlFor={`${uid}-topic`}><input id={`${uid}-topic`} className={`${settingsInput} w-full`} value={draft.topic} onChange={(e) => set({ topic: e.target.value })} /></Field>}
            {eventIsDevice && (
              <Field label="Device kind" htmlFor={`${uid}-device-kind`}
                help="This computer's view only. Devices already connected fire once at launch. Local sleep, network loss and quitting do not report other devices as offline. Detection follows Annex reconnect and heartbeat timing.">
                <select id={`${uid}-device-kind`} className={`${selectClass} w-full`} value={draft.deviceKind}
                  onChange={(e) => set({ deviceKind: e.target.value as ActionDraft['deviceKind'] })}>
                  <option value="">Computers and phones</option>
                  <option value="computer">Computers</option>
                  <option value="phone">Phones</option>
                </select>
              </Field>
            )}
            {eventIsGit && (
              <Field label="Branch (optional)" htmlFor={`${uid}-branch`} help="Only for this branch, e.g. main. Changes are seen locally; nothing is fetched.">
                <input id={`${uid}-branch`} className={`${settingsInput} w-full`} value={draft.branch} onChange={(e) => set({ branch: e.target.value })} />
              </Field>
            )}
            {draft.event === 'app.returned' && (
              <Field label="Away for (minutes)" htmlFor={`${uid}-absence`}
                help="Uses app focus, screen lock, sleep and system idle time. Relaunching Clubhouse does not count as returning.">
                <input id={`${uid}-absence`} type="number" min={MIN_ABSENCE_MINUTES} step={1} placeholder={String(DEFAULT_ABSENCE_MINUTES)}
                  className={`${settingsInput} w-32`} value={draft.absenceMinutes} onChange={(e) => set({ absenceMinutes: e.target.value })} />
              </Field>
            )}
            <Field label="Timing" htmlFor={`${uid}-timing`} help={eventIsDevice
              ? 'Device waits and grouping windows are independent. Delay re-checks the current state; grouping records events. Throttle limits the whole action.'
              : 'Choose no wait, a trailing delay with a re-check, or a fixed grouping window. Throttle is checked when a run starts.'}>
              <select id={`${uid}-timing`} className={`${selectClass} w-full`} value={draft.source === 'any' ? 'coalesce' : eventIsIdle ? 'delay' : draft.timing}
                disabled={draft.source === 'any' || eventIsIdle} onChange={(e) => set({ timing: e.target.value as ActionDraft['timing'] })}>
                <option value="none">Run without waiting</option>
                <option value="delay">Wait after the latest event</option>
                <option value="coalesce">Group events from the first event</option>
              </select>
            </Field>
            {(draft.source === 'any' || draft.timing === 'coalesce') && !eventIsIdle && (
              <Field label={draft.source === 'any' ? draft.event === 'agent.quick_finished' ? 'Group finishes for (seconds)' : 'Group turns for (seconds)' : 'Group events for (seconds)'} htmlFor={`${uid}-coalesce`}
                help={draft.source === 'any'
                  ? 'Includes durable and quick agents that become readable later. A fixed window from the first event. Later events join without extending it. Excludes the subscriber and Dispatcher-owned agents. Watching activity is allowed by default for the Dispatcher and can be turned off in its Clubhouse permissions. Other agents need agent.watch. Each agent must also be readable. Ask first does not allow unattended runs. Nothing replays after relaunch.'
                  : 'A fixed window from the first event. Later events join without extending it. The run lists every readable event, with a shortened text summary. Nothing replays after relaunch.'}>
                <input id={`${uid}-coalesce`} type="number" min={MIN_COALESCE_SECONDS} max={MAX_COALESCE_SECONDS} step={1}
                  placeholder={String(DEFAULT_COALESCE_SECONDS)} className={`${settingsInput} w-32`} value={draft.coalesceSeconds}
                  onChange={(e) => set({ coalesceSeconds: e.target.value })} />
              </Field>
            )}
            {draft.source !== 'any' && (draft.timing === 'delay' || eventIsIdle) && <Field
              label={eventIsIdle ? 'Idle for' : 'Wait first'}
              htmlFor={`${uid}-delay`}
              help={eventIsIdle
                ? 'Counts from the end of its last turn. A new turn resets it, and it runs once per idle stretch.'
                : 'Each matching event restarts the wait. When it ends, the condition is checked again. If it no longer holds, the run is cancelled. Waits survive relaunch.'}
            >
              <div className="flex gap-2">
                <input id={`${uid}-delay`} type="number" min={1} max={draft.delayUnit === 'seconds' ? MAX_DELAY_MINUTES * 60 : MAX_DELAY_MINUTES} step={1}
                  className={`${settingsInput} w-32`} value={draft.delay} onChange={(e) => set({ delay: e.target.value })} />
                <select aria-label="Wait unit" className={selectClass} value={draft.delayUnit}
                  onChange={(e) => set({ delayUnit: e.target.value as ActionDraft['delayUnit'] })}>
                  <option value="minutes">Minutes</option>
                  <option value="seconds">Seconds</option>
                </select>
              </div>
            </Field>}
            <Field label="Throttle maximum runs (optional)" htmlFor={`${uid}-throttle-runs`}
              help="A sliding window over started runs, including Run now and failures. Throttled skips are recorded in history and do not consume the daily or lifetime run limit.">
              <input id={`${uid}-throttle-runs`} type="number" min={1} step={1} className={`${settingsInput} w-32`}
                value={draft.throttleMaxRuns} onChange={(e) => set({ throttleMaxRuns: e.target.value })} />
            </Field>
            <Field label="Throttle window (minutes)" htmlFor={`${uid}-throttle-window`}>
              <input id={`${uid}-throttle-window`} type="number" min={1} max={MAX_DELAY_MINUTES} step={1} className={`${settingsInput} w-32`}
                value={draft.throttlePerMinutes} onChange={(e) => set({ throttlePerMinutes: e.target.value })} />
            </Field>
            <Field label="After local time (optional)" htmlFor={`${uid}-after-time`}
              help="Only events at or after this time on this computer can run. Queued and delayed runs check again when they start. This also applies to Run now.">
              <input id={`${uid}-after-time`} type="time" className={`${settingsInput} w-40`} value={draft.afterLocalTime} onChange={(e) => set({ afterLocalTime: e.target.value })} />
            </Field>
            <Field label="Once per calendar day" htmlFor={`${uid}-once-per-day`}
              help="Moving the clock back doesn't give an extra run. Only started runs use the day, including Run now and failed runs.">
              <input id={`${uid}-once-per-day`} type="checkbox" checked={draft.oncePerDay} onChange={(e) => set({ oncePerDay: e.target.checked })} />
            </Field>
          </>
        )}

        {draft.when === 'once' && (
          <Field label="Date and time" htmlFor={`${uid}-once`} help="If Clubhouse is closed then, it runs when Clubhouse next opens. It deletes itself after it runs.">
            <input id={`${uid}-once`} type="datetime-local" className={`${settingsInput} w-full`} value={draft.onceAt} onChange={(e) => set({ onceAt: e.target.value })} />
          </Field>
        )}

        {draft.when !== 'once' && (
          <>
            <Field label="Ends at (optional)" htmlFor={`${uid}-ends`}
              help="The action turns off at this time. A run already in progress finishes normally.">
              <input id={`${uid}-ends`} type="datetime-local" className={`${settingsInput} w-full`} value={draft.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
            </Field>
            <Field label="Maximum runs (optional)" htmlFor={`${uid}-max-runs`}
              help="Every started run counts, including Run now and failed runs. Skipped runs do not count. The count survives restarts and edits.">
              <input id={`${uid}-max-runs`} type="number" min={1} step={1} className={`${settingsInput} w-32`} value={draft.maxRuns} onChange={(e) => set({ maxRuns: e.target.value })} />
            </Field>
          </>
        )}

        <h3 className="text-[13px] font-semibold text-ctp-text mt-5">Then</h3>
        <div className={`${settingsHelp} mb-1`}>Steps run in order and stop at the first one that couldn’t run.</div>
        {draft.steps.map((s, i) => (
          <StepEditor key={i} index={i} step={s} agents={agents.filter((a) => !a.quick)} projects={projects} canRemove={draft.steps.length > 1}
            onChange={(next) => set({ steps: draft.steps.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => set({ steps: draft.steps.filter((_, j) => j !== i) })} />
        ))}
        {draft.steps.length < MAX_ACTION_STEPS && (
          <Button kind="ghost" className="mt-1" onClick={() => set({ steps: [...draft.steps, emptyStep('notify')] })}>Add a step</Button>
        )}

        <Field label="If it’s still running when it’s set off again" htmlFor={`${uid}-overlap`}>
          <select id={`${uid}-overlap`} className={`${selectClass} w-full`} value={draft.overlap} onChange={(e) => set({ overlap: e.target.value as OverlapRule })}>
            {(Object.keys(OVERLAP_LABELS) as OverlapRule[]).map((o) => <option key={o} value={o}>{OVERLAP_LABELS[o]}</option>)}
          </select>
        </Field>

        {error && <div role="alert" className={`${settingsError} mt-3`}>{error}</div>}
        {runNote && <div className={`${settingsHelp} mt-3`}>{runNote}</div>}
      </div>
    </Modal>
  );
}
