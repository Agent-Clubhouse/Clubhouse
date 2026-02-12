import { useEffect, useState } from 'react';
import { useSchedulerStore } from '../../stores/schedulerStore';
import { useProjectStore } from '../../stores/projectStore';
import { describeSchedule } from '../../../shared/cron';

export function SchedulerList() {
  const { jobs, selectedJobId, loadJobs, createJob, deleteJob, setSelectedJob } = useSchedulerStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    if (activeProjectId) loadJobs();
  }, [activeProjectId, loadJobs]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-surface-0 flex items-center justify-between">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Scheduler</span>
        <button
          onClick={() => createJob()}
          className="text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
          title="New job"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {jobs.length === 0 && (
          <p className="px-3 py-4 text-xs text-ctp-overlay0 text-center">No scheduled jobs</p>
        )}

        {jobs.map((job) => (
          <div
            key={job.id}
            className="group relative"
          >
            <button
              onClick={() => setSelectedJob(job.id)}
              className={`w-full text-left px-3 py-2 cursor-pointer transition-colors ${
                selectedJobId === job.id
                  ? 'bg-surface-1 text-ctp-text'
                  : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${job.enabled ? 'bg-green-500' : 'bg-ctp-overlay0'}`} />
                <span className="text-sm truncate flex-1">{job.name}</span>
              </div>
              <p className="text-xs text-ctp-overlay0 ml-3.5 mt-0.5 truncate">{describeSchedule(job.cronExpression)}</p>
            </button>

            {/* Delete button on hover */}
            {deleteTarget === job.id ? (
              <div className="absolute right-1 top-1 flex items-center gap-1">
                <button
                  onClick={() => { deleteJob(job.id); setDeleteTarget(null); }}
                  className="px-1.5 py-0.5 text-[10px] rounded bg-ctp-red/20 text-ctp-red hover:bg-ctp-red/30 cursor-pointer"
                >
                  Delete
                </button>
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="px-1.5 py-0.5 text-[10px] rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(job.id); }}
                className="absolute right-2 top-2 hidden group-hover:block text-ctp-overlay0 hover:text-ctp-red cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
