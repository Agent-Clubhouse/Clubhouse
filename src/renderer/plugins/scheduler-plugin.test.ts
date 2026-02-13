import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../features/scheduler/SchedulerList', () => ({ SchedulerList: () => null }));
vi.mock('../features/scheduler/SchedulerEditor', () => ({ SchedulerEditor: () => null }));

// Mock schedulerStore
const mockLoadJobs = vi.fn().mockResolvedValue(undefined);
const mockStartScheduler = vi.fn();
const mockStopScheduler = vi.fn();

vi.mock('../stores/schedulerStore', () => ({
  useSchedulerStore: {
    getState: () => ({
      loadJobs: mockLoadJobs,
      startScheduler: mockStartScheduler,
      stopScheduler: mockStopScheduler,
    }),
  },
}));

import { schedulerPlugin } from './scheduler-plugin';

describe('scheduler plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct id and label', () => {
    expect(schedulerPlugin.id).toBe('scheduler');
    expect(schedulerPlugin.label).toBe('Scheduler');
  });

  it('provides SidebarPanel and MainPanel', () => {
    expect(schedulerPlugin.SidebarPanel).toBeDefined();
    expect(schedulerPlugin.MainPanel).toBeDefined();
  });

  it('onProjectLoad calls loadJobs and startScheduler', async () => {
    await schedulerPlugin.onProjectLoad!({ projectId: 'p1', projectPath: '/proj' });
    expect(mockLoadJobs).toHaveBeenCalled();
    expect(mockStartScheduler).toHaveBeenCalled();
  });

  it('onProjectUnload calls stopScheduler', () => {
    schedulerPlugin.onProjectUnload!({ projectId: 'p1', projectPath: '/proj' });
    expect(mockStopScheduler).toHaveBeenCalled();
  });
});
