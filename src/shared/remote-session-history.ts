import { CHAT_DRIVER_IDS, type ChatDriverId } from './chat';

/** Positive receipt for ordinary durable history; absent is not an empty archive. */
export interface RemoteSessionHistoryBinding {
  version: 1;
  projectId: string;
  agentId: string;
  sessionId: string;
  providerId: string;
  driver: ChatDriverId;
  nativeSessionId: string;
  displayRunId: string;
  startSeq: number;
  subagents: 'full' | 'ids_only' | 'none';
}
const fields = ['version', 'projectId', 'agentId', 'sessionId', 'providerId', 'driver', 'nativeSessionId', 'displayRunId', 'startSeq', 'subagents'] as const;
export function isRemoteSessionHistoryBinding(value: unknown): value is RemoteSessionHistoryBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RemoteSessionHistoryBinding;
  const text = (s: unknown) => typeof s === 'string' && !!s && s.length <= 512 && !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  return Object.keys(v).every((key) => fields.includes(key as typeof fields[number])) && v.version === 1
    && [v.projectId, v.agentId, v.sessionId, v.providerId, v.nativeSessionId, v.displayRunId].every(text)
    && CHAT_DRIVER_IDS.includes(v.driver) && Number.isSafeInteger(v.startSeq) && v.startSeq >= 1
    && ['full', 'ids_only', 'none'].includes(v.subagents);
}
export function sameRemoteSessionHistoryBinding(a: RemoteSessionHistoryBinding, b: RemoteSessionHistoryBinding): boolean {
  return fields.every((field) => a[field] === b[field]);
}
