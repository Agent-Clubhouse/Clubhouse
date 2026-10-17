import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { useAgentStore } from '../../stores/agentStore';
import { useToastStore } from '../../stores/toastStore';
import { AGENT_COLORS, getAgentColorHex } from '../../../shared/name-generator';
import { ResetProjectDialog } from './ResetProjectDialog';
import { ImageCropDialog } from '../../components/ImageCropDialog';
import { EmojiPicker } from '../../components/EmojiPicker';
import { computeCatalogDiff } from '../../../shared/wrapper-diff';
import { pluginCommandRegistry } from '../../plugins/plugin-commands';
import type { LaunchWrapperConfig, McpCatalogEntry, WrapperCatalogSnapshot } from '../../../shared/types';
import { showConfirmDialog } from '../../plugins/PluginDialog';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { Spinner } from '../../components/Spinner';
import {
  SettingsPage,
  SettingsSection,
  SettingsField,
  SettingsBlock,
  settingsInput,
  settingsLabel,
  settingsHelp,
} from './SettingsLayout';
import { Button } from '../../components/Button';

function NameField({ projectId }: { projectId: string }) {
  const { projects, updateProject } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);

  const currentName = project ? (project.displayName || project.name) : '';
  const [value, setValue] = useState(currentName);

  // Sync if project changes externally
  useEffect(() => {
    if (project) {
      setValue(project.displayName || project.name);
    }
  }, [project?.displayName, project?.name]);

  if (!project) return null;

  const dirty = value.trim() !== currentName;

  const save = () => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === project.name) {
      updateProject(project.id, { displayName: '' });
    } else {
      updateProject(project.id, { displayName: trimmed });
    }
  };

  return (
    <SettingsField label="Name" help="Shown in the sidebar and title bar." htmlFor="project-settings-name">
      {dirty && (
        <Button onClick={save} kind="primary">
          Save
        </Button>
      )}
      <input
        id="project-settings-name"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        placeholder={project.name}
        className={`${settingsInput} w-[220px]`}
      />
    </SettingsField>
  );
}

function AppearanceFields({ projectId }: { projectId: string }) {
  const { projects, projectIcons, updateProject, pickProjectImage, saveCroppedProjectIcon } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);
  const [cropImageDataUrl, setCropImageDataUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  if (!project) return null;

  const iconDataUrl = projectIcons[project.id];
  const hasImage = !!project.icon && !!iconDataUrl;
  const hasEmoji = !!project.emoji;
  const hex = getAgentColorHex(project.color);
  const label = project.displayName || project.name;

  const handlePickImage = async () => {
    const dataUrl = await pickProjectImage();
    if (dataUrl) {
      setCropImageDataUrl(dataUrl);
    }
  };

  const handleCropConfirm = async (croppedDataUrl: string) => {
    setCropImageDataUrl(null);
    await saveCroppedProjectIcon(project.id, croppedDataUrl);
    // Clear emoji since image takes precedence when explicitly set
    if (project.emoji) {
      await updateProject(project.id, { emoji: '' });
    }
  };

  const handleCropCancel = () => {
    setCropImageDataUrl(null);
  };

  const handleEmojiSelect = async (emoji: string) => {
    await updateProject(project.id, { emoji });
  };

  const handleRemoveIcon = async () => {
    if (hasEmoji) {
      await updateProject(project.id, { emoji: '' });
    } else {
      await updateProject(project.id, { icon: '' });
    }
  };

  return (
    <>
      <SettingsField label="Icon">
        <div className="relative flex items-center gap-2">
          {/* Project color is data, so the preview tint comes from its hex. */}
          <div
            className="w-6 h-6 rounded-md overflow-hidden flex items-center justify-center flex-shrink-0"
            style={hasImage ? undefined : hasEmoji ? { backgroundColor: `${hex}15` } : { backgroundColor: `${hex}20`, color: hex }}
          >
            {hasEmoji ? (
              <span className="text-sm leading-none" role="img">{project.emoji}</span>
            ) : hasImage ? (
              <img src={iconDataUrl} alt={label} className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-semibold">{label.charAt(0).toUpperCase()}</span>
            )}
          </div>
          {(hasImage || hasEmoji) && (
            <Button onClick={handleRemoveIcon} kind="quiet">
              Remove
            </Button>
          )}
          <Button
            ref={emojiButtonRef}
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            kind="ghost"
          >
            Choose emoji…
          </Button>
          <Button onClick={handlePickImage} kind="ghost">
            Choose image…
          </Button>
          {showEmojiPicker && (
            <div className="absolute top-9 right-0 z-dropdown">
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmojiPicker(false)}
              />
            </div>
          )}
        </div>
      </SettingsField>

      {/* Image crop dialog */}
      {cropImageDataUrl && (
        <ImageCropDialog
          imageDataUrl={cropImageDataUrl}
          maskShape="square"
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}

      <SettingsField label="Color">
        <div className="flex items-center gap-2.5" role="group" aria-label="Project color">
          {AGENT_COLORS.map((c) => {
            const isSelected = project.color === c.id || (!project.color && c.id === 'indigo');
            return (
              <button
                key={c.id}
                title={c.label}
                aria-label={c.label}
                aria-pressed={isSelected}
                onClick={() => updateProject(project.id, { color: c.id })}
                className={`w-[18px] h-[18px] rounded-full cursor-pointer focus-ring ${
                  isSelected ? 'outline outline-2 outline-ctp-text outline-offset-2' : ''
                }`}
                // Swatch colors are data from the agent palette.
                style={{ backgroundColor: c.hex }}
              />
            );
          })}
        </div>
      </SettingsField>
    </>
  );
}

