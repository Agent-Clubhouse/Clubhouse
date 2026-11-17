import { Toggle } from '../../../components/Toggle';
import React, { useState, useCallback, useEffect, useId } from 'react';
import type { TopicDigest } from '../../../../shared/group-project-types';
import { useAnnexStore } from '../../../stores/annexStore';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { Tooltip } from '../../../components/Tooltip';
import type { GroupProjectContextValue, GroupProjectMember } from '../../../plugins/builtin/group-project/useGroupProjectContext';

/**
 * The pieces of a group project's board that the canvas card and the group
 * workspace share. Nothing here knows where it is mounted.
 */

export const ALL_TOPICS_KEY = '__all__';
export const POLL_INTERVAL_MS = 5000;

/**
 * Members whose polling stopped because they lost Clubhouse tools, once they have them again.
 * Nothing restarts a loop by itself, since main can't tell it from one someone has
 * since ended, so each gets a Resume. Main decides who is offered it, and checks
 * again on the click. Local group projects only.
 */
export function PausedPolling({ groupProjectId }: { groupProjectId: string }) {
  const [paused, setPaused] = useState<Array<{ agentId: string; agentName: string }>>([]);
  const [failed, setFailed] = useState<string | null>(null);

  const resume = (agentId: string) => {
    setFailed(null);
    void window.clubhouse.groupProject.resumePolling(groupProjectId, agentId).catch(() => {
      // telemetry-exempt: main logs the read that failed; shown here, and the offer stays to try again.
      setFailed(agentId);
    }).finally(load);
  };

  const load = useCallback(() => {
    window.clubhouse.groupProject.getPausedPolling(groupProjectId).then(setPaused).catch(() => {
      // telemetry-exempt: no offer shows, and the next change reads again.
      setPaused([]);
    });
  }, [groupProjectId]);

  useEffect(() => {
    load();
    return window.clubhouse.groupProject.onPausedPollingChanged(load);
  }, [load]);

  if (paused.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 border-b border-surface-0 text-xs text-ctp-subtext0 flex-shrink-0" data-testid="polling-paused">
      {paused.map((member) => (
        <div key={member.agentId} className="flex items-center gap-2">
          <span className="flex-1 min-w-0 truncate">{member.agentName}: polling paused</span>
          <Button
            kind="ghost"
            onClick={() => resume(member.agentId)}
            data-testid={`polling-resume-${member.agentId}`}
          >
            Resume
          </Button>
          {failed === member.agentId && <span role="alert" className="text-ctp-error" data-testid="polling-resume-error">Couldn’t resume. Try again.</span>}
        </div>
      ))}
    </div>
  );
}

/* ---------- Unread / read-state helpers ---------- */

/**
 * The digest entry for the channel the user has open, or null.
 *
 * The "All" pane deliberately marks nothing read: it is the default selection,
 * so treating it as a read of every channel would clear every badge the moment
 * the widget renders and make unread counts useless.
 */
export function openChannel(topics: TopicDigest[], selectedTopic: string): TopicDigest | null {
  if (selectedTopic === ALL_TOPICS_KEY) return null;
  return topics.find((t) => t.topic === selectedTopic) ?? null;
}

/** Zero the unread badge for a channel, so it clears without a poll round-trip. */
export function clearUnread(topics: TopicDigest[], channel: TopicDigest | null): TopicDigest[] {
  if (!channel) return topics;
  return topics.map((t) => (t.topic === channel.topic ? { ...t, newMessageCount: 0 } : t));
}

export function ProjectScopeLine({ ctx }: { ctx: GroupProjectContextValue }) {
  const fingerprint = useAnnexStore((s) => s.status.fingerprint);
  const loadStatus = useAnnexStore((s) => s.loadStatus);
  const scope = ctx.project?.scope;
  useEffect(() => { if (scope?.reach === 'network' && !fingerprint) void loadStatus(); }, [scope?.reach, fingerprint, loadStatus]);
  if (!scope) return null;
  const label = `${scope.level === 'app' ? 'App' : 'Project'} / ${scope.reach === 'network' ? 'Network' : 'Local'}`;
  const machine = ctx.project?.host?.machine;
  const resolvedName = (ctx.project as (typeof ctx.project & { hostName?: string }))?.hostName;
  const hostName = !machine ? 'This computer' : !fingerprint ? 'Unknown'
    : machine.toLowerCase() === fingerprint.toLowerCase() ? 'This computer' : resolvedName || machine;
  return <div className="px-3 text-xs text-ctp-overlay1" data-testid="group-project-scope">{label}{scope.reach === 'network' && ` · Host: ${hostName}`}</div>;
}

