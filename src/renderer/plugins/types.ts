import { ComponentType, ReactNode } from 'react';

export interface PluginContext {
  projectId: string;
  projectPath: string;
}

export interface PluginDefinition {
  id: string;
  label: string;
  icon: ReactNode;
  fullWidth?: boolean;
  SidebarPanel?: ComponentType;
  MainPanel: ComponentType;
  onProjectLoad?: (ctx: PluginContext) => void | Promise<void>;
  onProjectUnload?: (ctx: PluginContext) => void | Promise<void>;
}
