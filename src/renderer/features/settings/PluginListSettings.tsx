import { useState, useRef, useEffect, useCallback } from 'react';
import { usePluginStore } from '../../plugins/plugin-store';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';
import { activatePlugin, deactivatePlugin, discoverNewPlugins, approvePluginPermissions, rejectPluginPermissions } from '../../plugins/plugin-loader';
import type { PluginPermission, PermissionRiskLevel, PluginRegistryEntry } from '../../../shared/plugin-types';
import { PERMISSION_DESCRIPTIONS, PERMISSION_RISK_LEVELS } from '../../../shared/plugin-types';
import type { CustomMarketplace } from '../../../shared/marketplace-types';
import { PluginMarketplaceDialog } from './PluginMarketplaceDialog';

const RISK_ORDER: Record<PermissionRiskLevel, number> = { safe: 0, elevated: 1, dangerous: 2 };

const RISK_COLORS: Record<PermissionRiskLevel, string> = {
  safe: 'bg-green-500/20 text-green-400',
  elevated: 'bg-yellow-500/20 text-yellow-400',
  dangerous: 'bg-red-500/20 text-red-400',
};

function sortPermissionsByRisk(perms: PluginPermission[]): PluginPermission[] {
  return [...perms].sort((a, b) => {
    const ra = PERMISSION_RISK_LEVELS[a] ?? 'safe';
    const rb = PERMISSION_RISK_LEVELS[b] ?? 'safe';
    return RISK_ORDER[ra] - RISK_ORDER[rb];
  });
}

const CROSS_PROJECT_PERMISSIONS: readonly PluginPermission[] = [
  'agent-config.cross-project',
  'workspace.cross-project',
];

const POPUP_ESTIMATED_HEIGHT = 200;

