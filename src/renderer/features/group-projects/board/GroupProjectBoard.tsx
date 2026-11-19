import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { GroupProjectPanelSidebar, useGroupProjectPanelLayout } from '../../../plugins/builtin/group-project/GroupProjectPanelSidebar';
import type { GroupProjectContextValue } from '../../../plugins/builtin/group-project/useGroupProjectContext';
import { useWheelContainment } from '../../../hooks/useWheelContainment';
import type { TopicDigest, BulletinMessage } from '../../../../shared/group-project-types';
import { useBulletinReadStore } from '../../../stores/bulletinReadStore';
import { renderMarkdownSafe } from '../../../utils/safe-markdown';
import { postNotificationLabel } from '../../../../shared/group-project-notifications';
import { showConfirmDialog } from '../../../plugins/PluginDialog';
import { Button } from '../../../components/Button';
import { GroupOperationStatus } from '../GroupOperationStatus';
import { Tooltip } from '../../../components/Tooltip';
import { hostLine } from '../../settings/GroupProjectScopeFields';
import {
  ALL_TOPICS_KEY, POLL_INTERVAL_MS, FIELD, GearIcon, IconButton,
  ProjectScopeLine, RetentionSettings, ShieldIcon, TrashIcon, clearUnread, formatTime, openChannel, senderShort,
} from './GroupProjectBoardParts';

/**
 * A group project's board: topics with unread counts, the messages and the open
 * message, posting, deleting messages and topics,
 * clear-all, topic protection, retention with its trim review, and legacy
 * polling. The canvas card and the group workspace both render this one
 * component; neither needs the other, and the board needs no canvas.
 */
export interface GroupProjectBoardProps {
  groupProjectId: string;
  ctx: GroupProjectContextValue;
  /**
   * `card` is the canvas's expanded card: it shows the group project's name, which can be
   * renamed in place. `workspace` leaves the name to the workspace's own header and Details.
   */
  variant: 'card' | 'workspace';
  /** The canvas card keeps its saved reference in step with the name. */
  onUpdateMetadata?: (updates: Record<string, unknown>) => void;
  /** Extra controls at the end of the header, such as the canvas card's Open. */
  headerActions?: React.ReactNode;
  /** Shown between the post box and the panes: the canvas card's description, instructions and defaults. */
  settingsBand?: React.ReactNode;
}

