/**
 * The Setup card (#2896): for a Clubhouse-managed agent, the Settings card
 * becomes Setup. It says what the agent is built from (template,
 * instruction blocks, skills, MCP servers, CLI and model) and, for a running
 * agent whose setup changed after its session started, what is waiting.
 * Open builder goes to the agent's Instructions page; Restart applies what
 * is waiting. An agent Clubhouse switched on its own says so until the
 * notice is dismissed (D59). A helper says what start_helper changed from its
 * template (D91), and a setup or template the Dispatcher changed says so (D90).
 */
import { useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ManagedAgentSetup, ManagedPartSummary } from '../../../../shared/managed-agents-types';
import { Button } from '../../../components/Button';
import { errorText, managed, unwrap, useManagedParts, useManagedStatus, useManagedTemplates } from '../../managed/managedApi';
import { builtFromLine, changedLine } from '../../managed/attribution';
import { migratedLine } from '../../managed/legacy';
import { PENDING_RESTART_NOTE, useManagedRestart } from '../../managed/restart';
import { openAgentSettingsOn } from '../agentSettingsPages';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { useAgentDetailsStore } from './detailsStore';

export const SETUP_WAITING_NOTE = 'Applies when it restarts or next wakes.';

/** "Managed · Release lead · 2 changes waiting". */
export function setupSummary(templateName: string | null, waiting: number): string {
  const changes = waiting > 0 ? `${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting` : null;
  return ['Managed', templateName, changes].filter(Boolean).join(' · ');
}

/** The parts' names in setup order, and how many ids no longer match a part. */
export function partNames(ids: string[], parts: ManagedPartSummary[] | null): { names: string[]; missing: number } {
  if (!parts) return { names: [], missing: 0 };
  const byId = new Map(parts.map((p) => [p.id, p.name]));
  const names = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  return { names, missing: ids.length - names.length };
}

function NameList({ ids, parts }: { ids: string[]; parts: ManagedPartSummary[] | null }) {
  if (ids.length === 0) return <>None</>;
  if (!parts) return <span className="text-ctp-overlay1">Loading</span>;
  const { names, missing } = partNames(ids, parts);
  return (
    <>
      {names.join(', ')}
      {missing > 0 && <span className="text-ctp-overlay1">{names.length > 0 ? ', ' : ''}{missing} no longer in the library</span>}
    </>
  );
}

/** "Helper template, plus Playwright, minus code-review", with names from the library once it loads. */
function BuiltFrom({ templateName, changes }: { templateName: string | null; changes: NonNullable<ManagedAgentSetup['helperChanges']> }) {
  const lists = [useManagedParts('block').value, useManagedParts('skill').value, useManagedParts('mcp').value];
  if (lists.some((l) => l === null)) return <span className="text-ctp-overlay1">Loading</span>;
  const byId = new Map(lists.flatMap((l) => l!).map((p) => [p.id, p.name]));
  return <>{builtFromLine(templateName, changes, (id) => byId.get(id))}</>;
}

/** The rows, read only while the card is open. */
function SetupRows({ setup, templateName, templateChange, runsOn, changes }: {
  setup: ManagedAgentSetup;
  templateName: string | null;
  /** Who last changed the template, when not the person (D90). */
  templateChange: string | null;
  runsOn: string;
  changes: string[] | null;
}) {
  const skills = useManagedParts('skill');
  const mcps = useManagedParts('mcp');
  const blocks = setup.blocks.length;
  const helperChanges = setup.helperChanges && (setup.helperChanges.added.length > 0 || setup.helperChanges.removed.length > 0) ? setup.helperChanges : null;
  return (
    <>
      <CardRow label="Managed" labelWidth="wide" testId="details-setup-managed">By Clubhouse</CardRow>
      {helperChanges ? (
        <CardRow label="Built from" labelWidth="wide" testId="details-setup-built-from"><BuiltFrom templateName={templateName} changes={helperChanges} /></CardRow>
      ) : (
        <CardRow label="Template" labelWidth="wide" testId="details-setup-template">
          {templateName ?? 'None'}
          {templateChange && <span className="block text-xs text-ctp-overlay1" data-testid="details-setup-template-changed">{templateChange}</span>}
        </CardRow>
      )}
      <CardRow label="Instructions" labelWidth="wide" testId="details-setup-instructions">{blocks} {blocks === 1 ? 'block' : 'blocks'}</CardRow>
      <CardRow label="Skills" labelWidth="wide" testId="details-setup-skills"><NameList ids={setup.skills} parts={skills.value} /></CardRow>
      <CardRow label="MCP servers" labelWidth="wide" testId="details-setup-mcp"><NameList ids={setup.mcps} parts={mcps.value} /></CardRow>
      <CardRow label="Runs on" labelWidth="wide" testId="details-setup-runs-on">{runsOn}</CardRow>
      {changes && (
        <CardRow label="Waiting" labelWidth="wide" testId="details-setup-waiting">
          <span className="flex flex-col text-ctp-warning">
            {changes.length > 0 ? changes.map((c, i) => <span key={i}>{c}</span>) : <span>Setup changed</span>}
          </span>
        </CardRow>
      )}
    </>
  );
}

