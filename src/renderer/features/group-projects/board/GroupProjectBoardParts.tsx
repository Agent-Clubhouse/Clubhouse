import React, { useState, useCallback, useEffect } from 'react';
import type { TopicDigest } from '../../../../shared/group-project-types';
import { useAnnexStore } from '../../../stores/annexStore';
import { Button } from '../../../components/Button';
import { Tooltip } from '../../../components/Tooltip';
import type { GroupProjectContextValue } from '../../../plugins/builtin/group-project/useGroupProjectContext';

/**
 * The pieces of a group project's board that the canvas card and the group
 * workspace share. Nothing here knows where it is mounted.
 */

export const ALL_TOPICS_KEY = '__all__';
export const POLL_INTERVAL_MS = 5000;

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
  return <div className="px-3 text-xs text-ctp-overlay1" data-testid="group-project-scope">{label}{scope.reach === 'network' && ` · Computer: ${hostName}`}</div>;
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