function PermissionInfoPopup({ entry }: { entry: PluginRegistryEntry }) {
  const [open, setOpen] = useState(false);
  const [flipAbove, setFlipAbove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const permissions = entry.manifest.permissions;
  if (!permissions || permissions.length === 0) return null;

  const isAppScoped = entry.manifest.scope === 'app';
  const hasCrossProjectPerm = permissions.some((p) => CROSS_PROJECT_PERMISSIONS.includes(p));

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setFlipAbove(rect.bottom + POPUP_ESTIMATED_HEIGHT > window.innerHeight);
    }
    setOpen(!open);
  };

  const rect = btnRef.current?.getBoundingClientRect();
  const sorted = sortPermissionsByRisk(permissions);

  const popupStyle: React.CSSProperties | undefined = rect
    ? flipAbove
      ? { bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right }
      : { top: rect.bottom + 4, right: window.innerWidth - rect.right }
    : undefined;

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        className="flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold text-ctp-subtext0 hover:text-ctp-text bg-surface-1 hover:bg-surface-2 cursor-pointer"
        title="View permissions"
      >
        i
      </button>
      {open && (
        <div
          data-testid="permission-popup"
          className="fixed z-50 w-72 p-3 rounded-lg bg-ctp-mantle border border-surface-1 shadow-lg"
          style={popupStyle}
        >
          <p className="text-xs font-semibold text-ctp-subtext1 mb-2">Permissions</p>
          {isAppScoped && hasCrossProjectPerm && (
            <p className="text-[10px] text-ctp-peach mb-2" data-testid="app-scope-cross-project-note">
              This is an app-scoped plugin — cross-project access is implicit and does not require per-project enablement.
            </p>
          )}
          <div className="space-y-1.5">
            {sorted.map((perm: PluginPermission) => {
              const risk = PERMISSION_RISK_LEVELS[perm];
              const isCrossProject = CROSS_PROJECT_PERMISSIONS.includes(perm);
              return (
                <div key={perm}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono text-ctp-accent">{perm}</span>
                    {risk !== 'safe' && (
                      <span className={`text-[9px] px-1 py-0.5 rounded font-medium uppercase ${RISK_COLORS[risk]}`}>
                        {risk}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-ctp-subtext0">
                    {isAppScoped && isCrossProject
                      ? PERMISSION_DESCRIPTIONS[perm].replace(
                          /where the plugin is (?:also )?enabled/,
                          'across all projects (app-scoped — no bilateral consent required)',
                        )
                      : PERMISSION_DESCRIPTIONS[perm]}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceBadge({ entry }: { entry: PluginRegistryEntry }) {
  if (entry.source === 'builtin') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-accent/20 text-ctp-accent">Built-in</span>
    );
  }
  if (entry.source === 'marketplace') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">Official</span>
    );
  }
  if (entry.source === 'community') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0">Community</span>
    );
  }
  return null;
}

/** Phase label for inline update progress. */
const UPDATE_PHASE_LABELS: Record<string, string> = {
  downloading: 'Downloading...',
  installing: 'Installing...',
  reloading: 'Reloading...',
};

/** What a plugin has injected into a specific project. */
interface ProjectInjections {
  skills: string[];
  agentTemplates: string[];
  hasInstructions: boolean;
  permissionAllowCount: number;
  permissionDenyCount: number;
  mcpServerNames: string[];
}

function hasAnyInjections(inj: ProjectInjections): boolean {
  return (
    inj.skills.length > 0 ||
    inj.agentTemplates.length > 0 ||
    inj.hasInstructions ||
    inj.permissionAllowCount > 0 ||
    inj.permissionDenyCount > 0 ||
    inj.mcpServerNames.length > 0
  );
}

/**
 * Banner shown in project context when orphaned injections from uninstalled plugins
 * are detected. Provides a one-click cleanup for each orphaned plugin.
 */
function OrphanInjectionsBanner({
  projectPath,
  knownPluginIds,
}: {
  projectPath: string;
  knownPluginIds: string[];
}) {
  const [orphans, setOrphans] = useState<string[] | null>(null);
  const [cleaning, setCleaning] = useState<string | null>(null);

  const knownPluginIdsSerialized = JSON.stringify(knownPluginIds.slice().sort());
  const load = useCallback(async () => {
    try {
      const ids = await window.clubhouse.plugin.listOrphanedPluginIds(projectPath, knownPluginIds);
      setOrphans(ids);
    } catch {
      setOrphans([]);
    }
  }, [projectPath, knownPluginIdsSerialized]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  if (!orphans || orphans.length === 0) return null;

  const handleClean = async (pluginId: string) => {
    setCleaning(pluginId);
    try {
      await window.clubhouse.plugin.cleanupProjectInjections(pluginId, projectPath);
      await load();
    } catch {
      // ignore
    } finally {
      setCleaning(null);
    }
  };

  const handleCleanAll = async () => {
    for (const id of orphans) {
      setCleaning(id);
      try {
        await window.clubhouse.plugin.cleanupProjectInjections(id, projectPath);
      } catch { /* ignore */ }
    }
    setCleaning(null);
    await load();
  };

  return (
    <div
      className="mb-4 p-3 rounded-lg bg-ctp-peach/5 border border-ctp-peach/30"
      data-testid="orphan-injections-banner"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-ctp-peach mb-1">
            Orphaned plugin injections detected
          </p>
          <p className="text-[11px] text-ctp-subtext0 mb-2">
            The following uninstalled plugins left injections (skills, instructions, permissions, or MCP servers) in this project:
          </p>
          <div className="flex flex-wrap gap-2">
            {orphans.map((id) => (
              <div key={id} className="flex items-center gap-1">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ctp-peach/20 text-ctp-peach">{id}</span>
                <button
                  onClick={() => handleClean(id)}
                  disabled={cleaning !== null}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer disabled:opacity-50"
                  data-testid={`clean-orphan-btn-${id}`}
                >
                  {cleaning === id ? 'Cleaning…' : 'Clean up'}
                </button>
              </div>
            ))}
          </div>
        </div>
        {orphans.length > 1 && (
          <button
            onClick={handleCleanAll}
            disabled={cleaning !== null}
            className="shrink-0 text-[11px] px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer disabled:opacity-50"
            data-testid="clean-all-orphans-btn"
          >
            {cleaning ? 'Cleaning…' : 'Clean all'}
          </button>
        )}
      </div>
    </div>
  );
}

function PluginInjectionsPanel({
  pluginId,
  projectPath,
  onCleaned,
}: {
  pluginId: string;
  projectPath: string;
  onCleaned?: () => void;
}) {
  const [injections, setInjections] = useState<ProjectInjections | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanError, setCleanError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await window.clubhouse.plugin.listProjectInjections(pluginId, projectPath);
      setInjections(data);
    } catch {
      setInjections(null);
    }
  }, [pluginId, projectPath]);

  useEffect(() => {
    load();
  }, [load]);

  if (!injections || !hasAnyInjections(injections)) return null;

  const handleClean = async () => {
    setCleaning(true);
    setCleanError(null);
    try {
      await window.clubhouse.plugin.cleanupProjectInjections(pluginId, projectPath);
      await load();
      onCleaned?.();
    } catch (err) {
      setCleanError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div
      className="mt-2 p-2 rounded bg-surface-0 border border-surface-1 text-[11px] text-ctp-subtext0"
      data-testid={`injections-panel-${pluginId}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-ctp-subtext1">Active injections in this project</span>
        <button
          onClick={handleClean}
          disabled={cleaning}
          className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer disabled:opacity-50"
          data-testid={`clean-injections-btn-${pluginId}`}
        >
          {cleaning ? 'Cleaning...' : 'Remove all'}
        </button>
      </div>
      {cleanError && (
        <p className="text-[10px] text-red-400 mb-1">{cleanError}</p>
      )}
      <ul className="space-y-0.5 list-disc list-inside">
        {injections.skills.map((s) => (
          <li key={`skill-${s}`}>Skill: <span className="font-mono text-ctp-text">{s}</span></li>
        ))}
        {injections.agentTemplates.map((t) => (
          <li key={`tpl-${t}`}>Agent template: <span className="font-mono text-ctp-text">{t}</span></li>
        ))}
        {injections.hasInstructions && <li>Agent instructions block</li>}
        {injections.permissionAllowCount > 0 && (
          <li>{injections.permissionAllowCount} allow permission rule{injections.permissionAllowCount !== 1 ? 's' : ''}</li>
        )}
        {injections.permissionDenyCount > 0 && (
          <li>{injections.permissionDenyCount} deny permission rule{injections.permissionDenyCount !== 1 ? 's' : ''}</li>
        )}
        {injections.mcpServerNames.map((m) => (
          <li key={`mcp-${m}`}>MCP server: <span className="font-mono text-ctp-text">{m}</span></li>
        ))}
      </ul>
    </div>
  );
}

function PluginRow({
  entry,
  enabled,
  onToggle,
  onOpenSettings,
  onUninstall,
  onUpdate,
  hasSettings,
  updateVersion,
  updatePhase,
  updateError,
  projectPath,
}: {
  entry: PluginRegistryEntry;
  enabled: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
  onUninstall?: () => void;
  onUpdate?: () => void;
  hasSettings: boolean;
  updateVersion?: string;
  updatePhase?: string;
  updateError?: string;
  /** When set, shows the injections panel for this project */
  projectPath?: string;
}) {
  const isIncompatible = entry.status === 'incompatible';
  const isErrored = entry.status === 'errored';
  const isPendingApproval = entry.status === 'pending-approval';
  const isUpdating = !!updatePhase;

  return (
    <div className={`py-3 px-4 rounded-lg bg-ctp-mantle border ${isPendingApproval ? 'border-ctp-peach/40' : 'border-surface-0'}`}>
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ctp-text">{entry.manifest.name}</span>
            <span className="text-xs text-ctp-subtext0">v{entry.manifest.version}</span>
            <SourceBadge entry={entry} />
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-overlay1">API {entry.manifest.engine.api}</span>
            <PermissionInfoPopup entry={entry} />
            {isIncompatible && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Incompatible</span>
            )}
            {isErrored && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Error</span>
            )}
            {isPendingApproval && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-peach/20 text-ctp-peach" data-testid={`pending-badge-${entry.manifest.id}`}>
                New permissions
              </span>
            )}
            {updateVersion && !isUpdating && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-success/20 text-ctp-success" data-testid={`update-badge-${entry.manifest.id}`}>
                v{updateVersion} available
              </span>
            )}
            {isUpdating && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-accent/20 text-ctp-accent animate-pulse" data-testid={`update-phase-${entry.manifest.id}`}>
                {UPDATE_PHASE_LABELS[updatePhase] || 'Updating...'}
              </span>
            )}
          </div>
          {entry.manifest.description && (
            <p className="text-xs text-ctp-subtext0 mt-0.5 truncate">{entry.manifest.description}</p>
          )}
          {updateError && (
            <p className="text-xs text-ctp-peach mt-0.5">Update failed: {updateError}</p>
          )}
          {entry.error && (() => {
            const newlineIdx = entry.error.indexOf('\n');
            const message = newlineIdx >= 0 ? entry.error.slice(0, newlineIdx) : entry.error;
            const stack = newlineIdx >= 0 ? entry.error.slice(newlineIdx + 1) : null;
            return (
              <div className="mt-1">
                <p className="text-xs text-red-400">{message}</p>
                {stack && (
                  <details className="mt-1">
                    <summary className="text-[10px] text-red-400/70 cursor-pointer">View details</summary>
                    <pre className="text-[10px] text-red-400/70 bg-surface-0 p-2 rounded mt-1 overflow-auto max-h-32 whitespace-pre-wrap">{stack}</pre>
                  </details>
                )}
              </div>
            );
          })()}
          {isPendingApproval && entry.pendingPermissions && (
            <div className="mt-2 p-2 rounded bg-ctp-peach/5 border border-ctp-peach/20" data-testid={`pending-approval-${entry.manifest.id}`}>
              <p className="text-xs text-ctp-peach font-medium mb-1">
                This update requires new permissions:
              </p>
              <div className="flex flex-wrap gap-1 mb-2">
                {entry.pendingPermissions.map((perm) => {
                  const risk = PERMISSION_RISK_LEVELS[perm];
                  return (
                    <span
                      key={perm}
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                        risk === 'dangerous'
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-yellow-500/20 text-yellow-400'
                      }`}
                    >
                      {perm}
                    </span>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => approvePluginPermissions(entry.manifest.id)}
                  className="text-[11px] px-2 py-1 rounded bg-ctp-accent/20 text-ctp-accent hover:bg-ctp-accent/30 cursor-pointer"
                  data-testid={`approve-btn-${entry.manifest.id}`}
                >
                  Approve & Activate
                </button>
                <button
                  onClick={() => rejectPluginPermissions(entry.manifest.id)}
                  className="text-[11px] px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 cursor-pointer"
                  data-testid={`reject-btn-${entry.manifest.id}`}
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 ml-3 shrink-0">
          {onUpdate && updateVersion && !isUpdating && (
            <button
              onClick={onUpdate}
              className="text-[11px] px-2 py-1 rounded bg-ctp-success/20 text-ctp-success hover:bg-ctp-success/30 cursor-pointer"
              title={`Update to v${updateVersion}`}
              data-testid={`update-btn-${entry.manifest.id}`}
            >
              Update
            </button>
          )}
          {enabled && hasSettings && (
            <button
              onClick={onOpenSettings}
              className="p-1.5 rounded hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
              title="Plugin settings"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          {onUninstall && (
            <button
              onClick={onUninstall}
              className="p-1.5 rounded hover:bg-red-500/10 text-ctp-subtext0 hover:text-red-400 cursor-pointer"
              title="Uninstall plugin"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
          <button
            onClick={onToggle}
            disabled={isIncompatible}
            className={`
              relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
              ${isIncompatible ? 'opacity-50 cursor-not-allowed' : ''}
              ${enabled ? 'bg-ctp-accent' : 'bg-surface-2'}
            `}
          >
            <span
              className={`
                absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200
                ${enabled ? 'translate-x-4' : 'translate-x-0'}
              `}
            />
          </button>
        </div>
      </div>
      {projectPath && (
        <PluginInjectionsPanel
          pluginId={entry.manifest.id}
          projectPath={projectPath}
        />
      )}
    </div>
  );
}

function CustomMarketplaceManager() {
  const [marketplaces, setMarketplaces] = useState<CustomMarketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const loadMarketplaces = async () => {
    try {
      const list = await window.clubhouse.marketplace.listCustomMarketplaces();
      setMarketplaces(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMarketplaces();
  }, []);

  const handleAdd = async () => {
    if (!addName.trim() || !addUrl.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await window.clubhouse.marketplace.addCustomMarketplace({
        name: addName.trim(),
        url: addUrl.trim(),
      });
      setAddName('');
      setAddUrl('');
      await loadMarketplaces();
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : 'Failed to add marketplace');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    const m = marketplaces.find((x) => x.id === id);
    if (!m) return;
    const confirmed = window.confirm(`Remove custom marketplace "${m.name}"?`);
    if (!confirmed) return;
    try {
      await window.clubhouse.marketplace.removeCustomMarketplace({ id });
      await loadMarketplaces();
    } catch {
      // ignore
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await window.clubhouse.marketplace.toggleCustomMarketplace({ id, enabled });
      await loadMarketplaces();
    } catch {
      // ignore
    }
  };

  if (loading) return null;

  return (
    <div className="mb-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs font-semibold text-ctp-subtext1 uppercase tracking-wider cursor-pointer hover:text-ctp-text"
        data-testid="custom-marketplace-toggle"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        Custom Plugin Stores ({marketplaces.length})
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ctp-subtext0">
            Register private or third-party plugin registries for automatic discovery, install, and updates.
            Each store should host a <code className="text-xs font-mono bg-surface-0 px-1 py-0.5 rounded">registry.json</code> following the Workshop format.
          </p>

          {/* Existing marketplaces */}
          {marketplaces.length > 0 && (
            <div className="space-y-2">
              {marketplaces.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0"
                  data-testid={`custom-marketplace-${m.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ctp-text">{m.name}</span>
                      {!m.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0">Disabled</span>
                      )}
                    </div>
                    <p className="text-[10px] text-ctp-subtext0 truncate mt-0.5" title={m.url}>{m.url}</p>
                  </div>
                  <div className="flex items-center gap-2 ml-3">
                    <button
                      onClick={() => handleRemove(m.id)}
                      className="p-1 rounded hover:bg-red-500/10 text-ctp-subtext0 hover:text-red-400 cursor-pointer"
                      title="Remove marketplace"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleToggle(m.id, !m.enabled)}
                      className={`
                        relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
                        ${m.enabled ? 'bg-ctp-accent' : 'bg-surface-2'}
                      `}
                    >
                      <span
                        className={`
                          absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200
                          ${m.enabled ? 'translate-x-4' : 'translate-x-0'}
                        `}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add form */}
          <div className="p-3 rounded-lg bg-surface-0 border border-surface-1 space-y-2">
            <p className="text-xs font-medium text-ctp-subtext1">Add Custom Plugin Store</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Store name"
                className="flex-1 px-2 py-1.5 rounded bg-ctp-base border border-surface-1 text-xs text-ctp-text placeholder-ctp-subtext0 outline-none focus:border-ctp-accent"
                data-testid="custom-marketplace-name"
              />
              <input
                type="text"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                placeholder="Registry URL (e.g. https://...registry.json)"
                className="flex-[2] px-2 py-1.5 rounded bg-ctp-base border border-surface-1 text-xs text-ctp-text placeholder-ctp-subtext0 outline-none focus:border-ctp-accent"
                data-testid="custom-marketplace-url"
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              />
              <button
                onClick={handleAdd}
                disabled={adding || !addName.trim() || !addUrl.trim()}
                className="px-3 py-1.5 rounded bg-ctp-accent text-white text-xs font-medium hover:bg-ctp-accent/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="custom-marketplace-add"
              >
                {adding ? 'Adding...' : 'Add'}
              </button>
            </div>
            {addError && (
              <p className="text-xs text-red-400">{addError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PluginListSettings() {
  const plugins = usePluginStore((s) => s.plugins);
  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const externalPluginsEnabled = usePluginStore((s) => s.externalPluginsEnabled);
  const enableForProject = usePluginStore((s) => s.enableForProject);
  const disableForProject = usePluginStore((s) => s.disableForProject);
  const enableApp = usePluginStore((s) => s.enableApp);
  const disableApp = usePluginStore((s) => s.disableApp);
  const setExternalPluginsEnabled = usePluginStore((s) => s.setExternalPluginsEnabled);
  const openPluginSettings = useUIStore((s) => s.openPluginSettings);
  const settingsContext = useUIStore((s) => s.settingsContext);
  const _activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);

  // Plugin update state
  const updates = usePluginUpdateStore((s) => s.updates);
  const updating = usePluginUpdateStore((s) => s.updating);
  const updateErrors = usePluginUpdateStore((s) => s.updateErrors);
  const checking = usePluginUpdateStore((s) => s.checking);
  const lastCheck = usePluginUpdateStore((s) => s.lastCheck);
  const checkForUpdates = usePluginUpdateStore((s) => s.checkForUpdates);
  const updatePlugin = usePluginUpdateStore((s) => s.updatePlugin);
  const updateAll = usePluginUpdateStore((s) => s.updateAll);

  const [restartHint, setRestartHint] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const isAppContext = settingsContext === 'app';
  const projectId = isAppContext ? undefined : settingsContext;
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;

  const allPlugins = Object.values(plugins);
  const filteredPlugins = allPlugins.filter((entry) => {
    if (isAppContext) {
      return true;
    }
    const scopeMatch = entry.manifest.scope === 'project' || entry.manifest.scope === 'dual';
    return scopeMatch && appEnabled.includes(entry.manifest.id);
  });

  // Split into builtin and external sections (local computation, safe from Zustand gotcha)
  const builtinPlugins = filteredPlugins.filter((e) => e.source === 'builtin');
  const externalPlugins = filteredPlugins.filter((e) => e.source === 'community' || e.source === 'marketplace');

  const isEnabled = (pluginId: string): boolean => {
    if (isAppContext) {
      return appEnabled.includes(pluginId);
    }
    return projectId ? (projectEnabled[projectId] || []).includes(pluginId) : false;
  };

  const handleToggle = async (pluginId: string) => {
    const enabled = isEnabled(pluginId);
    if (enabled) {
      if (isAppContext) {
        await deactivatePlugin(pluginId);
        disableApp(pluginId);
      } else if (projectId) {
        await deactivatePlugin(pluginId, projectId);
        disableForProject(projectId, pluginId);
      }
      // Persist
      try {
        const key = isAppContext ? 'app-enabled' : `project-enabled-${projectId}`;
        const currentList = isAppContext
          ? appEnabled.filter((id) => id !== pluginId)
          : (projectEnabled[projectId!] || []).filter((id) => id !== pluginId);
        await window.clubhouse.plugin.storageWrite({
          pluginId: '_system',
          scope: 'global',
          key,
          value: currentList,
        });
      } catch { /* ignore */ }
    } else {
      if (isAppContext) {
        const entry = usePluginStore.getState().plugins[pluginId];
        if (entry?.status === 'disabled') {
          usePluginStore.getState().setPluginStatus(pluginId, 'registered');
        }
        enableApp(pluginId);
        await activatePlugin(pluginId);
      } else if (projectId) {
        enableForProject(projectId, pluginId);
        const projectPath = project?.path;
        await activatePlugin(pluginId, projectId, projectPath);
      }
      // Persist
      try {
        const key = isAppContext ? 'app-enabled' : `project-enabled-${projectId}`;
        const currentList = isAppContext
          ? [...appEnabled, pluginId]
          : [...(projectEnabled[projectId!] || []), pluginId];
        await window.clubhouse.plugin.storageWrite({
          pluginId: '_system',
          scope: 'global',
          key,
          value: currentList,
        });
      } catch { /* ignore */ }
    }
  };

  const handleExternalToggle = async () => {
    const newValue = !externalPluginsEnabled;
    setExternalPluginsEnabled(newValue);
    setRestartHint(true);
    try {
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'external-plugins-enabled',
        value: newValue,
      });
    } catch { /* ignore */ }
  };

  const handleUninstall = async (pluginId: string) => {
    const entry = usePluginStore.getState().plugins[pluginId];
    if (!entry || entry.source === 'builtin') return;
    const confirmed = window.confirm(`Uninstall "${entry.manifest.name}"? This will delete the plugin and clean up all its project injections.`);
    if (!confirmed) return;
    // Deactivate first if active
    await deactivatePlugin(pluginId);
    disableApp(pluginId);
    // Clean up project-level injections across all known projects (best-effort)
    const allProjects = useProjectStore.getState().projects;
    for (const proj of allProjects) {
      if (proj.path) {
        try {
          await window.clubhouse.plugin.cleanupProjectInjections(pluginId, proj.path);
        } catch { /* ignore */ }
      }
    }
    // Delete plugin from disk
    await window.clubhouse.plugin.uninstall(pluginId);
    // Remove from store
    usePluginStore.getState().removePlugin(pluginId);
    // Persist updated app-enabled list
    try {
      const updatedAppEnabled = usePluginStore.getState().appEnabled;
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'app-enabled',
        value: updatedAppEnabled,
      });
    } catch { /* ignore */ }
  };

  const handleUninstallAll = async () => {
    if (externalPlugins.length === 0) return;
    const confirmed = window.confirm(`Uninstall all ${externalPlugins.length} external plugin(s)? This will delete them from disk and clean up their project injections.`);
    if (!confirmed) return;
    const allProjects = useProjectStore.getState().projects;
    for (const entry of externalPlugins) {
      await deactivatePlugin(entry.manifest.id);
      disableApp(entry.manifest.id);
      // Clean up project-level injections across all known projects (best-effort)
      for (const proj of allProjects) {
        if (proj.path) {
          try {
            await window.clubhouse.plugin.cleanupProjectInjections(entry.manifest.id, proj.path);
          } catch { /* ignore */ }
        }
      }
      await window.clubhouse.plugin.uninstall(entry.manifest.id);
      usePluginStore.getState().removePlugin(entry.manifest.id);
    }
    try {
      const updatedAppEnabled = usePluginStore.getState().appEnabled;
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'app-enabled',
        value: updatedAppEnabled,
      });
    } catch { /* ignore */ }
  };

  const handleScanNewPlugins = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const newIds = await discoverNewPlugins();
      if (newIds.length === 0) {
        setScanResult('No new plugins found.');
      } else {
        setScanResult(`Found ${newIds.length} new plugin(s): ${newIds.join(', ')}`);
      }
    } catch {
      setScanResult('Failed to scan for new plugins.');
    } finally {
      setScanning(false);
    }
  };

  const hasSettings = (entry: PluginRegistryEntry): boolean => {
    return !!(entry.manifest.settingsPanel || (entry.manifest.contributes?.settings && entry.manifest.contributes.settings.length > 0));
  };

  const getUpdateInfo = (pluginId: string) => updates.find((u) => u.pluginId === pluginId);

  const renderPluginList = (entries: PluginRegistryEntry[], showUninstall: boolean) => (
    <div className="space-y-2">
      {entries.map((entry) => {
        const updateInfo = getUpdateInfo(entry.manifest.id);
        const phase = updating[entry.manifest.id];
        const error = updateErrors[entry.manifest.id];
        return (
          <PluginRow
            key={entry.manifest.id}
            entry={entry}
            enabled={isEnabled(entry.manifest.id)}
            onToggle={() => handleToggle(entry.manifest.id)}
            onOpenSettings={() => openPluginSettings(entry.manifest.id)}
            onUninstall={showUninstall ? () => handleUninstall(entry.manifest.id) : undefined}
            onUpdate={updateInfo ? () => updatePlugin(entry.manifest.id) : undefined}
            hasSettings={hasSettings(entry)}
            updateVersion={updateInfo?.latestVersion}
            updatePhase={phase}
            updateError={error}
            projectPath={!isAppContext && project?.path ? project.path : undefined}
          />
        );
      })}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">
          {isAppContext ? 'Plugins' : 'Project Plugins'}
        </h2>
        <p className="text-xs text-ctp-subtext0 mb-4">
          {isAppContext
            ? 'Enable plugins to make them available. Project-scoped plugins also need to be enabled per project.'
            : `Enable plugins for ${project?.displayName || project?.name || 'this project'}. Only plugins enabled at the app level appear here.`}
        </p>
        {!isAppContext && (
          <p className="text-xs text-ctp-subtext0/70 mb-4 italic">
            To install or manage external plugins, go to the app-level Plugin settings.
          </p>
        )}
        {isAppContext && (
          <div className="mb-6">
            <p className="text-xs text-ctp-subtext0 mb-3">
              Discover and share plugins at the{' '}
              <a
                href="https://github.com/Agent-Clubhouse/Clubhouse-Workshop"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ctp-accent hover:underline"
                data-testid="workshop-link"
              >
                Clubhouse Workshop
              </a>.
            </p>
            <button
              onClick={() => setMarketplaceOpen(true)}
              className="px-3 py-1.5 rounded bg-ctp-accent text-white text-xs font-medium hover:bg-ctp-accent/90 cursor-pointer"
              data-testid="marketplace-button"
            >
              View Plugin Marketplace
            </button>
          </div>
        )}

        {/* Custom marketplace management (app context only) */}
        {isAppContext && <CustomMarketplaceManager />}

        {/* Orphaned injection banner (project context only) */}
        {!isAppContext && project?.path && (
          <OrphanInjectionsBanner
            projectPath={project.path}
            knownPluginIds={Object.keys(plugins)}
          />
        )}

        {/* Built-in section */}
        {builtinPlugins.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-ctp-subtext1 uppercase tracking-wider mb-3">Built-in</h3>
            {renderPluginList(builtinPlugins, false)}
          </>
        )}

        {/* Master switch + External section (app context only) */}
        {isAppContext && (
          <>
            <div className={`${builtinPlugins.length > 0 ? 'mt-6 pt-6 border-t border-surface-1' : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-xs font-semibold text-ctp-subtext1 uppercase tracking-wider">External</h3>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ctp-subtext0">Enable External Plugins</span>
                  <button
                    onClick={handleExternalToggle}
                    className={`
                      relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
                      ${externalPluginsEnabled ? 'bg-ctp-accent' : 'bg-surface-2'}
                    `}
                  >
                    <span
                      className={`
                        absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200
                        ${externalPluginsEnabled ? 'translate-x-4' : 'translate-x-0'}
                      `}
                    />
                  </button>
                </div>
              </div>
              <p className="text-xs text-ctp-subtext0 mb-3">
                Allow loading plugins from <code className="text-xs font-mono bg-surface-0 px-1 py-0.5 rounded">~/.clubhouse/plugins/</code>.
              </p>
              {restartHint && (
                <p className="text-xs text-ctp-peach mb-3">Restart Clubhouse for this change to take full effect.</p>
              )}
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <button
                  onClick={checkForUpdates}
                  disabled={checking}
                  className="text-[11px] px-2 py-1 rounded border border-ctp-success/30 text-ctp-success hover:bg-ctp-success/10 cursor-pointer disabled:opacity-50"
                  data-testid="check-updates-button"
                >
                  {checking ? 'Checking...' : 'Check for Updates'}
                </button>
                {updates.length > 1 && (
                  <button
                    onClick={updateAll}
                    disabled={Object.keys(updating).length > 0}
                    className="text-[11px] px-2 py-1 rounded border border-ctp-success/30 text-ctp-success hover:bg-ctp-success/10 cursor-pointer disabled:opacity-50"
                    data-testid="update-all-button"
                  >
                    Update All ({updates.length})
                  </button>
                )}
                <button
                  onClick={handleScanNewPlugins}
                  disabled={scanning}
                  className="text-[11px] px-2 py-1 rounded border border-ctp-accent/30 text-ctp-accent hover:bg-ctp-accent/10 cursor-pointer disabled:opacity-50"
                  data-testid="scan-plugins-button"
                >
                  {scanning ? 'Scanning...' : 'Reload Local Plugins'}
                </button>
                {externalPlugins.length > 0 && (
                  <button
                    onClick={handleUninstallAll}
                    className="text-[11px] px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer"
                  >
                    Uninstall All
                  </button>
                )}
              </div>
              {lastCheck && (
                <p className="text-[10px] text-ctp-subtext0/70 mb-2" data-testid="last-check-time">
                  Last checked: {new Date(lastCheck).toLocaleString()}
                </p>
              )}
              {scanResult && (
                <p className="text-xs text-ctp-subtext0 mb-3">{scanResult}</p>
              )}
            </div>

            {externalPlugins.length > 0 ? (
              renderPluginList(externalPlugins, true)
            ) : (
              <p className="text-xs text-ctp-subtext0">
                {externalPluginsEnabled
                  ? 'No external plugins installed. Place plugins in ~/.clubhouse/plugins/ and restart.'
                  : 'Enable external plugins above to discover and load community plugins.'}
              </p>
            )}
            <p className="text-xs text-ctp-subtext0/70 mt-3 italic">
              Some plugins may also need to be enabled per-project in that project's plugin settings.
            </p>
          </>
        )}

        {/* External section in project context (no master switch, no uninstall) */}
        {!isAppContext && externalPlugins.length > 0 && (
          <>
            {builtinPlugins.length > 0 && (
              <div className="mt-6 pt-6 border-t border-surface-1">
                <h3 className="text-xs font-semibold text-ctp-subtext1 uppercase tracking-wider mb-3">External</h3>
              </div>
            )}
            {renderPluginList(externalPlugins, false)}
          </>
        )}

        {/* Empty state when no plugins at all */}
        {filteredPlugins.length === 0 && (
          <p className="text-sm text-ctp-subtext0">
            No {isAppContext ? '' : 'project-scoped '}plugins installed.
            Place plugins in <code className="text-xs font-mono bg-surface-0 px-1 py-0.5 rounded">~/.clubhouse/plugins/</code> and restart.
          </p>
        )}
      </div>

      {marketplaceOpen && (
        <PluginMarketplaceDialog onClose={() => setMarketplaceOpen(false)} />
      )}
    </div>
  );
}