/* ---------- Shared pieces ---------- */

/**
 * A 28px icon button with a tooltip and an accessible name. A toggle passes
 * `pressed` and keeps one fixed `label`; the pressed state says whether it's on.
 */
export function IconButton({ label, tooltip, onClick, pressed, testId, children }: {
  label: string;
  /** Tooltip text when it should say more than the label. */
  tooltip?: string;
  onClick: (e: React.MouseEvent) => void;
  pressed?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={tooltip ?? label}>
      <Button
        kind="quiet"
        icon={children}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        data-testid={testId}
        className={pressed ? 'bg-surface-0 text-ctp-text' : ''}
      />
    </Tooltip>
  );
}

/** A label above a field, in sentence case. */
export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-xs text-ctp-overlay1 mb-1">{children}</label>;
}

export const FIELD = 'w-full px-2 text-xs bg-ctp-base border border-surface-1 rounded-md text-ctp-text placeholder:text-ctp-overlay1 focus-ring';

/* ---------- Broadcast dialog ---------- */

export function BroadcastModal({
  open,
  members,
  projectInstructions,
  onClose,
  injectMessage,
}: {
  open: boolean;
  members: GroupProjectMember[];
  projectInstructions: string;
  onClose: () => void;
  injectMessage: (agentId: string, message: string) => Promise<void>;
}) {
  const [target, setTarget] = useState<string>('all');
  const [message, setMessage] = useState('');
  const [includeInstructions, setIncludeInstructions] = useState(false);
  const [sending, setSending] = useState(false);
  const targetId = useId();
  const messageId = useId();
  const instructionsLabelId = useId();
  const hasInstructions = !!projectInstructions.trim();

  // Start fresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setTarget('all');
    setMessage('');
    setIncludeInstructions(false);
  }, [open]);

  const handleSend = useCallback(async () => {
    const msg = message.trim();
    if (!msg && !includeInstructions) return;
    if (sending) return;
    setSending(true);

    try {
      const parts: string[] = [];
      if (includeInstructions && hasInstructions) {
        parts.push(`Project Instructions:\n${projectInstructions.trim()}`);
      }
      if (msg) parts.push(msg);
      const fullMessage = parts.join('\n\n');

      const targets = target === 'all'
        ? members
        : members.filter((m) => m.agentId === target);

      await Promise.all(targets.map((member) => injectMessage(member.agentId, fullMessage)));

      onClose();
    } catch (err) {
      console.error('Broadcast message failed:', err);
    } finally {
      setSending(false);
    }
  }, [message, includeInstructions, hasInstructions, projectInstructions, sending, target, members, onClose, injectMessage]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Broadcast message"
      testId="group-project-broadcast"
      footer={(
        <>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={() => void handleSend()} disabled={(!message.trim() && !includeInstructions) || sending}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <div>
          <FieldLabel htmlFor={targetId}>Send to</FieldLabel>
          <select id={targetId} value={target} onChange={(e) => setTarget(e.target.value)} className={`${FIELD} h-7`}>
            <option value="all">Every agent</option>
            {members.map((m) => (
              <option key={m.agentId} value={m.agentId}>{m.agentName || m.agentId}</option>
            ))}
          </select>
        </div>
        <div className="h-7 flex items-center justify-between gap-2">
          <span id={instructionsLabelId} className={`text-xs ${hasInstructions ? 'text-ctp-subtext1' : 'text-ctp-overlay1'}`}>
            Include project instructions
          </span>
          <Toggle
            checked={includeInstructions}
            onChange={() => setIncludeInstructions((v) => !v)}
            disabled={!hasInstructions}
            aria-labelledby={instructionsLabelId}
          />
        </div>
        <div>
          <FieldLabel htmlFor={messageId}>Message</FieldLabel>
          <textarea
            id={messageId}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What should they do?"
            rows={4}
            className={`${FIELD} py-1.5 resize-none`}
            autoFocus
          />
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Retention Settings ---------- */

export function RetentionSettings({ groupProjectId, disabledReason = null }: { groupProjectId: string; disabledReason?: string | null }) {
  const [maxPerTopic, setMaxPerTopic] = useState(100);
  const [maxTotal, setMaxTotal] = useState(500);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [trimEstimate, setTrimEstimate] = useState<number | null>(null);
  const [confirmTrim, setConfirmTrim] = useState(false);

  useEffect(() => {
    window.clubhouse.groupProject.getRetentionConfig(groupProjectId).then((config) => {
      setMaxPerTopic(config.maxPerTopic);
      setMaxTotal(config.maxTotal);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [groupProjectId]);

  // Estimate trim impact when values change
  useEffect(() => {
    if (!loaded) return;
    window.clubhouse.groupProject.estimateTrim(groupProjectId, maxPerTopic, maxTotal)
      .then(({ wouldRemove }) => setTrimEstimate(wouldRemove))
      .catch(() => setTrimEstimate(null));
  }, [loaded, groupProjectId, maxPerTopic, maxTotal]);

  const handleSave = useCallback(async () => {
    // If trim estimate shows messages will be removed, require confirmation
    if (trimEstimate && trimEstimate > 0 && !confirmTrim) {
      setConfirmTrim(true);
      return;
    }
    setSaving(true);
    try {
      await window.clubhouse.groupProject.saveRetentionConfig(groupProjectId, maxPerTopic, maxTotal);
      setConfirmTrim(false);
    } finally {
      setSaving(false);
    }
  }, [groupProjectId, maxPerTopic, maxTotal, trimEstimate, confirmTrim]);

  if (!loaded) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-surface-0 flex-wrap" data-testid="group-project-retention">
      <span className="text-xs text-ctp-overlay1">Keep</span>
      <label className="flex items-center gap-1.5 text-xs text-ctp-subtext1">
        <input
          type="number"
          min={1}
          value={maxPerTopic}
          disabled={!!disabledReason}
          onChange={(e) => { setMaxPerTopic(Math.max(1, parseInt(e.target.value) || 1)); setConfirmTrim(false); }}
          className={`${FIELD} h-7 w-20`}
        />
        per topic
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ctp-subtext1">
        <input
          type="number"
          min={1}
          value={maxTotal}
          disabled={!!disabledReason}
          onChange={(e) => { setMaxTotal(Math.max(1, parseInt(e.target.value) || 1)); setConfirmTrim(false); }}
          className={`${FIELD} h-7 w-20`}
        />
        in total
      </label>
      <span className="text-xs text-ctp-overlay1">Protected topics do not count toward these limits.</span>
      {trimEstimate != null && trimEstimate > 0 && (
        <span className="text-xs text-ctp-error">
          {trimEstimate} {trimEstimate === 1 ? 'message' : 'messages'} will be removed
        </span>
      )}
      {disabledReason && <span className="text-xs text-ctp-overlay1">{disabledReason}</span>}
      <span className="flex-1" />
      <Button kind={confirmTrim ? 'danger-solid' : 'primary'} onClick={() => void handleSave()} disabled={saving || !!disabledReason}>
        {saving ? (confirmTrim ? 'Trimming…' : 'Saving…') : confirmTrim ? 'Remove and save' : 'Save'}
      </Button>
    </div>
  );
}

/* ---------- Icons ---------- */

export function MegaphoneIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l18-5v12L3 13v-2z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

export function NudgeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <line x1="12" y1="2" x2="12" y2="4" />
    </svg>
  );
}

export function OpenIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function ShieldIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export function StarIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function GearIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/* ---------- Helpers ---------- */

export function senderShort(sender: string): string {
  const atIdx = sender.indexOf('@');
  return atIdx >= 0 ? sender.slice(0, atIdx) : sender;
}

export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
