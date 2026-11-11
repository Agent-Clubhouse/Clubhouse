/**
 * New / edit action (#2953): trigger first, then steps, then the overlap rule.
 * Run now fires the saved action as a normal run. The footer says who usage
 * counts toward.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  AGENT_EVENT_KINDS,
  APP_EVENT_KINDS,
  EVENT_LABELS,
  GIT_EVENT_KINDS,
  MAX_ACTION_STEPS,
  MIN_ABSENCE_MINUTES,
  DEFAULT_ABSENCE_MINUTES,
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
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
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
};
const STEP_ORDER: ActionStepKind[] = ['wake', 'message', 'quick', 'sleep', 'notify'];
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

function AgentSelect({ id, value, onChange, agents, projects, includeProjects, placeholder }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  agents: AgentOption[];
  projects: ProjectOption[];
  /** Offer "Any agent in <project>" (values 'project:<id>'), with agents as 'agent:<id>'. */
  includeProjects?: boolean;
  placeholder: string;
}) {
  const byProject = projects.map((p) => ({ project: p, agents: agents.filter((a) => a.projectId === p.id) }))
    .filter((g) => g.agents.length > 0 || includeProjects);
  const other = agents.filter((a) => !projects.some((p) => p.id === a.projectId));
  const v = (a: AgentOption) => (includeProjects ? `agent:${a.id}` : a.id);
  return (
    <select id={id} className={`${selectClass} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
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
      {(step.kind === 'wake' || step.kind === 'message' || step.kind === 'sleep') && (
        <Field label="Agent" htmlFor={`${uid}-agent`}>
          <AgentSelect id={`${uid}-agent`} value={step.agentId} onChange={(agentId) => set({ agentId })} agents={agents} projects={projects} placeholder="Pick an agent" />
        </Field>
      )}
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
              {orchestrators.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          </Field>
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
            : step.kind === 'message' ? 'If it’s busy, the message waits for its next turn. If it’s asleep, it’s woken with it.'
              : step.kind === 'notify' ? 'Shown as a Clubhouse notification, following Settings > Notifications & alerts.' : undefined}
        >
          <textarea id={`${uid}-text`} rows={3} className={settingsTextArea} value={step.text} onChange={(e) => set({ text: e.target.value })} />
        </Field>
      )}
    </div>
  );
}

export function ActionForm({ open, action, initial, onClose, onSaved }: {
  open: boolean;
  /** Editing this action; otherwise a new one. */
  action?: ActionView;
  /** A pre-filled new action (a starter pattern, or "New action for <agent>"). */
  initial?: Partial<ActionInput>;
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

  useEffect(() => {
    if (!open) return;
    const next = action ? draftFrom(action) : initial ? draftFrom(initial) : newDraft();
    setDraft(next);
    setOpenedDraft(next);
    setError(null);
    setRunNote(null);
  }, [open, action, initial]);

  const set = (patch: Partial<ActionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const converted = useMemo(() => draftToInput(draft), [draft]);
  const suggested = converted.ok ? suggestActionName(converted.input, names) : '';
  const cron = draft.when === 'schedule' ? draftCron(draft) : '';
  const parsedCron = cron ? parseCron(cron) : null;
  const nextRuns = parsedCron?.ok ? nextCronTimes(parsedCron.spec, Date.now(), 3) : [];
  const owner: ActionOwner = action?.owner ?? { kind: 'user' };

  const save = async () => {
    const result = draftToInput(draft);
    if (!result.ok) { setError(result.error); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = action
        ? await window.clubhouse.actions.update(action.id, result.input)
        : await window.clubhouse.actions.create(result.input);
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
  const sourceOptions = projectEvent ? (
    <select id={`${uid}-source`} className={`${selectClass} w-full`} value={draft.source} onChange={(e) => set({ source: e.target.value })}>
      <option value="">Any project</option>
      {projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
    </select>
  ) : eventIsApp ? null : (
    <AgentSelect id={`${uid}-source`} value={draft.source} onChange={(source) => set({ source })} agents={agents} projects={projects} includeProjects placeholder="Pick an agent or project" />
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
                // App events take no agent; project events may name a project.
                const keep = APP_EVENT_KINDS.includes(event) ? (event.startsWith('project.') && draft.source.startsWith('project:') ? draft.source : '') : draft.source.startsWith('project:') || draft.source.startsWith('agent:') ? draft.source : '';
                set({ event, source: keep });
              }}>
                <optgroup label="Agent">{AGENT_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
                <optgroup label="Git">{GIT_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
                <optgroup label="App">{APP_EVENT_KINDS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</optgroup>
              </select>
            </Field>
            {sourceOptions && (
              <Field label={eventIsGit ? 'Repository' : projectEvent ? 'Project' : 'Agent'} htmlFor={`${uid}-source`}
                help={eventIsGit ? 'An agent means its worktree. A project means its folder and every agent worktree in it.' : undefined}>
                {sourceOptions}
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
            <Field
              label={draft.event === 'agent.idle' ? 'Idle for (minutes)' : 'Wait first (minutes, optional)'}
              htmlFor={`${uid}-delay`}
              help={draft.event === 'agent.idle'
                ? 'Counts from the end of its last turn. A new turn resets it, and it runs once per idle stretch.'
                : 'When the wait ends, Clubhouse checks that what happened still holds, for example that the agent is still asleep. If not, this run is cancelled, and the wait starts again the next time it happens.'}
            >
              <input id={`${uid}-delay`} type="number" min={0} className={`${settingsInput} w-32`} value={draft.delay} onChange={(e) => set({ delay: e.target.value })} />
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
          <StepEditor key={i} index={i} step={s} agents={agents} projects={projects} canRemove={draft.steps.length > 1}
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
