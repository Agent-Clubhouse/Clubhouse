import { SchedulerList } from '../features/scheduler/SchedulerList';
import { SchedulerEditor } from '../features/scheduler/SchedulerEditor';
import { useSchedulerStore } from '../stores/schedulerStore';
import { PluginDefinition } from './types';

export const schedulerPlugin: PluginDefinition = {
  id: 'scheduler',
  label: 'Scheduler',
  icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  SidebarPanel: SchedulerList,
  MainPanel: SchedulerEditor,
  onProjectLoad: async () => {
    const { loadJobs, startScheduler } = useSchedulerStore.getState();
    await loadJobs();
    startScheduler();
  },
  onProjectUnload: () => {
    useSchedulerStore.getState().stopScheduler();
  },
};
