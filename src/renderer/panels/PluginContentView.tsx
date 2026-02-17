import React, { useEffect, useMemo, useState } from 'react';
import { usePluginStore } from '../plugins/plugin-store';
import { PluginAPIProvider } from '../plugins/plugin-context';
import { createPluginAPI } from '../plugins/plugin-api-factory';
import { getActiveContext, activatePlugin } from '../plugins/plugin-loader';
import { useProjectStore } from '../stores/projectStore';
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
    console.error(`[Plugin: ${this.props.pluginId}] Render error:`, error);
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
            <pre className="text-xs text-left bg-surface-0 p-3 rounded overflow-auto max-h-32">
              {this.state.error?.message}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PluginContentView({ pluginId, mode }: { pluginId: string; mode?: PluginRenderMode }) {
  const modules = usePluginStore((s) => s.modules);
  const plugins = usePluginStore((s) => s.plugins);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const [activating, setActivating] = useState(false);

  const mod = modules[pluginId];
  const entry = plugins[pluginId];

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
  useEffect(() => {
    if (mode === 'app' && !ctx && mod && entry && entry.status !== 'incompatible' && !activating) {
      setActivating(true);
      activatePlugin(pluginId).finally(() => setActivating(false));
    }
  }, [mode, ctx, mod, entry, pluginId, activating]);

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
    <PluginErrorBoundary key={pluginId} pluginId={pluginId}>
      <PluginAPIProvider api={api}>
        <div className="h-full bg-ctp-base overflow-auto">
          <MainPanel api={api} />
        </div>
      </PluginAPIProvider>
    </PluginErrorBoundary>
  );
}
