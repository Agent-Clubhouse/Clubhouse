import { useState, useCallback, useEffect } from 'react';
import type { GroupProjectContextValue } from '../../../plugins/builtin/group-project/useGroupProjectContext';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { showApprovalDialog } from '../../../plugins/PluginDialog';
import { WireToolPermissionsDialog } from '../../../plugins/builtin/canvas/WireToolPermissionsDialog';
import { Button } from '../../../components/Button';
import {
  GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION,
  GROUP_PROJECT_CORE_TOOL_SUFFIXES,
  GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES,
  getDefaultGroupProjectDisabledToolsFromMetadata,
} from '../../../../shared/group-project-permissions';
import { FIELD, FieldLabel } from './GroupProjectBoardParts';

/**
 * The tool switches new connections to a group project start with, and the
 * choice to apply them to the connections that already exist. In the canvas
 * card it sits beside the description and instructions and saves with them;
 * in the workspace the text belongs to Details, so `includeText` is off.
 */
export function GroupProjectDefaultsPanel({ groupProjectId, ctx, includeText }: {
  groupProjectId: string;
  ctx: GroupProjectContextValue;
  includeText: boolean;
}) {
  const { project, update } = ctx;
  const [editDesc, setEditDesc] = useState(project?.description || '');
  const [editInstr, setEditInstr] = useState(project?.instructions || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDefaultPermissionsDialog, setShowDefaultPermissionsDialog] = useState(false);

  const getDefaultDisabledTools = () =>
    getDefaultGroupProjectDisabledToolsFromMetadata(project?.metadata);

  const [defaultDisabledTools, setDefaultDisabledTools] = useState<string[]>(() => getDefaultDisabledTools());

  // Sync local state when project data loads or changes externally
  useEffect(() => {
    if (project) {
      setEditDesc(project.description || '');
      setEditInstr(project.instructions || '');
      setDefaultDisabledTools(getDefaultGroupProjectDisabledToolsFromMetadata(project.metadata));
    }
  }, [project?.description, project?.instructions, project?.metadata?.defaultDisabledTools]);

  const computeDefaultDisabledTools = useCallback(() => {
    return [...defaultDisabledTools];
  }, [defaultDisabledTools]);

  const hasUnsavedChanges = project
    ? (includeText && (editDesc !== (project.description || '') || editInstr !== (project.instructions || ''))) ||
      JSON.stringify(computeDefaultDisabledTools().sort()) !==
        JSON.stringify(getDefaultDisabledTools().sort())
    : false;

  const setDisabledTools = useMcpBindingStore((s) => s.setDisabledTools);

  const handleSave = useCallback(async () => {
    if (!hasUnsavedChanges || saving) return;
    // Wave 10 #8: confirm Save with the new-vs-existing choice INSIDE the
    // dialog so the user picks scope at confirm time, instead of forcing them
    // to pre-commit by clicking one of two ambiguous side-by-side buttons.
    const { promise } = showApprovalDialog({
      title: 'Save default permissions',
      summary:
        'Apply the new defaults to future connections only, or also retroactively apply them to every existing wire on this project?',
      actions: [
        { value: 'cancel', label: 'Cancel', style: 'default' },
        { value: 'future', label: 'Apply to new only', style: 'default' },
        { value: 'all', label: 'Apply to all', style: 'primary' },
      ],
    });
    const choice = await promise;
    if (choice !== 'future' && choice !== 'all') return;
    const applyToAll = choice === 'all';

    setSaving(true);
    setSaveError(null);
    try {
      const defaultDisabledTools = computeDefaultDisabledTools();
      await update(groupProjectId, {
        ...(includeText && { description: editDesc, instructions: editInstr }),
        metadata: { defaultDisabledTools, defaultDisabledToolsVersion: GROUP_PROJECT_DEFAULT_DISABLED_TOOLS_VERSION },
      });

      if (applyToAll) {
        const allBindings = useMcpBindingStore.getState().bindings;
        const projectBindings = allBindings.filter(
          b => b.targetId === groupProjectId && b.targetKind === 'group-project',
        );
        for (const binding of projectBindings) {
          await setDisabledTools(binding.agentId, binding.targetId, defaultDisabledTools);
        }
      }
    } catch (err) {
      // telemetry-exempt: shown beside Save, and the draft stays.
      setSaveError(`Not saved. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [hasUnsavedChanges, saving, update, groupProjectId, includeText, editDesc, editInstr, computeDefaultDisabledTools, setDisabledTools]);

  const displayName = project?.name || 'Group Project';
  const enabledPrivilegedDefaults = GROUP_PROJECT_PRIVILEGED_TOOL_SUFFIXES.filter(
    (suffix) => !defaultDisabledTools.includes(suffix),
  ).length;
  const disabledDefaultCount = defaultDisabledTools.length;

  return (
    <div className="flex gap-3 px-3 py-2 border-b border-surface-0">
      {showDefaultPermissionsDialog && (
        <WireToolPermissionsDialog
          binding={{
            agentId: 'group-project-defaults',
            targetId: groupProjectId,
            targetKind: 'group-project',
            label: `${displayName} defaults`,
            disabledTools: defaultDisabledTools,
          }}
          onSave={setDefaultDisabledTools}
          onClose={() => setShowDefaultPermissionsDialog(false)}
        />
      )}
      {includeText && (
        <>
          <div className="flex-1 min-w-0">
            <FieldLabel htmlFor={`${groupProjectId}-description`}>Description</FieldLabel>
            <textarea
              id={`${groupProjectId}-description`}
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="What this group project is for"
              rows={5}
              className={`${FIELD} py-1.5 resize-none`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <FieldLabel htmlFor={`${groupProjectId}-instructions`}>Instructions</FieldLabel>
            <textarea
              id={`${groupProjectId}-instructions`}
              value={editInstr}
              onChange={(e) => setEditInstr(e.target.value)}
              placeholder="Rules every agent here follows"
              rows={5}
              className={`${FIELD} py-1.5 resize-none`}
            />
          </div>
        </>
      )}
      <div className={`flex flex-col justify-between flex-shrink-0 gap-2 ${includeText ? 'w-44' : 'w-full max-w-md'}`}>
        <div>
          <div className="text-xs text-ctp-overlay1 mb-1">Default permissions</div>
          <div className="text-xs text-ctp-subtext0 leading-snug">
            {GROUP_PROJECT_CORE_TOOL_SUFFIXES.length} message tools on.
            {' '}
            {enabledPrivilegedDefaults === 0
              ? 'Privileged actions off.'
              : `${enabledPrivilegedDefaults} privileged action${enabledPrivilegedDefaults === 1 ? '' : 's'} on.`}
            {' '}
            {disabledDefaultCount} {disabledDefaultCount === 1 ? 'tool' : 'tools'} off.
          </div>
          <Button
            kind="ghost"
            className="mt-1.5"
            onClick={() => setShowDefaultPermissionsDialog(true)}
            data-testid="group-project-default-permissions-button"
          >
            Set defaults
          </Button>
        </div>
        {/* One Save: the scope (new connections only, or every existing one) is chosen in its confirm dialog. */}
        <div className="flex flex-col gap-1.5">
          <Button
            kind={hasUnsavedChanges ? 'primary' : 'ghost'}
            onClick={() => handleSave()}
            disabled={!hasUnsavedChanges || saving}
            data-testid="group-project-save-defaults-button"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {saveError && <p role="alert" className="text-xs text-ctp-error">{saveError}</p>}
        </div>
      </div>
    </div>
  );
}
