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

function NameAndPathSection({ projectId }: { projectId: string }) {
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
    <div className="space-y-2 mb-6">
      <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider">Name</label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder={project.name}
          className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
            text-ctp-text placeholder:text-ctp-subtext0/40
            focus-ring-dim"
        />
        {dirty && (
          <button
            onClick={save}
            className="px-3 py-1.5 text-xs rounded-lg bg-ctp-accent/20 border border-ctp-accent/40
              text-ctp-accent hover:bg-ctp-accent/30 cursor-pointer transition-colors"
          >
            Save
          </button>
        )}
      </div>
      <p className="text-xs text-ctp-subtext0 font-mono truncate" title={project.path}>{project.path}</p>
    </div>
  );
}

function AppearanceSection({ projectId }: { projectId: string }) {
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
    <div className="space-y-4 mb-6">
      {/* Icon */}
      <div>
        <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">Icon</label>
        <div className="flex items-center gap-3 relative">
          <div className="w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0"
            style={hasImage ? undefined : hasEmoji ? { backgroundColor: `${hex}15` } : { backgroundColor: `${hex}20`, color: hex }}
          >
            {hasEmoji ? (
              <span className="text-2xl" role="img">{project.emoji}</span>
            ) : hasImage ? (
              <img src={iconDataUrl} alt={label} className="w-full h-full object-cover" />
            ) : (
              <span className="text-xl font-bold">{label.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <button
            onClick={handlePickImage}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
              text-ctp-text hover:bg-surface-1 cursor-pointer transition-colors"
          >
            Choose Image
          </button>
          <button
            ref={emojiButtonRef}
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
              text-ctp-text hover:bg-surface-1 cursor-pointer transition-colors"
          >
            Choose Emoji
          </button>
          {(hasImage || hasEmoji) && (
            <button
              onClick={handleRemoveIcon}
              className="px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
                text-ctp-subtext0 hover:text-ctp-error hover:border-ctp-error/50 cursor-pointer transition-colors"
            >
              Remove
            </button>
          )}
          {showEmojiPicker && (
            <div className="absolute top-12 left-0 z-dropdown">
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmojiPicker(false)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Image crop dialog */}
      {cropImageDataUrl && (
        <ImageCropDialog
          imageDataUrl={cropImageDataUrl}
          maskShape="square"
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}

      {/* Color */}
      <div>
        <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">Color</label>
        <div className="flex items-center gap-2">
          {AGENT_COLORS.map((c) => {
            const isSelected = project.color === c.id || (!project.color && c.id === 'indigo');
            return (
              <button
                key={c.id}
                title={c.label}
                onClick={() => updateProject(project.id, { color: c.id })}
                className={`
                  w-7 h-7 rounded-full flex items-center justify-center cursor-pointer
                  transition-all duration-150
                  ${isSelected ? 'ring-2 ring-offset-2 ring-offset-ctp-base' : 'hover:scale-110'}
                `}
                style={{
                  backgroundColor: c.hex,
                  ...(isSelected ? { ringColor: c.hex } : {}),
                }}
              >
                {isSelected && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LaunchWrapperSection({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const [wrapper, setWrapper] = useState<LaunchWrapperConfig | undefined>(undefined);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [defaultMcps, setDefaultMcps] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<WrapperCatalogSnapshot | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
      <div className="mb-6">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Launch Wrapper</h3>
        <p className="text-xs text-ctp-subtext0">
          No launch wrapper configured. A plugin can set one up automatically.
        </p>
      </div>
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

  return (
    <div className="mb-6">
      <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Launch Wrapper</h3>
      <div className="rounded-lg border border-surface-2 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-ctp-success" />
            <span className="text-sm text-ctp-text font-mono">{wrapper.binary}</span>
            {wrapper.refreshCommandId && (
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                title="Refresh catalog"
                className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-wait"
              >
                {refreshing ? '…' : '⟳'} Refresh
              </button>
            )}
          </div>
          <button
            onClick={handleRemoveWrapper}
            className="text-xs text-ctp-subtext0 hover:text-ctp-error cursor-pointer transition-colors"
          >
            Remove
          </button>
        </div>
        {hasDiff && (
          <div className="flex items-center justify-between rounded border border-ctp-yellow/30 bg-ctp-yellow/10 px-2 py-1.5 text-xs text-ctp-yellow">
            <span>
              {[
                newCount && `${newCount} new`,
                changedCount && `${changedCount} changed`,
                removedCount && `${removedCount} removed`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <button
              onClick={handleAcknowledge}
              className="text-xs text-ctp-yellow hover:text-ctp-yellow/70 cursor-pointer"
            >
              Got it
            </button>
          </div>
        )}
        {diffEntries.length > 0 && (
          <div>
            <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
              Default MCPs
            </label>
            <div className="grid grid-cols-2 gap-1">
              {diffEntries.map((entry) => {
                const checked = defaultMcps.includes(entry.id);
                const isRemoved = entry.state === 'removed';
                return (
                  <label
                    key={entry.id}
                    className={`flex items-center gap-2 py-1 px-2 rounded hover:bg-surface-0 cursor-pointer ${
                      isRemoved ? 'opacity-70' : ''
                    }`}
                    title={entry.description}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMcp(entry.id)}
                      className="w-3.5 h-3.5 rounded border-surface-2 bg-surface-0 text-ctp-accent focus:ring-ctp-accent"
                    />
                    <span className="text-xs text-ctp-text truncate flex items-center gap-1.5">
                      {entry.name}
                      {entry.state === 'new' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-green/15 text-ctp-green uppercase tracking-wider">new</span>
                      )}
                      {entry.state === 'changed' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-yellow/15 text-ctp-yellow uppercase tracking-wider">changed</span>
                      )}
                      {entry.state === 'removed' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-red/15 text-ctp-red uppercase tracking-wider">removed</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-[10px] text-ctp-subtext0/50 mt-1.5 italic">
              Configure per-MCP parameters in each agent&apos;s settings.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function BlueprintBundleSection({ projectId, projectPath, projectName }: { projectId: string; projectPath: string; projectName: string }) {
  const [showExportDialog, setShowExportDialog] = useState(false);

  return (
    <>
      <div className="mb-6 rounded-lg border border-surface-0 p-4 space-y-3">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Blueprint Bundle</h3>
        <p className="text-xs text-ctp-subtext0">Export all canvases in this project as a single blueprint bundle for sharing or backup.</p>
        <button
          onClick={() => setShowExportDialog(true)}
          className="px-4 py-2 text-sm rounded-lg bg-surface-1 border border-surface-2 text-ctp-text hover:bg-surface-2 cursor-pointer transition-colors"
          data-testid="export-bundle-button"
        >
          Export All Canvases as Bundle
        </button>
      </div>

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

function DangerZone({ projectId, projectPath, projectName }: { projectId: string; projectPath: string; projectName: string }) {
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
      <div className="rounded-lg border border-ctp-error/30 p-4 space-y-3">
        <h3 className="text-xs text-ctp-error uppercase tracking-wider">Danger Zone</h3>
        <div className="flex items-center gap-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm rounded-lg bg-ctp-error/10 border border-ctp-error/30
              text-ctp-error hover:bg-ctp-error/20 cursor-pointer transition-colors"
          >
            Close Project
          </button>
          <button
            onClick={() => setShowResetDialog(true)}
            className="px-4 py-2 text-sm rounded-lg bg-ctp-error/10 border border-ctp-error/30
              text-ctp-error hover:bg-ctp-error/20 cursor-pointer transition-colors"
          >
            Reset Project
          </button>
        </div>
        <p className="text-xs text-ctp-subtext0">
          Close removes the project from Clubhouse. Reset also deletes all <span className="font-mono">.clubhouse/</span> data.
        </p>
      </div>

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

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-4">Project Settings</h2>
        <NameAndPathSection projectId={project.id} />
        <AppearanceSection projectId={project.id} />
        <LaunchWrapperSection projectId={project.id} projectPath={project.path} />
        <BlueprintBundleSection projectId={project.id} projectPath={project.path} projectName={project.displayName || project.name} />
        <DangerZone projectId={project.id} projectPath={project.path} projectName={project.displayName || project.name} />
      </div>
    </div>
  );
}
