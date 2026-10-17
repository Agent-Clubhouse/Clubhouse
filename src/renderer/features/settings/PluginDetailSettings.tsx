import { useUIStore } from '../../stores/uiStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { PluginAPIProvider } from '../../plugins/plugin-context';
import { createPluginAPI } from '../../plugins/plugin-api-factory';
import { getActiveContext } from '../../plugins/plugin-loader';
import { useProjectStore } from '../../stores/projectStore';
import { PluginSettingsRenderer } from '../../plugins/plugin-settings-renderer';
import { PluginErrorBoundary } from '../../panels/PluginContentView';
import type { PluginPermission, PermissionRiskLevel, PluginRegistryEntry } from '../../../shared/plugin-types';
import { PERMISSION_DESCRIPTIONS, PERMISSION_RISK_LEVELS } from '../../../shared/plugin-types';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, settingsHelp } from './SettingsLayout';
import { pluginMetaText, usePluginEnableToggle } from './PluginListSettings';
import { PluginStatusLines } from './PluginStatusLines';

const CROSS_PROJECT_PERMISSIONS: readonly PluginPermission[] = [
  'agent-config.cross-project',
  'workspace.cross-project',
];

/** Risk groups, most dangerous first. */
const RISK_GROUPS: { level: PermissionRiskLevel; title: string; help: string; titleClass: string }[] = [
  {
    level: 'dangerous',
    title: 'Can bypass safety',
    help: 'Can skip permission prompts, change permission rules or reach other projects.',
    titleClass: 'text-ctp-error',
  },
  {
    level: 'elevated',
    title: 'Can change things',
    help: 'Writes files, runs terminals, processes and agents, or changes agent setup.',
    titleClass: 'text-ctp-text',
  },
  {
    level: 'safe',
    title: 'Read only',
    help: 'Reads state, or keeps to its own storage and UI.',
    titleClass: 'text-ctp-text',
  },
];

function describePermission(perm: PluginPermission, isAppScoped: boolean): string {
  const base = PERMISSION_DESCRIPTIONS[perm] ?? 'Unknown permission';
  const text = isAppScoped && CROSS_PROJECT_PERMISSIONS.includes(perm)
    ? base.replace(/where the plugin is (?:also )?enabled/, 'across all projects, since the plugin is app-wide')
    : base;
  // Risk is shown by the group heading, so drop the "(elevated)" style suffix.
  return text.replace(/ \([^)]*\)$/, '');
}

