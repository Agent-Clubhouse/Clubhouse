import { useState } from 'react';
import { Button } from '../../components/Button';
import { GROUP_PROJECT_TOOL_SUFFIXES } from '../../../shared/group-project-permissions';
import { useMcpBindingStore, type McpBindingEntry } from '../../stores/mcpBindingStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { WireToolPermissionsDialog } from '../../plugins/builtin/canvas/WireToolPermissionsDialog';
import { ConnectionEditorDialog } from '../agents/helpers/ConnectionEditorDialog';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';

type Editing = { binding: McpBindingEntry; kind: 'tools' | 'instructions' } | null;

/**
 * Each member's own tool switches and instructions for this group project:
 * what the canvas edits on a member's wire. A member with nothing saved uses
 * the group project's defaults (set under Default permissions).
 */
export function GroupProjectMemberToolsSection({ groupProjectId }: { groupProjectId: string }) {
  const bindings = useMcpBindingStore((s) => s.bindings);
  const setDisabledTools = useMcpBindingStore((s) => s.setDisabledTools);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const members = bindings.filter((b) => b.targetKind === 'group-project' && b.targetId === groupProjectId);

  const saveTools = (binding: McpBindingEntry, disabledTools: string[]) => {
    setError(null);
    setDisabledTools(binding.agentId, binding.targetId, disabledTools).catch((err: unknown) => {
      // telemetry-exempt: shown inline; the member keeps its saved switches.
      setError(`Not saved. ${ipcErrorMessage(err)}`);
    });
  };

  return (
    <SettingsSection title="Member tools and instructions">
      <SettingsBlock>
        <p className={`${settingsHelp} mb-2`}>
          Each member can have its own tool switches and instructions for this group project.
        </p>
        {members.length === 0 && <p className={settingsHelp}>No members.</p>}
        {members.length > 0 && (
          <ul aria-label="Member tools and instructions" className="flex flex-col gap-1">
            {members.map((binding) => {
              const name = binding.agentName || binding.agentId;
              const off = binding.disabledTools?.length ?? 0;
              const hasInstructions = !!binding.instructions && Object.keys(binding.instructions).length > 0;
              return (
                <li key={binding.agentId} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-ctp-text">
                    {name}
                    <span className={`${settingsHelp} ml-2`}>
                      {GROUP_PROJECT_TOOL_SUFFIXES.length - off} of {GROUP_PROJECT_TOOL_SUFFIXES.length} tools on{hasInstructions ? ', has instructions' : ''}
                    </span>
                  </span>
                  <span className="flex flex-shrink-0 items-center gap-1">
                    <Button onClick={() => setEditing({ binding, kind: 'tools' })} aria-label={`Tools for ${name}`}>Tools</Button>
                    <Button onClick={() => setEditing({ binding, kind: 'instructions' })} aria-label={`Instructions for ${name}`}>Instructions</Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p role="alert" className={`${settingsError} mt-2`}>{error}</p>}
        {editing?.kind === 'tools' && (
          <WireToolPermissionsDialog
            binding={editing.binding}
            onSave={(tools) => saveTools(editing.binding, tools)}
            onClose={() => setEditing(null)}
          />
        )}
        {editing?.kind === 'instructions' && (
          <ConnectionEditorDialog binding={editing.binding} onClose={() => setEditing(null)} />
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}
