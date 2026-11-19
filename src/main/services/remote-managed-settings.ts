/** Selected managed Settings fields. Internal evidence is projected, never sent wholesale. */
import type { DurableAgentConfig } from '../../shared/types';
import type { RemoteAgentSettings } from '../../shared/remote-agent-settings';
import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import type { DisplayReceipt } from './display-settings';
import { managedAgents, readManagedStatusForDisplay, type ManagedDisplayStatus } from './managed-agents';
import { display, row } from './remote-details-presentation';
import { safeMcpErrorLine } from './mcp-error-text';

export interface ManagedSettingsEvidence { setup: RemoteAgentSettings['setup']; status: ManagedDisplayStatus; names: ReadonlyMap<string, string> }

export async function readRemoteManagedSettings(agent: DurableAgentConfig, shown: RemoteDetailsCard, receipts: DisplayReceipt[], authorized: () => boolean): Promise<ManagedSettingsEvidence> {
  const setup = agent.managed;
  if (!setup || setup.version !== 1 || ![setup.blocks, setup.skills, setup.mcps].every((ids) => Array.isArray(ids) && ids.length <= 100 && ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 2048))) throw new Error('setup_unreadable');
  const extra = setup.helperChanges;
  if (extra && ![extra.added, extra.removed].every((ids) => Array.isArray(ids) && ids.length <= 100 && ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 2048))) throw new Error('setup_unreadable');
  const ids = [...new Set([...setup.blocks, ...setup.skills, ...setup.mcps, ...(extra?.added ?? []), ...(extra?.removed ?? [])])];
  if (ids.length > 100) throw new Error('setup_limit');
  const service = managedAgents();
  const status = await readManagedStatusForDisplay(agent, { receipts });
  if (!authorized()) throw new Error('revoked');
  const names = new Map<string, string>();
  if (status.state === 'ok' && status.setupMetadata) {
    for (const part of [...status.setupMetadata.blocks, ...status.setupMetadata.skills, ...status.setupMetadata.mcps]) names.set(part.id, display(part.name, 240));
    for (const id of status.setupMetadata.missing) names.set(id, 'No longer in the library');
  }
  // Names outside the resolved applicable setup (for example a removed helper
  // part) are read only by selected id, through the same bounded metadata seam.
  const remaining = ids.filter((id) => !names.has(id));
  if (remaining.length) {
    const library = await service.openSetupMetadataForDisplay();
    if (!authorized()) throw new Error('revoked');
    for (const id of remaining) {
      const part = await library.head(id);
      if (!authorized()) throw new Error('revoked');
      names.set(id, part ? display(part.name, 240) : 'No longer in the library');
    }
    if (!library.receipt.current()) throw new Error('library_changed');
    receipts.push(library.receipt);
  }
  let template: Awaited<ReturnType<typeof service.getTemplateForDisplay>> | null = null;
  let templateName: string | null = null;
  if (setup.templateId) {
    try { template = await service.getTemplateForDisplay(setup.templateId, { receipts }); templateName = display(template.name, 240); }
    catch { templateName = 'Template unavailable'; shown.notes.push('The selected template is unavailable. Other setup fields are shown independently.'); }
    if (!authorized()) throw new Error('revoked');
  }
  const name = (id: string) => names.get(id) ?? 'Unavailable from library metadata';
  if (extra && (extra.added.length || extra.removed.length)) row(shown, 'Built from', [templateName ?? 'Template no longer available', extra.added.length ? `plus ${extra.added.map(name).join(', ')}` : '', extra.removed.length ? `minus ${extra.removed.map(name).join(', ')}` : ''].filter(Boolean).join(', '));
  if (template?.updatedBy) row(shown, 'Template changed', `${template.updatedBy}${template.updatedAt ? ` · ${template.updatedAt}` : ''}`);
  shown.notes.push('Part names and revisions are recorded library metadata. Revision payload integrity and provider loading are not verified.');
  if (status.state === 'ok') {
    const value = status.value;
    if (value.running && value.waiting) for (const change of value.changes.length ? value.changes : ['Setup changed']) row(shown, 'Waiting', safeMcpErrorLine(change));
    if (value.migrated) row(shown, 'Switched to managed', `${value.migrated.from} · backup: ${value.migrated.backup}`);
    if (value.migrationFailed) row(shown, 'Migration failed', safeMcpErrorLine(value.migrationFailed));
    if (value.deliveryFailed) row(shown, 'Setup delivery', safeMcpErrorLine(value.deliveryFailed));
  } else shown.notes.push('The host’s recorded managed delivery status is unavailable. No current delivery or provider loading is inferred.');
  return { status, names, setup: { state: 'ok', managed: true, template: templateName,
    instructions: `${setup.blocks.length} ${setup.blocks.length === 1 ? 'block' : 'blocks'}`,
    skills: setup.skills.map(name), mcps: setup.mcps.map(name),
    ...(status.state === 'ok' && { waiting: status.value.waiting }),
    ...(setup.updatedBy && { updatedBy: display(setup.updatedBy, 240) }), ...(setup.updatedAt && { updatedAt: display(setup.updatedAt, 240) }) } };
}
