/** Selected host display evidence only. No local inventories, probes or writes. */
import type { ReactNode } from 'react';
import type { RemoteDetailsCard } from '../../../../shared/remote-agent-details';
import type { RemoteAgentSettings } from '../../../../shared/remote-agent-settings';
import type { ChatDetailsEvidence } from '../../../../shared/chat/details-evidence';
import type { ChatMcpServer } from '../../../../shared/chat';
import type { ReportedSkills } from './reported-skills';
import { CardNote, CardRow } from './DetailsCard';
import { Evidence } from './RemoteDetailsEvidence';
import { McpServerRow, mcpRows } from './McpCard';
import { ProviderInventory } from './ProviderEvidenceNotes';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title}>
    <p className="pr-3.5 pl-[33px] pt-1.5 pb-0.5 text-xs text-ctp-overlay1">{title}</p>
    {children}
  </section>;
}

// These are the host producer's existing display phrases, not tool authority
// or provider-loading evidence. Unknown/older text stays intact below.
const installedSuffix = ' · Installation recorded by Clubhouse';
const setupSuffix = ' · Configured in Clubhouse';

export function RemoteSkillsMcpEvidence({ card, setup, live, skills, evidence, currentRun, sessionAvailable, message }: {
  card?: RemoteDetailsCard; setup?: RemoteAgentSettings['setup']; live: ChatMcpServer[] | null;
  skills: ReportedSkills; evidence?: ChatDetailsEvidence; currentRun: boolean; sessionAvailable: boolean; message: string;
}) {
  if (card?.requested === false) return <Evidence card={card} />;
  const installed = currentRun ? card?.rows.filter((r) => r.label === 'Skill' && r.value.endsWith(installedSuffix)) ?? [] : [];
  const configuredSkills = card?.rows.filter((r) => r.label === 'Skill' && r.value.endsWith(setupSuffix)) ?? [];
  const groupedSkills = new Set([...installed, ...configuredSkills]);
  const fallbackSkills = !card?.rows.some((r) => r.label === 'Skill') && setup?.state === 'ok' && setup.managed ? setup.skills : null;
  const configuredRows = card?.rows.filter((r) => r.label === 'MCP configured') ?? [];
  const configured = [...new Set([...(setup?.state === 'ok' ? setup.mcps ?? [] : []), ...configuredRows.map((r) => r.value)])];
  const configuredKnown = configuredRows.length > 0 || setup?.state === 'ok' && setup.mcps !== null;
  const mcps = mcpRows(live, null, configured);
  const bridge = currentRun ? card?.rows.filter((r) => r.label === 'Clubhouse MCP') ?? [] : [];
  const grouped = new Set([...groupedSkills, ...configuredRows, ...bridge]);
  const remaining = card?.rows.filter((r) => !grouped.has(r) && (currentRun || r.label !== 'Clubhouse MCP')) ?? [];
  const report = skills.report;
  return <>
    <Group title="Skills">
      {installed.length > 0 && <Group title="Installed by Clubhouse">
        <CardNote>Installation recorded by the host; provider loading, use and execution are not verified.</CardNote>
        <ul className="pr-3.5 pl-[33px] py-1 text-xs break-words" aria-label="Installed by Clubhouse">{installed.map((r, i) => <li key={i}>{r.value}</li>)}</ul>
      </Group>}
      {(configuredSkills.length > 0 || !!fallbackSkills?.length) && <Group title="Set up by Clubhouse">
        <CardNote>Saved setup for the next start. Installation is not confirmed by these records.</CardNote>
        <ul className="pr-3.5 pl-[33px] py-1 text-xs break-words" aria-label="Set up by Clubhouse">{configuredSkills.map((r, i) => <li key={i}>{r.value}</li>)}{fallbackSkills?.map((name, i) => <li key={`saved-${i}`}>{name}</li>)}</ul>
      </Group>}
      {!installed.length && !configuredSkills.length && !fallbackSkills?.length && <CardNote>Clubhouse skill installation and setup groups are not available in this host evidence. No empty inventory is inferred.</CardNote>}
      <Group title="Provider-reported skills">
        {report ? <>
          <CardNote>Session snapshot. Provider-reported names do not prove a skill was used or executed. Filesystem scope and origin are not reported.</CardNote>
          <CardRow label="Source">Claude · system/init</CardRow><CardRow label="Session">{report.sessionId}</CardRow><CardRow label="Native session">{report.nativeSessionId}</CardRow><CardRow label="Reported">{new Date(report.reportedAt).toLocaleString()}</CardRow>
          {report.names?.length ? <ul className="pr-3.5 pl-[33px] py-1 text-xs break-words" aria-label="Provider-reported skill names">{report.names.map((name, i) => <li key={i}>{name}</li>)}</ul> : <CardNote>{report.names ? 'Claude explicitly reported no skills in this snapshot.' : 'Skill names were not reported in this snapshot.'}</CardNote>}
        </> : <CardNote>{!sessionAvailable ? 'Provider evidence is unavailable until a current authorized session read succeeds.' : skills.supported ? 'No valid skills report for this session has arrived.' : 'This provider does not report loaded skill names here.'}</CardNote>}
      </Group>
    </Group>
    <Group title="MCP servers">
      {live === null ? <CardNote>The provider has not reported its MCP connections in the current authorized session evidence.</CardNote> : !live.length && <CardNote>The provider explicitly reported no MCP connections.</CardNote>}
      {!!mcps.rows.length && <ul aria-label="Provider-reported MCP servers">{mcps.rows.map((m, i) => <McpServerRow key={i} row={m} />)}</ul>}
      {!!bridge.length && <Group title="Host Clubhouse MCP handshake"><Evidence card={{ ...card!, rows: bridge, notes: [], omitted: 0, state: 'ok' }} /></Group>}
      {!!mcps.configuredOnly.length && <Group title="Set in Clubhouse">
        <CardNote>Configured names absent from the available provider report. Loading is not confirmed.</CardNote>
        <ul aria-label="Configured-only MCP servers">{mcps.configuredOnly.map((name, i) => <McpServerRow key={i} row={{ name, status: 'configured' }} />)}</ul>
      </Group>}
      {!configuredKnown && <CardNote>The host has not shared a configured MCP inventory. Missing names are unknown.</CardNote>}
      {configuredKnown && !configured.length && <CardNote>The host explicitly shared no configured MCP names.</CardNote>}
      <Group title="Wires"><CardNote>This host does not share verified wire names and kinds in this card. Wiring is unknown here; saved connection descriptions do not confirm a current wire.</CardNote></Group>
    </Group>
    <Group title="Provider inventory"><ProviderInventory evidence={evidence} />{!evidence?.values.inventory && <CardNote>No separate provider inventory report is available.</CardNote>}</Group>
    {card ? <Evidence card={{ ...card, rows: remaining }} /> : <CardNote>{message}</CardNote>}
  </>;
}
