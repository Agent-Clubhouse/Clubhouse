import { useState } from 'react';
import type { ManagedTemplateChange, ManagedTemplatePushTarget } from '../../../shared/managed-agents-types';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { partKindLabel } from './managedApi';
import { AgentDot } from './parts-ui';

const SETTING_NAMES: Record<string, string> = {
  orchestrator: 'CLI',
  model: 'Model',
  effort: 'Effort',
  access: 'Access',
  idleSleep: 'Auto-sleep',
  helperTemplateId: 'Helper template',
  'orchestration.orchestrate': 'Orchestration',
  'orchestration.maxHelpers': 'Helper limit',
  'orchestration.autoHelpers': 'Smart selection',
  'orchestration.access': 'Helper access',
  'orchestration.control': 'Helper control',
  'orchestration.crossProjectHelpers': 'Helpers in other projects',
  'orchestration.connectToDispatcher': 'Dispatcher connection',
};

const settingName = (key: string) => SETTING_NAMES[key] ?? key;

function valueText(v: string): string {
  if (v === 'true') return 'on';
  if (v === 'false') return 'off';
  return v;
}

/** One change as the dialog lists it: "+ Skill X", "− MCP server Y", "~ Helper limit 5 → 3". */
export function changeText(c: ManagedTemplateChange): string {
  if (c.kind === 'add') return `+ ${partKindLabel(c.part)} ${c.name}`;
  if (c.kind === 'remove') return `− ${partKindLabel(c.part)} ${c.name}`;
  if (c.kind === 'order') return '~ Instruction block order';
  // What a new model or CLI does to the effort, which is for one model.
  if (c.followsModel) return c.to === 'CLI default' ? '~ Effort goes back to the CLI default with the new model' : `~ Effort ${c.to} goes with the new model`;
  // A Clubhouse permission (#2971) carries its own name.
  return `~ ${c.label ?? settingName(c.key)} ${valueText(c.from)} → ${valueText(c.to)}`;
}

/**
 * Main words skipped changes with the setting key ("access already Auto");
 * show the setting's name instead. Only a key that leads a skipped change is
 * renamed, so a part named "access-review" keeps its name.
 */
export function noteText(note: string): string {
  return note.split(', ').map((part) => {
    const m = /^(\S+) already /.exec(part);
    return m && SETTING_NAMES[m[1]] ? `${SETTING_NAMES[m[1]]}${part.slice(m[1].length)}` : part;
  }).join(', ');
}

const targetKey = (t: Pick<ManagedTemplatePushTarget, 'projectPath' | 'agentId'>) => `${t.projectPath}\u0000${t.agentId}`;

/**
 * Saving a template that agents were made from (#2898): what changed, and
 * which of those agents get it. Nothing reaches an agent without its tick.
 */
export function TemplatePushDialog({ templateName, changes, targets, busy, error, onCancel, onSaveOnly, onSaveAndApply }: {
  templateName: string;
  changes: ManagedTemplateChange[];
  targets: ManagedTemplatePushTarget[];
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSaveOnly: () => void;
  onSaveAndApply: (targets: ManagedTemplatePushTarget[]) => void;
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(targets.filter((t) => t.applicable > 0).map(targetKey)));
  const chosen = targets.filter((t) => ticked.has(targetKey(t)));
  const toggle = (t: ManagedTemplatePushTarget) => setTicked((s) => {
    const n = new Set(s);
    const k = targetKey(t);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Save ${templateName}?`}
      width="w-[560px]"
      testId="managed-template-push-dialog"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={onSaveOnly} disabled={busy} data-testid="managed-template-save-only">Save template only</Button>
        <Button kind="primary" onClick={() => onSaveAndApply(chosen)} disabled={busy || chosen.length === 0} data-testid="managed-template-save-apply">
          Save and apply to {chosen.length}
        </Button>
      </>}
    >
      <div className="flex flex-col gap-4 text-[13px]">
        <section>
          <h3 className="text-xs font-medium text-ctp-subtext1 mb-1">Changes</h3>
          <ul data-testid="managed-template-changes" className="flex flex-col gap-0.5 font-mono text-xs text-ctp-text">
            {changes.map((c, i) => <li key={i}>{changeText(c)}</li>)}
          </ul>
          <p className="mt-1.5 text-xs text-ctp-overlay1">Edits to block text aren't listed. They already reach every agent that uses the block.</p>
        </section>
        <section>
          <h3 className="text-xs font-medium text-ctp-subtext1 mb-1">Agents made from {templateName}</h3>
          <ul data-testid="managed-template-targets" className="flex flex-col">
            {targets.map((t) => {
              const k = targetKey(t);
              const none = t.applicable === 0;
              const detail = [`${t.applicable} of ${t.total} change${t.total === 1 ? '' : 's'} apply`, t.note ? noteText(t.note) : null, t.running && !none ? 'applies on restart' : null]
                .filter(Boolean).join(' · ');
              return (
                <li key={k} className="grid grid-cols-[auto_18px_minmax(0,1fr)] gap-x-2.5 items-center py-2 border-t border-surface-0">
                  <input
                    type="checkbox"
                    checked={ticked.has(k)}
                    disabled={busy || none}
                    onChange={() => toggle(t)}
                    aria-label={`Apply to ${t.agentName}`}
                  />
                  <AgentDot name={t.agentName} color={t.color} />
                  <span className="min-w-0">
                    <span className="block text-ctp-text truncate">{t.agentName}</span>
                    <span className="block text-xs text-ctp-overlay1 truncate">{detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-xs text-ctp-overlay1">Save template only leaves these agents as they are. Agents made from it later get the new version.</p>
        </section>
        {error && <p role="alert" className="text-xs text-ctp-error">{error}</p>}
      </div>
    </Modal>
  );
}