function LaunchWrapperSection({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const [wrapper, setWrapper] = useState<LaunchWrapperConfig | undefined>(undefined);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [defaultMcps, setDefaultMcps] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<WrapperCatalogSnapshot | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const agents = useAgentStore((s) => s.agents);
  const addToast = useToastStore((s) => s.addToast);

  const load = useCallback(async () => {
    const [w, c, d, snap] = await Promise.all([
      window.clubhouse.project.readLaunchWrapper(projectPath),
      window.clubhouse.project.readMcpCatalog(projectPath),
      window.clubhouse.project.readDefaultMcps(projectPath),
      window.clubhouse.project.readWrapperCatalogSnapshot(projectPath),
    ]);
    setWrapper(w);
    setCatalog(c || []);
    setDefaultMcps(d || []);
    setSnapshot(snap);
    setLoaded(true);
  }, [projectPath]);

  useEffect(() => { load(); }, [load]);

  // Compute mcpIds across all agents in this project (for "removed-only-if-selected" rule).
  const anyAgentMcpIds = useMemo(() => {
    const ids = new Set<string>();
    for (const agent of Object.values(agents)) {
      if (agent.projectId !== projectId) continue;
      for (const id of agent.mcpIds || []) ids.add(id);
    }
    return Array.from(ids);
  }, [agents, projectId]);

  const diffEntries = useMemo(
    () => computeCatalogDiff(catalog, snapshot, defaultMcps, anyAgentMcpIds),
    [catalog, snapshot, defaultMcps, anyAgentMcpIds],
  );

  const newCount = diffEntries.filter((e) => e.state === 'new').length;
  const changedCount = diffEntries.filter((e) => e.state === 'changed').length;
  const removedCount = diffEntries.filter((e) => e.state === 'removed').length;
  const hasDiff = newCount + changedCount + removedCount > 0;

  if (!loaded) return null;
  if (!wrapper) {
    return (
      <SettingsSection title="Launch wrapper">
        <SettingsBlock>
          <p className={settingsHelp}>
            No launch wrapper configured. A plugin can set one up automatically.
          </p>
        </SettingsBlock>
      </SettingsSection>
    );
  }

  const toggleMcp = async (id: string) => {
    const next = defaultMcps.includes(id)
      ? defaultMcps.filter((m) => m !== id)
      : [...defaultMcps, id];
    setDefaultMcps(next);
    await window.clubhouse.project.writeDefaultMcps(projectPath, next);
  };

  const handleRemoveWrapper = async () => {
    await window.clubhouse.project.writeLaunchWrapper(projectPath, undefined);
    await window.clubhouse.project.writeMcpCatalog(projectPath, []);
    await window.clubhouse.project.writeDefaultMcps(projectPath, []);
    await window.clubhouse.project.writeWrapperCatalogSnapshot(projectPath, undefined);
    setWrapper(undefined);
    setCatalog([]);
    setDefaultMcps([]);
    setSnapshot(undefined);
  };

  const handleRefresh = async () => {
    if (!wrapper?.refreshCommandId) return;
    setRefreshing(true);
    try {
      const commandId = wrapper.refreshCommandId;
      const pluginId = wrapper.contributingPluginId;
      // Try the configured id directly first (covers ids the plugin registered raw,
      // and ids the API stored as `${pluginId}:${commandId}`).
      // Then fall back to the prefixed form.
      const tryInvoke = async (): Promise<void> => {
        if (pluginCommandRegistry.has(commandId)) {
          await pluginCommandRegistry.execute(commandId);
          return;
        }
        if (pluginId) {
          const prefixed = `${pluginId}:${commandId}`;
          if (pluginCommandRegistry.has(prefixed)) {
            await pluginCommandRegistry.execute(prefixed);
            return;
          }
        }
        throw new Error(`Refresh command not registered: ${commandId}`);
      };

      await Promise.race([
        tryInvoke(),
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('refresh timed out after 15s')), 15000),
        ),
      ]);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[wrapper] refresh failed:', err);
      addToast(`Refresh failed: ${message}`, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleAcknowledge = async () => {
    await window.clubhouse.project.writeWrapperCatalogSnapshot(projectPath, {
      lastSeenCatalog: catalog,
      lastSeenAt: new Date().toISOString(),
    });
    await load();
  };

  const catalogHelp = hasDiff
    ? `${joinCounts([
      newCount ? `${newCount} new` : '',
      changedCount ? `${changedCount} changed` : '',
      removedCount ? `${removedCount} removed` : '',
    ])} since you last looked.`
    : 'No changes since you last looked.';

  return (
    <SettingsSection title="Launch wrapper" meta={<span className="font-mono">{wrapper.binary}</span>}>
      <SettingsField
        label="Catalog"
        help={<span className={hasDiff ? 'text-ctp-warning' : undefined}>{catalogHelp}</span>}
      >
        {wrapper.refreshCommandId && (
          <Button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh catalog"
            kind="quiet" className="disabled:cursor-wait"
          >
            {refreshing ? <Spinner size="xs" /> : <RefreshIcon />}
            Refresh
          </Button>
        )}
        {hasDiff && (
          <Button onClick={handleAcknowledge} kind="ghost">
            Mark as seen
          </Button>
        )}
        <Button
          onClick={() => setConfirmRemove(true)}
          kind="danger"
          data-testid="remove-wrapper-button"
        >
          Remove…
        </Button>
      </SettingsField>
      <ConfirmDestructiveAction
        open={confirmRemove}
        title="Remove launch wrapper?"
        description="This permanently removes the wrapper configuration, environment overrides, command arguments and tool filters."
        confirmLabel="Remove wrapper"
        onConfirm={() => { setConfirmRemove(false); void handleRemoveWrapper(); }}
        onCancel={() => setConfirmRemove(false)}
      />
      {diffEntries.length > 0 && (
        <div className="mt-2.5">
          <div className={settingsLabel}>Default MCPs for new agents</div>
          {diffEntries.map((entry) => {
            const checked = defaultMcps.includes(entry.id);
            const stateWord = MCP_STATE_WORDS[entry.state as keyof typeof MCP_STATE_WORDS];
            return (
              <label
                key={entry.id}
                className="flex items-center gap-2 h-[30px] border-t border-surface-0 cursor-pointer"
                title={entry.description}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleMcp(entry.id)}
                  className="w-3.5 h-3.5 flex-shrink-0 accent-ctp-accent"
                />
                <span className="text-[13px] text-ctp-text truncate">{entry.name}</span>
                {stateWord && (
                  <span className={`text-xs flex-shrink-0 ${stateWord.cls}`}>{stateWord.label}</span>
                )}
              </label>
            );
          })}
          <p className={`${settingsHelp} pt-2 border-t border-surface-0`}>
            Set per-MCP parameters in each agent&apos;s settings.
          </p>
        </div>
      )}
    </SettingsSection>
  );
}