export function GroupProjectBoard({ groupProjectId, ctx, variant, onUpdateMetadata, headerActions, settingsBand }: GroupProjectBoardProps) {
  const { project, members, loaded, loadProjects, update, fetchDigest, fetchTopicMessages, fetchAllMessages, postBulletinMessage, deleteMessage, deleteTopic, setTopicProtection, clearAllMessages } = ctx;

  const {
    topicsWidth,
    topicsCollapsed,
    messagesWidth,
    messagesCollapsed,
    resizeTopics,
    toggleTopicsCollapse,
    resizeMessages,
    toggleMessagesCollapse,
  } = useGroupProjectPanelLayout();

  const [selectedTopic, setSelectedTopic] = useState<string>(ALL_TOPICS_KEY);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [topics, setTopics] = useState<TopicDigest[]>([]);
  const [messages, setMessages] = useState<BulletinMessage[]>([]);
  const [showRetentionSettings, setShowRetentionSettings] = useState(false);
  const [bulletinTopic, setBulletinTopic] = useState('');
  const [bulletinBody, setBulletinBody] = useState('');
  const [postingBulletin, setPostingBulletin] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [readError, setReadError] = useState(false);

  // Read state is pulled at call time rather than subscribed to, so marking a
  // channel read doesn't tear down and restart the polling interval.
  const getLastRead = useBulletinReadStore((s) => s.getLastRead);
  const markTopicRead = useBulletinReadStore((s) => s.markTopicRead);

  useEffect(() => {
    if (!loaded) loadProjects();
  }, [loaded, loadProjects]);

  const displayName = project?.name || 'Group Project';

  // On a copy of a network group project, the host decides these (#3363).
  const copy = !ctx.isRemote && project?.network?.role === 'replica';
  const hostName = project?.hostName ?? 'the host';
  const hostOnlyReason = copy ? `Only ${hostName} can do this. This computer holds a copy.` : null;
  const readOnly = copy && project?.network?.state === 'host-removed';

  // Poll for digest + messages
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      try {
        const digest = await fetchDigest(groupProjectId, getLastRead(groupProjectId));
        if (!cancelled) {
          // The channel the user has open counts as read, including messages
          // that arrive while they are sitting on it.
          const open = openChannel(digest, selectedTopic);
          setTopics(clearUnread(digest, open));
          if (open) markTopicRead(groupProjectId, open.topic, open.latestTimestamp);
        }
      } catch { /* telemetry-exempt: the next poll reads again */ }

      // Message fetches stay unfiltered: `since` drives unread counts only,
      // the panes still show the full history of the selected channel.
      if (selectedTopic === ALL_TOPICS_KEY) {
        try {
          const allMsgs = await fetchAllMessages(groupProjectId);
          if (!cancelled) { setMessages(allMsgs); setReadError(false); }
        } catch {
          // telemetry-exempt: the read error is shown below; the next poll reads again
          if (!cancelled) setReadError(true);
        }
      } else if (selectedTopic) {
        try {
          const msgs = await fetchTopicMessages(groupProjectId, selectedTopic);
          if (!cancelled) { setMessages(msgs); setReadError(false); }
        } catch {
          // telemetry-exempt: the read error is shown below; the next poll reads again
          if (!cancelled) setReadError(true);
        }
      }
    };

    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [groupProjectId, selectedTopic, fetchDigest, fetchAllMessages, fetchTopicMessages, getLastRead, markTopicRead]);

  // Sort messages newest-first by the numeric timestamp embedded in the message ID
  // (msg_<epoch_ms>_<random>) to match the backend's numeric sort order and avoid
  // localeCompare producing wrong results for same-millisecond messages.
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => {
      const tsA = parseInt(a.id.split('_')[1] || '0', 10);
      const tsB = parseInt(b.id.split('_')[1] || '0', 10);
      return tsB - tsA;
    }),
    [messages],
  );

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedMessageId) ?? null,
    [messages, selectedMessageId],
  );

  const handleTopicClick = useCallback((topic: string) => {
    setSelectedTopic(topic);
    setSelectedMessageId(null);
    setMessages([]);
    // Clear the badge immediately rather than waiting for the next poll.
    const open = openChannel(topics, topic);
    if (open) {
      markTopicRead(groupProjectId, open.topic, open.latestTimestamp);
      setTopics((prev) => clearUnread(prev, open));
    }
  }, [topics, groupProjectId, markTopicRead]);

  const handleWheelContainment = useWheelContainment();

  const handleDeleteMessage = useCallback(async (topic: string, messageId: string) => {
    const { promise } = showConfirmDialog('Delete this message?');
    if (!(await promise)) return;
    await deleteMessage(groupProjectId, topic, messageId);
    // On a copy the change waits for its host, so the message stays until the host's board says otherwise.
    if (copy) return;
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    if (selectedMessageId === messageId) setSelectedMessageId(null);
  }, [groupProjectId, deleteMessage, selectedMessageId, copy]);

  const handleDeleteTopic = useCallback(async (topic: string) => {
    const { promise } = showConfirmDialog(`Delete the "${topic}" topic and its messages?`);
    if (!(await promise)) return;
    await deleteTopic(groupProjectId, topic);
    if (copy) return;
    setTopics((prev) => prev.filter((t) => t.topic !== topic));
    if (selectedTopic === topic) {
      setSelectedTopic(ALL_TOPICS_KEY);
      setSelectedMessageId(null);
      setMessages([]);
    }
  }, [groupProjectId, deleteTopic, selectedTopic, copy]);

  const handleToggleProtection = useCallback(async (topic: string, currentlyProtected: boolean) => {
    await setTopicProtection(groupProjectId, topic, !currentlyProtected);
    if (copy) return;
    setTopics((prev) => prev.map((t) => t.topic === topic ? { ...t, isProtected: !currentlyProtected } : t));
  }, [groupProjectId, setTopicProtection, copy]);

  const handleClearAll = useCallback(async () => {
    const { promise } = showConfirmDialog('Clear every message? The description, instructions and wires stay.');
    if (!(await promise)) return;
    await clearAllMessages(groupProjectId);
    setTopics([]);
    setMessages([]);
    setSelectedTopic(ALL_TOPICS_KEY);
    setSelectedMessageId(null);
  }, [groupProjectId, clearAllMessages]);

  const handlePostBulletin = useCallback(async () => {
    const topic = bulletinTopic.trim();
    const body = bulletinBody.trim();
    if (!topic || !body || postingBulletin) return;
    setPostingBulletin(true);
    setPostError(null);
    try {
      await postBulletinMessage(groupProjectId, topic, body);
      setBulletinTopic('');
      setBulletinBody('');
    } catch (err) {
      // telemetry-exempt: shown beside the post box, and what was typed stays.
      setPostError(`Not posted. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPostingBulletin(false);
    }
  }, [bulletinTopic, bulletinBody, postingBulletin, postBulletinMessage, groupProjectId]);

  const totalMessages = topics.reduce((sum, t) => sum + t.messageCount, 0);

  return (
    <div className="flex flex-col h-full text-ctp-text">
      <BoardHeader
        variant={variant}
        displayName={displayName}
        groupProjectId={groupProjectId}
        update={update}
        onUpdateMetadata={onUpdateMetadata}
        notificationLabel={project ? postNotificationLabel(project) : 'Loading post notifications...'}
        onToggleRetention={() => setShowRetentionSettings((v) => !v)}
        showRetentionSettings={showRetentionSettings}
        onClearAll={() => void handleClearAll()}
        clearAllDisabledReason={hostOnlyReason}
        actions={headerActions}
      />

      {project && copy && (
        <div className="px-3 py-1.5 border-b border-surface-0 text-xs text-ctp-overlay1" data-testid="group-project-copy-note">
          <p>{hostLine(project)}</p>
          <p>
            {readOnly
              ? 'Saved messages stay readable. Posting is unavailable.'
              : `You are viewing a copy on this computer. Only ${hostName} can clear all messages or change retention.`}
          </p>
          <GroupOperationStatus groupProjectId={groupProjectId} sections={['cleanup']} label="Cleanup changes" />
        </div>
      )}

      {showRetentionSettings && <RetentionSettings groupProjectId={groupProjectId} disabledReason={hostOnlyReason} />}

      {/* Post to the board */}
      <div className="flex items-start gap-2 px-3 py-2 border-b border-surface-0">
        <input
          value={bulletinTopic}
          onChange={(e) => setBulletinTopic(e.target.value)}
          placeholder="Topic"
          aria-label="Bulletin topic"
          className={`${FIELD} h-7 w-28 flex-shrink-0`}
        />
        <textarea
          value={bulletinBody}
          onChange={(e) => setBulletinBody(e.target.value)}
          placeholder="Post a message to the board"
          aria-label="Bulletin message"
          rows={2}
          className={`${FIELD} py-1.5 flex-1 resize-none`}
        />
        <Button
          kind="primary"
          onClick={() => void handlePostBulletin()}
          disabled={!bulletinTopic.trim() || !bulletinBody.trim() || postingBulletin || readOnly}
        >
          {postingBulletin ? 'Posting…' : 'Post'}
        </Button>
      </div>
      {postError && <div role="alert" className="px-3 py-1 text-xs text-ctp-error border-b border-surface-0">{postError}</div>}
      {readError && <div role="alert" className="px-3 py-1 text-xs text-ctp-error">
        {messages.length > 0 ? "Couldn't load new messages. Showing what was last loaded." : "Couldn't load messages."}
      </div>}
      {project?.network?.role === 'replica' && project.network.state === 'cached' && (
        <div className="px-3 py-1 text-xs text-ctp-overlay1 border-b border-surface-0">
          {hostName} is offline. A post waits for it and is not on the board until it returns.
        </div>
      )}

      {settingsBand}

      {/* Topics, messages and the open message */}
      <div className="flex flex-1 min-h-0">
        <GroupProjectPanelSidebar
          width={topicsWidth}
          collapsed={topicsCollapsed}
          onResize={resizeTopics}
          onToggleCollapse={toggleTopicsCollapse}
        >
          <div className="h-[30px] flex items-center px-3 text-xs text-ctp-overlay1 sticky top-0 z-10 bg-ctp-mantle">Topics</div>
          <ul className="px-1.5 pb-1.5">
            <li>
              <button
                onClick={() => handleTopicClick(ALL_TOPICS_KEY)}
                aria-current={selectedTopic === ALL_TOPICS_KEY || undefined}
                className={`w-full h-[30px] flex items-center gap-2 px-1.5 rounded-md text-left hover:bg-surface-0 ${selectedTopic === ALL_TOPICS_KEY ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1'}`}
              >
                <span className="text-[13px] flex-1 truncate">All</span>
                <span className="text-xs text-ctp-overlay1">{totalMessages}</span>
              </button>
            </li>
            {topics.map((t) => (
              <TopicRow
                key={t.topic}
                topic={t}
                selected={selectedTopic === t.topic}
                onSelect={() => handleTopicClick(t.topic)}
                onToggleProtection={() => void handleToggleProtection(t.topic, !!t.isProtected)}
                onDelete={() => void handleDeleteTopic(t.topic)}
              />
            ))}
          </ul>
          {topics.length === 0 && <div className="px-3 py-1.5 text-xs text-ctp-overlay1">No topics yet</div>}
        </GroupProjectPanelSidebar>

        <GroupProjectPanelSidebar
          width={messagesWidth}
          collapsed={messagesCollapsed}
          onResize={resizeMessages}
          onToggleCollapse={toggleMessagesCollapse}
        >
          {sortedMessages.length === 0 ? (
            <div className="px-3 py-2 text-xs text-ctp-overlay1">
              {selectedTopic === ALL_TOPICS_KEY ? 'No messages yet' : `No messages in ${selectedTopic}`}
            </div>
          ) : (
            <ul className="p-1.5">
              {sortedMessages.map((m) => (
                <li
                  key={m.id}
                  className={`group/msg relative rounded-md hover:bg-surface-0 ${selectedMessageId === m.id ? 'bg-surface-0' : ''}`}
                >
                  <button
                    onClick={() => setSelectedMessageId(m.id)}
                    aria-current={selectedMessageId === m.id || undefined}
                    className="w-full text-left px-1.5 py-1.5"
                  >
                    <div className="flex items-center gap-2 pr-7">
                      <span className="text-xs font-medium text-ctp-text truncate">{senderShort(m.sender)}</span>
                      <span className="ml-auto text-xs text-ctp-overlay1 flex-shrink-0">
                        {m.pending ? `Waiting for ${m.pending.waitingFor}` : formatTime(m.timestamp)}
                      </span>
                    </div>
                    <div
                      className="text-xs text-ctp-overlay1 truncate mt-0.5 prose prose-xs prose-invert max-w-none [&>*]:inline [&>*]:m-0"
                      dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(m.body.slice(0, 80)) }}
                    />
                  </button>
                  {!m.pending && (
                    <span className="absolute top-0.5 right-0.5 hidden group-hover/msg:block group-focus-within/msg:block">
                      <IconButton label="Delete message" onClick={(e) => { e.stopPropagation(); void handleDeleteMessage(m.topic, m.id); }}>
                        <TrashIcon />
                      </IconButton>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </GroupProjectPanelSidebar>

        <div
          className="flex-1 min-w-0 overflow-y-auto px-3 py-2"
          onWheel={handleWheelContainment}
          data-testid="group-project-message-detail-scroll"
        >
          {selectedMessage ? (
            <div>
              <div className="h-[30px] flex items-center gap-2 min-w-0">
                <span className="text-[13px] font-medium text-ctp-text truncate">{selectedMessage.sender}</span>
                <span className="text-xs text-ctp-overlay1 flex-shrink-0">
                  {selectedMessage.pending ? `Waiting for ${selectedMessage.pending.waitingFor}` : formatTime(selectedMessage.timestamp)}
                </span>
                {selectedTopic === ALL_TOPICS_KEY && (
                  <span className="text-xs text-ctp-overlay1 truncate">in {selectedMessage.topic}</span>
                )}
                {!selectedMessage.pending && (
                  <span className="ml-auto">
                    <IconButton label="Delete message" onClick={() => void handleDeleteMessage(selectedMessage.topic, selectedMessage.id)}>
                      <TrashIcon />
                    </IconButton>
                  </span>
                )}
              </div>
              <div
                className="border-t border-surface-0 pt-2 mt-1 text-[13px] prose prose-sm prose-invert max-w-none break-words"
                dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(selectedMessage.body) }}
              />
            </div>
          ) : (
            <div className="text-xs text-ctp-overlay1">Select a message</div>
          )}
        </div>
      </div>


      <ProjectScopeLine ctx={ctx} />
      <div className="h-[30px] flex items-center px-3 border-t border-surface-0 text-xs text-ctp-overlay1 flex-shrink-0">
        {members.length} {members.length === 1 ? 'agent' : 'agents'} connected
      </div>

    </div>
  );
}

/** One topic: name (with a shield when protected) and its count, or how many are new. */
function TopicRow({ topic: t, selected, onSelect, onToggleProtection, onDelete }: {
  topic: TopicDigest;
  selected: boolean;
  onSelect: () => void;
  onToggleProtection: () => void;
  onDelete: () => void;
}) {
  return (
    <li className={`group/topic relative rounded-md hover:bg-surface-0 ${selected ? 'bg-surface-0' : ''}`}>
      <button
        onClick={onSelect}
        aria-current={selected || undefined}
        className={`w-full h-[30px] flex items-center gap-1.5 px-1.5 text-left ${selected ? 'text-ctp-text' : 'text-ctp-subtext1'}`}
      >
        {t.isProtected && <span className="text-ctp-overlay1 flex-shrink-0" aria-label="Protected"><ShieldIcon size={12} /></span>}
        <span className="text-[13px] flex-1 truncate">{t.topic}</span>
        {t.newMessageCount > 0 ? (
          <span className="text-xs font-medium text-ctp-text flex-shrink-0 group-hover/topic:hidden group-focus-within/topic:hidden" data-testid="group-project-topic-unread">
            {t.newMessageCount} new
          </span>
        ) : (
          <span className="text-xs text-ctp-overlay1 flex-shrink-0 group-hover/topic:hidden group-focus-within/topic:hidden">{t.messageCount}</span>
        )}
      </button>
      <span className="absolute inset-y-0 right-0.5 hidden group-hover/topic:flex group-focus-within/topic:flex items-center">
        <IconButton
          label="Protect topic"
          tooltip="Protect topic: retention never removes its messages"
          pressed={!!t.isProtected}
          onClick={(e) => { e.stopPropagation(); onToggleProtection(); }}
        >
          <ShieldIcon />
        </IconButton>
        <IconButton label="Delete topic" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <TrashIcon />
        </IconButton>
      </span>
    </li>
  );
}

/* ---------- Header ---------- */

function BoardHeader({
  variant,
  displayName,
  groupProjectId,
  update,
  onUpdateMetadata,
  notificationLabel,
  onToggleRetention,
  showRetentionSettings,
  onClearAll,
  clearAllDisabledReason,
  actions,
}: {
  variant: 'card' | 'workspace';
  displayName: string;
  groupProjectId: string;
  update: GroupProjectContextValue['update'];
  onUpdateMetadata?: (updates: Record<string, unknown>) => void;
  notificationLabel: string;
  onToggleRetention: () => void;
  showRetentionSettings: boolean;
  onClearAll: () => void;
  clearAllDisabledReason: string | null;
  actions?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

  const handleStartEdit = useCallback(() => {
    setEditName(displayName);
    setEditing(true);
  }, [displayName]);

  const handleSaveEdit = useCallback(async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== displayName) {
      await update(groupProjectId, { name: trimmed });
      onUpdateMetadata?.({ name: trimmed });
    }
    setEditing(false);
  }, [editName, displayName, update, groupProjectId, onUpdateMetadata]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSaveEdit();
      if (e.key === 'Escape') setEditing(false);
    },
    [handleSaveEdit],
  );

  return (
    <div className="h-[30px] flex items-center gap-1 pl-3 pr-1.5 border-b border-surface-0 flex-shrink-0">
      {variant === 'card' && (editing ? (
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSaveEdit}
          aria-label="Group project name"
          className={`${FIELD} h-6 text-[13px] max-w-[240px]`}
          autoFocus
        />
      ) : (
        <Tooltip content="Rename">
          <button
            onClick={handleStartEdit}
            className="h-6 px-1.5 -ml-1.5 rounded-md text-[13px] font-medium text-ctp-text hover:bg-surface-0 truncate min-w-0"
          >
            {displayName}
          </button>
        </Tooltip>
      ))}
      <span className="flex-1" />
      <Tooltip content={clearAllDisabledReason ?? 'Delete every message on the board'}>
        <Button kind="danger" onClick={onClearAll} disabled={!!clearAllDisabledReason} data-testid="group-project-clear-all">
          Clear all messages
        </Button>
      </Tooltip>
      <IconButton label="Retention settings" pressed={showRetentionSettings} onClick={onToggleRetention}><GearIcon /></IconButton>
      <Tooltip content={`${notificationLabel}. Saved configuration, not confirmation that messages reached members on other computers.`}>
        <span role="status" aria-label="Post notifications" tabIndex={0} className="min-w-0 truncate rounded-sm text-xs text-ctp-subtext1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ctp-accent">{notificationLabel}</span>
      </Tooltip>
      {actions}
    </div>
  );
}
