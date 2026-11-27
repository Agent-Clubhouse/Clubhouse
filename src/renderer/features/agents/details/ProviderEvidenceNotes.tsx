import type { ChatDetailsEvidence, ChatDetailsField } from '../../../../shared/chat/details-evidence';
import { CardNote } from './DetailsCard';
const labels: Record<ChatDetailsField, string> = {
  cliVersion: 'CLI version', model: 'Model', models: 'Model names', effort: 'Effort', level: 'Access', capabilities: 'CLI capabilities', contextLimits: 'Context limits', mcpServers: 'MCP connection reports', skills: 'Loaded skill names', inventory: 'CLI inventory', subagents: 'Subagent reports', sessionUsage: 'Session usage', turnUsage: 'Turn usage', turnTotal: 'Completed turn tokens', context: 'Context fill', limits: 'Plan limits',
};
export function ProviderEvidenceNotes({ evidence }: { evidence: ChatDetailsEvidence }) {
  return <details className="text-xs text-ctp-overlay1" data-testid="provider-evidence-times"><summary>CLI report times</summary>
    <p>Only reported fields are listed. A missing field is unknown; no earlier run fills it in.</p>
    {Object.entries(evidence.observedAt).map(([field, at]) => <p key={field}>{labels[field as ChatDetailsField]} · {new Date(at!).toLocaleTimeString()}</p>)}
    {Object.entries(evidence.omitted).filter(([, count]) => count && count > 0).map(([field, count]) => <p key={field}>{labels[field as ChatDetailsField]}: {count} reports or values withheld by the host’s display limits.</p>)}
  </details>;
}
export function ProviderInventory({ evidence }: { evidence?: ChatDetailsEvidence }) {
  const inventory = evidence?.values.inventory;
  if (!inventory) return null;
  return <>
    <CardNote>CLI inventory · {inventory.source} · {new Date(inventory.reportedAt).toLocaleString()}. Names do not prove loading succeeded, use or execution.</CardNote>
    {inventory.skillsReportedAt !== undefined && <CardNote>Skill names reported at {new Date(inventory.skillsReportedAt).toLocaleTimeString()}.</CardNote>}
    {inventory.mcpToolsReportedAt !== undefined && <CardNote>MCP tool names reported at {new Date(inventory.mcpToolsReportedAt).toLocaleTimeString()}.</CardNote>}
    {inventory.skills === undefined ? <CardNote>This inventory did not report skills.</CardNote> : inventory.skills === null ? <CardNote>The CLI’s skills list was unavailable or malformed.</CardNote> : inventory.skills.length ? inventory.skills.map((name) => <CardNote key={name}>CLI-reported skill: {name}</CardNote>) : <CardNote>The CLI explicitly reported no loaded skills.</CardNote>}
    {inventory.mcpTools === undefined ? <CardNote>This inventory did not report model-visible MCP tools.</CardNote> : inventory.mcpTools === null ? <CardNote>The CLI’s MCP tool list was unavailable or malformed.</CardNote> : inventory.mcpTools.length ? inventory.mcpTools.map((name) => <CardNote key={name}>Model-visible MCP tool: {name}</CardNote>) : <CardNote>The CLI explicitly reported no model-visible MCP tools.</CardNote>}
  </>;
}