const MCP_STATE_WORDS = {
  new: { label: 'New', cls: 'text-ctp-success' },
  changed: { label: 'Changed', cls: 'text-ctp-warning' },
  removed: { label: 'Removed from the catalog', cls: 'text-ctp-error' },
} as const;

/** "a", "a and b", "a, b and c". */
function joinCounts(parts: string[]): string {
  const list = parts.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function BlueprintBundleSection({ projectId, projectPath, projectName }: { projectId: string; projectPath: string; projectName: string }) {
  const [showExportDialog, setShowExportDialog] = useState(false);

  return (
    <>
      <SettingsSection title="Blueprint bundle">
        <SettingsField
          label="Export canvases"
          help="Every canvas in this project as one bundle, for sharing or backup."
        >
          <Button
            onClick={() => setShowExportDialog(true)}
            kind="ghost"
            data-testid="export-bundle-button"
          >
            Export…
          </Button>
        </SettingsField>
      </SettingsSection>

      {showExportDialog && (
        <BlueprintBundleExportDialogLoader
          projectId={projectId}
          projectPath={projectPath}
          projectName={projectName}
          onClose={() => setShowExportDialog(false)}
        />
      )}
    </>
  );
}

/** Lazy-loads stores and renders the ExportBundleDialog. */
function BlueprintBundleExportDialogLoader({
  projectId,
  projectPath,
  projectName,
  onClose,
}: {
  projectId: string;
  projectPath: string;
  projectName: string;
  onClose: () => void;
}) {
  const [DialogComponent, setDialogComponent] = useState<any>(null);
  const [canvases, setCanvases] = useState<any[]>([]);
  const [agents, setAgents] = useState<Record<string, any>>({});
  const [projects, setProjects] = useState<Record<string, any>>({});
  const [wireDefinitions, setWireDefinitions] = useState<any[]>([]);

  useEffect(() => {
    // Dynamic imports to avoid circular dependencies
    Promise.all([
      import('../blueprints/ExportBundleDialog'),
      import('../../plugins/builtin/canvas/main'),
      import('../../stores/agentStore'),
      import('../../stores/projectStore'),
    ]).then(([dialogMod, canvasMod, agentMod, projMod]) => {
      const store = canvasMod.getProjectCanvasStore(projectId);
      setCanvases(store.getState().canvases);
      setWireDefinitions(store.getState().wireDefinitions);
      setAgents(agentMod.useAgentStore.getState().agents);
      setProjects(Object.fromEntries(projMod.useProjectStore.getState().projects.map((p: any) => [p.id, p])));
      setDialogComponent(() => dialogMod.ExportBundleDialog);
    });
  }, [projectId]);

  if (!DialogComponent) return null;

  return (
    <DialogComponent
      canvases={canvases}
      agents={agents}
      projects={projects}
      wireDefinitions={wireDefinitions}
      projectId={projectId}
      projectPath={projectPath}
      projectName={projectName}
      onClose={onClose}
    />
  );
}

function RemoveProjectSection({ projectId, projectPath, projectName }: { projectId: string; projectPath: string; projectName: string }) {
  const removeProject = useProjectStore((s) => s.removeProject);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const [showResetDialog, setShowResetDialog] = useState(false);

  const handleClose = async () => {
    const { promise } = showConfirmDialog('Close this project? Project-specific settings may need to be reconfigured.');
    if (!(await promise)) return;
    toggleSettings();
    removeProject(projectId);
  };

  const handleReset = async () => {
    await window.clubhouse.project.resetProject(projectPath);
    toggleSettings();
    removeProject(projectId);
  };

  return (
    <>
      <SettingsSection title="Remove project">
        <SettingsField label="Close project" help={`Removes ${projectName} from the sidebar. Files on disk stay.`}>
          <Button onClick={handleClose} kind="ghost">
            Close…
          </Button>
        </SettingsField>
        <SettingsField label="Reset project" help="Also deletes the .clubhouse folder: agents, canvases and settings.">
          <Button onClick={() => setShowResetDialog(true)} kind="danger">
            Reset…
          </Button>
        </SettingsField>
      </SettingsSection>

      {showResetDialog && (
        <ResetProjectDialog
          projectName={projectName}
          projectPath={projectPath}
          onConfirm={handleReset}
          onCancel={() => setShowResetDialog(false)}
        />
      )}
    </>
  );
}

export function ProjectSettings({ projectId }: { projectId?: string }) {
  const { projects, activeProjectId } = useProjectStore();
  const id = projectId ?? activeProjectId;
  const project = projects.find((p) => p.id === id);

  if (!project) {
    return <div className="p-4 text-ctp-subtext0 text-sm">Select a project</div>;
  }

  const name = project.displayName || project.name;

  return (
    <SettingsPage
      title={name}
      description={<>Project settings · <span className="font-mono" title={project.path}>{project.path}</span></>}
    >
      <div className="mt-4">
        <NameField projectId={project.id} />
        <AppearanceFields projectId={project.id} />
      </div>
      <LaunchWrapperSection projectId={project.id} projectPath={project.path} />
      <BlueprintBundleSection projectId={project.id} projectPath={project.path} projectName={name} />
      <RemoveProjectSection projectId={project.id} projectPath={project.path} projectName={name} />
    </SettingsPage>
  );
}
