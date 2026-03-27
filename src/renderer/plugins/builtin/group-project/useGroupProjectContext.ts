/**
 * Unified hook that abstracts local vs remote data access for group project widgets.
 * When the widget renders on a satellite canvas (remote), data comes from the remote
 * project store and mutations go through the annex client proxy. When local, the standard
 * IPC bridge and Zustand stores are used.
 */
import { useMemo, useCallback } from 'react';
import type { GroupProject } from '../../../../shared/group-project-types';
import type { TopicDigest, BulletinMessage } from '../../../../shared/group-project-types';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { ptyWrite } from '../../../services/project-proxy';

export interface GroupProjectMember {
  agentId: string;
  agentName: string;
  status: string;
}

export interface GroupProjectContextValue {
  isRemote: boolean;
  satelliteId: string | null;

  /** The resolved group project (may be null while loading). */
  project: GroupProject | null;

  /** Connected / sleeping members. */
  members: GroupProjectMember[];

  /** Whether underlying data has loaded at least once. */
  loaded: boolean;

  /** Trigger initial load (local only — remote data comes from snapshot). */
  loadProjects: () => Promise<void>;

  /** Update project fields. */
  update: (groupProjectId: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }) => Promise<void>;

  /** Fetch bulletin digest. */
  fetchDigest: (groupProjectId: string, since?: string) => Promise<TopicDigest[]>;

  /** Fetch messages for a specific topic. */
  fetchTopicMessages: (groupProjectId: string, topic: string, since?: string, limit?: number) => Promise<BulletinMessage[]>;

  /** Fetch all messages across topics. */
  fetchAllMessages: (groupProjectId: string, since?: string, limit?: number) => Promise<BulletinMessage[]>;

  /** Inject a message into an agent's PTY (works both local and remote). */
  injectMessage: (agentId: string, message: string) => void;
}

/** Deduplicate members by agentId. */
function dedupeMembers(members: GroupProjectMember[]): GroupProjectMember[] {
  const seen = new Set<string>();
  return members.filter((m) => {
    if (seen.has(m.agentId)) return false;
    seen.add(m.agentId);
    return true;
  });
}

/**
 * Provides a unified API for accessing group project data regardless of
 * whether the widget is rendering in a local or remote (satellite) context.
 */
export function useGroupProjectContext(
  groupProjectId: string | undefined,
  isRemote: boolean,
  satelliteId: string | null,
): GroupProjectContextValue {
  // --- Local store selectors ---
  const localProjects = useGroupProjectStore((s) => s.projects);
  const localLoaded = useGroupProjectStore((s) => s.loaded);
  const localLoadProjects = useGroupProjectStore((s) => s.loadProjects);
  const localUpdate = useGroupProjectStore((s) => s.update);
  const localBindings = useMcpBindingStore((s) => s.bindings);

  // --- Remote store selectors ---
  const remoteGroupProjects = useRemoteProjectStore((s) => s.remoteGroupProjects);
  const remoteMembers = useRemoteProjectStore((s) => s.remoteGroupProjectMembers);

  // --- Resolve project ---
  const project = useMemo<GroupProject | null>(() => {
    if (!groupProjectId) return null;
    if (isRemote && satelliteId) {
      const satProjects = remoteGroupProjects[satelliteId] as GroupProject[] | undefined;
      return satProjects?.find((p) => p.id === groupProjectId) ?? null;
    }
    return localProjects.find((p) => p.id === groupProjectId) ?? null;
  }, [groupProjectId, isRemote, satelliteId, remoteGroupProjects, localProjects]);

  // --- Resolve members ---
  const members = useMemo<GroupProjectMember[]>(() => {
    if (!groupProjectId) return [];
    if (isRemote && satelliteId) {
      const key = `${satelliteId}::${groupProjectId}`;
      return dedupeMembers(remoteMembers[key] || []);
    }
    return dedupeMembers(
      localBindings
        .filter((b) => b.targetKind === 'group-project' && b.targetId === groupProjectId)
        .map((b) => ({ agentId: b.agentId, agentName: b.agentName || b.agentId, status: 'connected' })),
    );
  }, [groupProjectId, isRemote, satelliteId, remoteMembers, localBindings]);

  const loaded = isRemote ? true : localLoaded;

  const loadProjects = useCallback(async () => {
    if (!isRemote) await localLoadProjects();
  }, [isRemote, localLoadProjects]);

  // --- Mutations ---
  const update = useCallback(async (gpId: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }) => {
    if (isRemote && satelliteId) {
      await window.clubhouse.annexClient.gpUpdate(satelliteId, gpId, fields);
    } else {
      await localUpdate(gpId, fields as any);
    }
  }, [isRemote, satelliteId, localUpdate]);

  // --- Bulletin reads ---
  const fetchDigest = useCallback(async (gpId: string, since?: string): Promise<TopicDigest[]> => {
    if (isRemote && satelliteId) {
      return await window.clubhouse.annexClient.gpBulletinDigest(satelliteId, gpId, since) as TopicDigest[];
    }
    return await window.clubhouse.groupProject.getBulletinDigest(gpId, since) as TopicDigest[];
  }, [isRemote, satelliteId]);

  const fetchTopicMessages = useCallback(async (gpId: string, topic: string, since?: string, limit?: number): Promise<BulletinMessage[]> => {
    if (isRemote && satelliteId) {
      return await window.clubhouse.annexClient.gpBulletinTopic(satelliteId, gpId, topic, since, limit) as BulletinMessage[];
    }
    return await window.clubhouse.groupProject.getTopicMessages(gpId, topic, since, limit) as BulletinMessage[];
  }, [isRemote, satelliteId]);

  const fetchAllMessages = useCallback(async (gpId: string, since?: string, limit?: number): Promise<BulletinMessage[]> => {
    if (isRemote && satelliteId) {
      return await window.clubhouse.annexClient.gpBulletinAll(satelliteId, gpId, since, limit) as BulletinMessage[];
    }
    return await window.clubhouse.groupProject.getAllMessages(gpId, since, limit) as BulletinMessage[];
  }, [isRemote, satelliteId]);

  // --- PTY injection: local uses ptyWrite, remote uses annexClient.ptyInput ---
  const injectMessage = useCallback((agentId: string, message: string) => {
    const isMultiLine = message.includes('\n');
    const data = isMultiLine ? `\x1b[200~${message}\x1b[201~` : message;
    if (isRemote && satelliteId) {
      window.clubhouse.annexClient.ptyInput(satelliteId, agentId, data);
      setTimeout(() => window.clubhouse.annexClient.ptyInput(satelliteId, agentId, '\r'), 150);
    } else {
      ptyWrite(agentId, data);
      setTimeout(() => ptyWrite(agentId, '\r'), 150);
    }
  }, [isRemote, satelliteId]);

  return {
    isRemote,
    satelliteId,
    project,
    members,
    loaded,
    loadProjects,
    update,
    fetchDigest,
    fetchTopicMessages,
    fetchAllMessages,
    injectMessage,
  };
}
