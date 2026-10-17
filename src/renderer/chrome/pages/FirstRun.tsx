import { useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { reportChromeActionFailed, reportChromeFeature } from '../telemetry';

/**
 * First run (docs/chrome-redesign-spec.md §2): with no projects, the pane asks
 * for a folder, by picker or by dropping one on it.
 */
export function FirstRun() {
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  const addProject = useProjectStore((s) => s.addProject);
  const [dragging, setDragging] = useState(false);

  const choose = () => {
    reportChromeFeature('first_run_add');
    pickAndAddProject().catch((err) => reportChromeActionFailed('add_project', err));
  };

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const path = window.clubhouse.getPathForFile(file);
    if (!path) return;
    reportChromeFeature('first_run_drop');
    addProject(path).catch((err) => reportChromeActionFailed('add_project', err));
  };

  return (
    <div
      data-testid="first-run"
      className="h-full bg-ctp-base flex justify-center"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={drop}
    >
      <div className="max-w-md w-full pt-32 px-6 flex flex-col gap-3">
        <h1 className="text-lg font-semibold text-ctp-text">Add your first project</h1>
        <p className="text-sm text-ctp-subtext0 leading-relaxed">
          A project is a folder with a git repository. Each agent you add gets its own branch and worktree inside it.
        </p>
        <div
          className={`mt-2 rounded-lg border border-dashed px-4 py-6 flex flex-col items-center gap-3 text-sm ${
            dragging ? 'border-ctp-accent text-ctp-text' : 'border-surface-2 text-ctp-subtext0'
          }`}
        >
          <span>Drop a folder here, or</span>
          <button
            type="button"
            data-testid="first-run-choose"
            onClick={choose}
            className="px-3.5 py-1.5 rounded-md bg-ctp-accent text-white text-sm font-medium cursor-pointer hover:opacity-90"
          >
            Choose a folder…
          </button>
        </div>
      </div>
    </div>
  );
}