export function SetupCard({ agent, projectPath, setup, runsOn }: {
  agent: Agent;
  projectPath: string;
  setup: ManagedAgentSetup;
  /** "Claude Code · Opus 5.5". */
  runsOn: string;
}) {
  const open = useAgentDetailsStore((s) => s.settingsOpen);
  const setOpen = useAgentDetailsStore((s) => s.setSettingsOpen);
  const templates = useManagedTemplates();
  const { value: status } = useManagedStatus(projectPath, agent.id);
  const { restart, busy, pending, error, dialog } = useManagedRestart({ projectPath, agentId: agent.id, agentName: agent.name });
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const dismiss = async () => {
    setDismissing(true);
    setDismissError(null);
    try {
      await unwrap(managed().dismissMigrationNotice(projectPath, agent.id));
    } catch (err) {
      // telemetry-exempt: shown in the card.
      setDismissError(errorText(err));
    } finally {
      setDismissing(false);
    }
  };

  const template = setup.templateId ? templates.value?.find((t) => t.id === setup.templateId) ?? null : null;
  const templateName = template?.name ?? null;
  const templateChange = template?.updatedBy ? `Template ${changedLine(template.updatedAt, template.updatedBy).replace(/^C/, 'c')}` : null;
  const changes = status?.waiting && status.running ? status.changes : null;
  const waiting = changes !== null;
  const summary = setupSummary(templateName, changes ? Math.max(1, changes.length) : 0);

  return (
    <DetailsCard id="settings" title="Setup" summary={summary} open={open} onToggle={() => setOpen(!open)}>
      <SetupRows setup={setup} templateName={templateName} templateChange={templateChange} runsOn={runsOn} changes={changes} />
      {setup.updatedBy && <CardNote><span data-testid="details-setup-changed">{changedLine(setup.updatedAt, setup.updatedBy)}</span></CardNote>}
      <span role="status" className="sr-only" data-testid="details-setup-live">{pending ? PENDING_RESTART_NOTE : waiting ? SETUP_WAITING_NOTE : ''}</span>
      {(waiting || pending) && <CardNote><span data-testid="details-setup-note">{pending ? PENDING_RESTART_NOTE : SETUP_WAITING_NOTE}</span></CardNote>}
      {error && <CardNote><span className="text-ctp-error" role="alert" data-testid="details-setup-error">{error}</span></CardNote>}
      {status?.migrated && (
        <div className="pr-3.5 pl-[33px] pt-1 pb-1.5 flex items-center gap-2" data-testid="details-setup-migrated">
          <span className="flex-1 min-w-0 text-xs leading-normal text-ctp-subtext1">{migratedLine(status.migrated.backup)}</span>
          <Button kind="ghost" onClick={() => void dismiss()} disabled={dismissing} data-testid="details-setup-migrated-dismiss">Dismiss</Button>
        </div>
      )}
      {dismissError && <CardNote><span className="text-ctp-error" role="alert">{dismissError}</span></CardNote>}
      <div className="pr-3.5 pl-[33px] pt-1 flex items-center gap-1.5">
        <Button kind="ghost" onClick={() => openAgentSettingsOn(agent.id, 'instructions')} data-testid="details-setup-open-builder">Open builder</Button>
        {waiting && (
          <Button kind="ghost" onClick={() => restart({ fresh: !!status?.cliChanged })} disabled={busy} data-testid="details-setup-restart">
            {busy ? 'Restarting' : 'Restart'}
          </Button>
        )}
      </div>
      {dialog}
    </DetailsCard>
  );
}
