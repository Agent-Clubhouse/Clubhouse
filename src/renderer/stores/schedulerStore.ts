import { create } from 'zustand';
import { SchedulerJob } from '../../shared/types';
import { matchesCron } from '../../shared/cron';
import { useAgentStore } from './agentStore';
import { useProjectStore } from './projectStore';

interface SchedulerState {
  jobs: SchedulerJob[];
  selectedJobId: string | null;
  loadJobs: () => Promise<void>;
  createJob: () => Promise<void>;
  updateJob: (id: string, updates: Partial<SchedulerJob>) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  setSelectedJob: (id: string | null) => void;
  startScheduler: () => void;
  stopScheduler: () => void;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

function getSchedulerPath(): string | null {
  const { projects, activeProjectId } = useProjectStore.getState();
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) return null;
  return `${project.path}/.clubhouse/scheduler.json`;
}

async function persist(jobs: SchedulerJob[]) {
  const path = getSchedulerPath();
  if (!path) return;
  await window.clubhouse.file.write(path, JSON.stringify(jobs, null, 2));
}

async function executeJob(job: SchedulerJob) {
  const { projects, activeProjectId } = useProjectStore.getState();
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) return;

  const { spawnQuickAgent, spawnDurableAgent, agents, setActiveAgent } = useAgentStore.getState();

  if (job.agentType === 'quick') {
    const agentId = await spawnQuickAgent(
      project.id,
      project.path,
      job.prompt,
      job.model,
    );
    setActiveAgent(agentId);
  } else if (job.agentType === 'durable' && job.agentId) {
    const agent = agents[job.agentId];
    if (!agent) return;

    if (agent.status === 'sleeping' || agent.status === 'error') {
      await spawnDurableAgent(agent.projectId, project.path, {
        id: agent.id,
        name: agent.name,
        color: agent.color,
        localOnly: agent.localOnly,
        branch: agent.branch || '',
        worktreePath: agent.worktreePath || '',
        createdAt: '',
        overrides: { claudeMd: false, permissions: false, mcpConfig: false, skills: false, agents: false },
        quickOverrides: { claudeMd: false, permissions: false, mcpConfig: false, skills: false, agents: false },
        quickConfigLayer: {},
      }, true);
      await new Promise((r) => setTimeout(r, 1500));
    }

    window.clubhouse.pty.write(job.agentId, job.prompt + '\n');
    setActiveAgent(job.agentId);
  }
}

function tick() {
  const { jobs } = useSchedulerStore.getState();
  const now = new Date();
  const nowMinuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!matchesCron(job.cronExpression, now)) continue;

    // Prevent double-fires within the same minute
    if (job.lastRunAt) {
      const last = new Date(job.lastRunAt);
      const lastMinuteKey = `${last.getFullYear()}-${last.getMonth()}-${last.getDate()}-${last.getHours()}-${last.getMinutes()}`;
      if (lastMinuteKey === nowMinuteKey) continue;
    }

    // Update lastRunAt immediately to prevent duplicate runs
    useSchedulerStore.getState().updateJob(job.id, { lastRunAt: now.toISOString() });
    executeJob(job).catch(console.error);
  }
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  jobs: [],
  selectedJobId: null,

  loadJobs: async () => {
    const path = getSchedulerPath();
    if (!path) return;
    try {
      const content = await window.clubhouse.file.read(path);
      const jobs = JSON.parse(content) as SchedulerJob[];
      set({ jobs });
    } catch {
      set({ jobs: [] });
    }
  },

  createJob: async () => {
    const id = `job_${Date.now()}`;
    const job: SchedulerJob = {
      id,
      name: 'New Job',
      cronExpression: '0 * * * *',
      agentType: 'quick',
      model: 'default',
      prompt: '',
      enabled: false,
      createdAt: new Date().toISOString(),
    };
    const jobs = [...get().jobs, job];
    set({ jobs, selectedJobId: id });
    await persist(jobs);
  },

  updateJob: async (id, updates) => {
    const jobs = get().jobs.map((j) => (j.id === id ? { ...j, ...updates } : j));
    set({ jobs });
    await persist(jobs);
  },

  deleteJob: async (id) => {
    const jobs = get().jobs.filter((j) => j.id !== id);
    const selectedJobId = get().selectedJobId === id ? null : get().selectedJobId;
    set({ jobs, selectedJobId });
    await persist(jobs);
  },

  setSelectedJob: (id) => set({ selectedJobId: id }),

  startScheduler: () => {
    if (intervalId) return;
    intervalId = setInterval(tick, 30_000);
  },

  stopScheduler: () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  },
}));
