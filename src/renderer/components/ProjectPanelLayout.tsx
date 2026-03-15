import { ExplorerRail } from '../panels/ExplorerRail';
import { AccessoryPanel } from '../panels/AccessoryPanel';
import { MainContentView } from '../panels/MainContentView';
import { ResizeDivider } from './ResizeDivider';
import { usePanelStore } from '../stores/panelStore';
import { useUIStore } from '../stores/uiStore';
import { usePluginStore } from '../plugins/plugin-store';

/**
 * The three-panel project layout (explorer │ accessory │ main content).
 * Subscribes to panel sizing state so that continuous resize-drag events
 * only re-render this subtree, not the entire App component tree.
 */
export function ProjectPanelLayout() {
  const explorerWidth = usePanelStore((s) => s.explorerWidth);
  const explorerCollapsed = usePanelStore((s) => s.explorerCollapsed);
  const accessoryWidth = usePanelStore((s) => s.accessoryWidth);
  const accessoryCollapsed = usePanelStore((s) => s.accessoryCollapsed);
  const resizeExplorer = usePanelStore((s) => s.resizeExplorer);
  const resizeAccessory = usePanelStore((s) => s.resizeAccessory);
  const toggleExplorerCollapse = usePanelStore((s) => s.toggleExplorerCollapse);
  const toggleAccessoryCollapse = usePanelStore((s) => s.toggleAccessoryCollapse);

  const explorerTab = useUIStore((s) => s.explorerTab);
  const activePluginId = explorerTab.startsWith('plugin:') ? explorerTab.slice('plugin:'.length) : null;
  const activePluginEntry = usePluginStore((s) => activePluginId ? s.plugins[activePluginId] : undefined);
  const isFullWidth = activePluginEntry?.manifest.contributes?.tab?.layout === 'full';

  return (
    <div className="flex flex-row min-h-0 min-w-0">
      {!explorerCollapsed && (
        <div style={{ width: explorerWidth }} className="flex-shrink-0 min-h-0">
          <ExplorerRail />
        </div>
      )}
      <ResizeDivider
        onResize={resizeExplorer}
        onToggleCollapse={toggleExplorerCollapse}
        collapsed={explorerCollapsed}
        collapseDirection="left"
      />
      {!isFullWidth && !accessoryCollapsed && (
        <div style={{ width: accessoryWidth }} className="flex-shrink-0 min-h-0">
          <AccessoryPanel />
        </div>
      )}
      {!isFullWidth && (
        <ResizeDivider
          onResize={resizeAccessory}
          onToggleCollapse={toggleAccessoryCollapse}
          collapsed={accessoryCollapsed}
          collapseDirection="left"
        />
      )}
      <div className="flex-1 min-w-0 min-h-0">
        <MainContentView />
      </div>
    </div>
  );
}
