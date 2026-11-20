/** Shared selected-card transport/epoch boundary; no local inventory or writes. */
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { isRemoteInventoryPage, type RemoteInventoryQuery, type RemoteInventorySource } from '../../../../shared/remote-inventory-page';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { remoteDetailsAddress } from './remote-details-address';
type Result = ControllerReadResult<RemoteAgentDetails> | { status: 'loading' };
const cardFor = (source: RemoteInventorySource) => source === 'selected-action-relationships' ? 'actions' : 'skills-mcp';
export function useSelectedInventoryPage({ agent, details, status, freshnessKey, open, readable, card, onRefused }: {
  agent: Agent; details: RemoteAgentDetails | null; status: Result['status']; freshnessKey: string; open: boolean; readable: boolean; card: 'actions' | 'skills-mcp'; onRefused?(): void;
}) {
  const address = remoteDetailsAddress(agent.id);
  const satellite = useAnnexClientStore((s) => s.satellites.find((h) => h.id === address?.satelliteId));
  const connected = satellite?.state === 'connected', snapshot = satellite?.snapshot;
  const currentCard = details?.cards.find((c) => c.id === card);
  const contextReadable = connected && !satellite?.snapshotUnavailable && readable && status === 'ok' && !!details && details.agentId === address?.agentId
    && !details.inventoryPageOnly && !details.helperPageOnly && !details.connectionPageOnly && !!currentCard && currentCard.requested !== false && currentCard.state !== 'not-applicable';
  const eligible = contextReadable && agent.kind === 'durable' && details.inventoryPages === 1 && !!details.inventorySources?.some((source) => cardFor(source) === card);
  const transport = useRef({ eligible, generation: 0 });
  if (transport.current.eligible !== eligible) transport.current = { eligible, generation: transport.current.generation + 1 };
  const identity = `${agent.id}:${agent.projectId}:${agent.kind}:${card}:${freshnessKey}:${details?.readAt ?? ''}:${details?.inventorySources?.join(',') ?? ''}:${transport.current.generation}`;
  const [navigation, setNavigation] = useState<{ identity: string; query: RemoteInventoryQuery; revision: number } | null>(null);
  const selected = navigation?.identity === identity ? navigation : null, query = selected?.query;
  const key = `${identity}:${query?.source ?? ''}:${query?.offset ?? 0}:${query?.selection ?? ''}:${selected?.revision ?? 0}`;
  const [read, setRead] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const refused = useRef(onRefused); refused.current = onRefused;
  useEffect(() => {
    if (!open || !eligible || !query || !address || !details?.inventorySources?.includes(query.source)) return;
    let active = true;
    Promise.resolve().then(() => window.clubhouse.annexClient.agentDetails(address.satelliteId, address.agentId, query)).then(
      (result) => { if (active) { setRead({ key, snapshot, result }); if (result.status === 'forbidden') refused.current?.(); } },
      // telemetry-exempt: safe display state only; no host errors/local fallback.
      () => { if (active) setRead({ key, snapshot, result: { status: 'error' } }); },
    );
    return () => { active = false; };
  }, [open, eligible, query, key, snapshot, address?.satelliteId, address?.agentId, details?.inventorySources]);
  const result: Result = !eligible ? { status: !connected ? 'offline' : status === 'ok' ? 'unavailable' : status } as Result
    : read?.key === key && read.snapshot === snapshot ? read.result : { status: 'loading' };
  const response = result.status === 'ok' && result.value.agentId === address?.agentId && result.value.inventoryPages === 1 && result.value.inventoryPageOnly === true && isRemoteInventoryPage(result.value.inventoryPage) ? result.value.inventoryPage : undefined;
  const page = query && response?.source === query.source && response.offset === (query.offset ?? 0)
    && (response.state !== 'recorded' || !query.selection || response.selection === query.selection) ? response : undefined;
  const select = (source: RemoteInventorySource, offset = 0, selection?: string) => {
    if (cardFor(source) !== card) return;
    const common = { offset, ...(selection && { selection }) };
    const next: RemoteInventoryQuery = source === 'selected-action-relationships' ? { card: 'actions', source, ...common } : { card: 'skills-mcp', source, ...common };
    setNavigation({ identity, query: next, revision: (selected?.revision ?? 0) + 1 });
  };
  return { eligible, contextReadable, query, key, page, result: result.status === 'ok' && query && !page ? { status: 'error' as const } : result, select };
}