function PermissionGroups({ entry }: { entry: PluginRegistryEntry }) {
  const permissions = entry.manifest.permissions ?? [];
  if (permissions.length === 0) return null;

  const isAppScoped = entry.manifest.scope === 'app';
  const hasCrossProjectPerm = permissions.some((p) => CROSS_PROJECT_PERMISSIONS.includes(p));

  return (
    <SettingsSection title="Permissions" meta={String(permissions.length)}>
      {isAppScoped && hasCrossProjectPerm && (
        <p className={`${settingsHelp} mb-1`} data-testid="app-scope-cross-project-note">
          This plugin works across the whole app, so its cross-project access does not need turning on in each project.
        </p>
      )}
      {RISK_GROUPS.map((group) => {
        const list = permissions.filter((p) => (PERMISSION_RISK_LEVELS[p] ?? 'safe') === group.level);
        if (list.length === 0) return null;
        return (
          <div key={group.level} data-testid={`permission-group-${group.level}`}>
            <div className="flex items-baseline gap-2 mt-4 mb-1">
              <span className={`text-[13px] font-semibold ${group.titleClass}`}>{group.title}</span>
              <span className="text-xs text-ctp-overlay1">{list.length} · {group.help}</span>
            </div>
            {list.map((perm) => (
              <div key={perm} className="flex items-center gap-3 h-[30px] border-t border-surface-0">
                <span className="w-[190px] flex-none truncate font-mono text-xs text-ctp-text">{perm}</span>
                <span className="flex-1 min-w-0 truncate text-[12.5px] text-ctp-overlay1">
                  {describePermission(perm, isAppScoped)}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </SettingsSection>
  );
}

export function PluginDetailSettings() {
  const pluginSettingsId = useUIStore((s) => s.pluginSettingsId);
  const settingsContext = useUIStore((s) => s.settingsContext);
  const plugins = usePluginStore((s) => s.plugins);
  const modules = usePluginStore((s) => s.modules);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const { isEnabled, toggle } = usePluginEnableToggle();

  if (!pluginSettingsId) {
    return (
      <div className="h-full overflow-y-auto bg-ctp-base px-10 pt-7">
        <p className={settingsHelp}>No plugin selected</p>
      </div>
    );
  }

  const entry = plugins[pluginSettingsId];
  if (!entry) {
    return (
      <div className="h-full overflow-y-auto bg-ctp-base px-10 pt-7">
        <p className={settingsHelp}>Plugin not found</p>
      </div>
    );
  }

  const mod = modules[pluginSettingsId];
  // For project-scoped plugins, always use the active project as the settings scope,
  // even when accessed from the app-level settings view. This prevents project-scoped
  // settings from being incorrectly stored under 'app' scope.
  const projectId = (() => {
    if (settingsContext !== 'app') return settingsContext;
    if (entry.manifest.scope === 'project' && activeProjectId) return activeProjectId;
    return undefined;
  })();

  // Determine whether to render declarative or custom settings
  const isDeclarative = entry.manifest.settingsPanel === 'declarative'
    || (!entry.manifest.settingsPanel && entry.manifest.contributes?.settings && entry.manifest.contributes.settings.length > 0);
  const isCustom = entry.manifest.settingsPanel === 'custom' && mod?.SettingsPanel;

  const enabled = isEnabled(pluginSettingsId);
  const meta = pluginMetaText(entry);
  const apiVersion = entry.manifest.engine?.api;
  const description = [meta, apiVersion !== undefined ? `Plugin API ${apiVersion}` : null, entry.manifest.description]
    .filter(Boolean).join(' · ');

  return (
    <SettingsPage
      title={entry.manifest.name}
      description={<span data-testid="plugin-detail-meta">{description}</span>}
      actions={
        <span className="flex items-center gap-2 text-[12.5px] text-ctp-subtext1">
          {enabled ? 'On' : 'Off'}
          <Toggle
            checked={enabled}
            onChange={() => toggle(pluginSettingsId)}
            disabled={entry.status === 'incompatible'}
            aria-label={`Turn on ${entry.manifest.name}`}
          />
        </span>
      }
    >
      <div className="mt-1" data-testid="plugin-detail-status">
        <PluginStatusLines entry={entry} />
      </div>

      <SettingsSection title="Settings">
        {isDeclarative && entry.manifest.contributes?.settings && (
          <PluginSettingsRenderer
            pluginId={pluginSettingsId}
            settings={entry.manifest.contributes.settings}
            scope={projectId || 'app'}
          />
        )}

        {isCustom && mod?.SettingsPanel && (() => {
          const ctx = getActiveContext(pluginSettingsId, activeProjectId || undefined);
          if (!ctx) {
            return (
              <p className={`${settingsHelp} py-2.5 border-t border-surface-0`}>
                {enabled ? "Settings aren't available because the plugin didn't start." : 'Turn the plugin on to change its settings.'}
              </p>
            );
          }
          const api = createPluginAPI(ctx, undefined, entry.manifest);
          const SettingsPanel = mod.SettingsPanel!;
          return (
            <PluginErrorBoundary pluginId={pluginSettingsId}>
              <PluginAPIProvider api={api}>
                <SettingsPanel api={api} />
              </PluginAPIProvider>
            </PluginErrorBoundary>
          );
        })()}

        {!isDeclarative && !isCustom && (
          <p className={`${settingsHelp} py-2.5 border-t border-surface-0`}>This plugin has no settings.</p>
        )}
      </SettingsSection>

      <PermissionGroups entry={entry} />

      {entry.manifest.externalRoots && entry.manifest.externalRoots.length > 0 && (
        <SettingsSection title="External roots" meta={String(entry.manifest.externalRoots.length)}>
          {entry.manifest.externalRoots.map((root) => (
            <div key={root.root} className="flex items-center gap-3 h-[30px] border-t border-surface-0">
              <span className="w-[190px] flex-none truncate font-mono text-xs text-ctp-text">{root.root}</span>
              <span className="flex-1 min-w-0 truncate text-[12.5px] text-ctp-overlay1">
                Set by <code className="font-mono text-ctp-subtext1">{root.settingKey}</code>
              </span>
            </div>
          ))}
        </SettingsSection>
      )}

      {entry.manifest.allowedCommands && entry.manifest.allowedCommands.length > 0 && (
        <SettingsSection title="Allowed commands" meta={String(entry.manifest.allowedCommands.length)}>
          {entry.manifest.allowedCommands.map((cmd) => (
            <div key={cmd} className="flex items-center h-[30px] border-t border-surface-0">
              <code className="font-mono text-xs text-ctp-text">{cmd}</code>
            </div>
          ))}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
