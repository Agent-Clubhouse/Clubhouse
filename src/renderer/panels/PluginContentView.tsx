import React, { useEffect, useMemo, useState } from 'react';
import { usePluginStore } from '../plugins/plugin-store';
import { PluginAPIProvider } from '../plugins/plugin-context';
import { createPluginAPI } from '../plugins/plugin-api-factory';
import { getActiveContext, activatePlugin } from '../plugins/plugin-loader';
import { useProjectStore } from '../stores/projectStore';
import { usePluginUpdateStore } from '../stores/pluginUpdateStore';
import { rendererLog } from '../plugins/renderer-logger';
import type { PluginRenderMode } from '../../shared/plugin-types';

export class PluginErrorBoundary extends React.Component<
  { pluginId: string; children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { pluginId: string; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    const { pluginId } = this.props;
    console.error(`[Plugin: ${pluginId}] Render error:`, error);
    rendererLog('core:plugins', 'error', `Plugin "${pluginId}" render error`, {
      meta: { pluginId, error: error.message, stack: error.stack },
    });
    // Store the render error in the plugin store so it's visible in Settings
    usePluginStore.getState().setPluginStatus(pluginId, 'errored',
      `Render error: ${error.message}`);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full bg-ctp-base">
          <div className="text-center text-ctp-subtext0 max-w-md">
            <p className="text-lg mb-2">Plugin Error</p>
            <p className="text-sm mb-4">
              The plugin &quot;{this.props.pluginId}&quot; encountered an error while rendering.
            </p>
            {this.state.error?.message && (
              <pre className="text-xs text-left bg-surface-0 p-3 rounded overflow-auto max-h-32">
                {this.state.error.message}
              </pre>
            )}
            {this.state.error?.stack && (
              <details className="mt-2 text-left">
                <summary className="text-xs text-ctp-subtext0 cursor-pointer">Stack trace</summary>
                <pre className="text-xs bg-surface-0 p-3 rounded overflow-auto max-h-48 mt-1">
                  {this.state.error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PluginContentView({ pluginId, mode }: { pluginId: string; mode?: PluginRenderMode }) {
  const mod = usePluginStore((s) => s.modules[pluginId]);
  const entry = usePluginStore((s) => s.plugins[pluginId]);
  const contextRevision = usePluginStore((s) => s.contextRevision);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const [activating, setActivating] = useState(false);

  // Check if this plugin is currently being hot-reloaded (updated)
  const isReloading = usePluginUpdateStore((s) => !!s.updating[pluginId]);
  const reloadError = usePluginUpdateStore((s) => s.updateErrors[pluginId]);

  // For app-mode plugins, look up the app-level context (no projectId).
  // For project-mode, use the active project.
  const contextProjectId = mode === 'app' ? undefined : (activeProjectId || undefined);
  const ctx = getActiveContext(pluginId, contextProjectId);

  // Memoize the API so downstream plugins receive a stable reference.
  // Without this, every parent re-render creates a new api object, which causes
  // plugin effects that depend on api-derived values (like storage) to re-fire.
  // This was the root cause of the Hub losing pane assignments on sleeping-agent resume:
  // spawnDurableAgent updated the agent store → MainContentView re-rendered →
  // PluginContentView created a new api → Hub's loadHub effect re-ran with the new
  // storage ref → reloaded the old pane tree from disk before the debounced save.
  const api = useMemo(
    () => ctx ? createPluginAPI(ctx, mode, entry?.manifest) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, mode],
  );

  // Auto-activate app-mode plugins on demand if context doesn't exist yet.
  // This handles race conditions between plugin init and first render.
  // Also handles re-activation after a failed hot-reload when the plugin
  // is in 'registered' or 'deactivated' state (not 'errored' or 'incompatible').
  useEffect(() => {
    if (
      mode === 'app' && !ctx && entry && !activating && !isReloading &&
      (entry.status === 'registered' || entry.status === 'deactivated' || (entry.status === 'activated' && mod))
    ) {
      setActivating(true);
      activatePlugin(pluginId).finally(() => setActivating(false));
    }
  }, [mode, ctx, mod, entry, pluginId, activating, isReloading]);

  // During hot-reload, show a loading state instead of error messages.
  // The module is temporarily removed during the deactivate→reactivate cycle.
  if (isReloading || (entry && entry.status === 'registered' && !mod && !reloadError)) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-xs">Reloading plugin...</p>
      </div>
    );
  }

  // Show reload error with context if hot-reload failed
  if (reloadError && (!mod || !ctx)) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <div className="text-center text-ctp-subtext0 max-w-md">
          <p className="text-lg mb-2">Plugin Update Error</p>
          <p className="text-sm mb-3">
            Plugin &quot;{entry?.manifest.name || pluginId}&quot; was updated but failed to reload.
          </p>
          <pre className="text-xs text-left bg-surface-0 p-3 rounded overflow-auto max-h-24 mb-3">
            {reloadError}
          </pre>
          <p className="text-xs text-ctp-overlay0">
            Try restarting the app to load the updated plugin.
          </p>
        </div>
      </div>
    );
  }

  if (!mod || !mod.MainPanel) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <div className="text-center text-ctp-subtext0">
          <p className="text-lg mb-2">Plugin Not Available</p>
          <p className="text-sm">
            {entry ? `Plugin "${entry.manifest.name}" has no main panel.` : `Plugin "${pluginId}" is not loaded.`}
          </p>
        </div>
      </div>
    );
  }

  if (!ctx || !api) {
    if (activating) {
      return (
        <div className="flex items-center justify-center h-full bg-ctp-base">
          <p className="text-ctp-subtext0 text-xs">Loading plugin...</p>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0">Plugin is not activated</p>
      </div>
    );
  }

  const MainPanel = mod.MainPanel;

  return (
    <PluginErrorBoundary key={`${pluginId}-${contextRevision}`} pluginId={pluginId}>
      <PluginAPIProvider api={api}>
        <div className="h-full bg-ctp-base overflow-hidden">
          <MainPanel api={api} />
        </div>
      </PluginAPIProvider>
    </PluginErrorBoundary>
  );
}
