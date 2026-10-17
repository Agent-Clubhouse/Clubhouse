import { useEffect, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { Button } from '../../components/Button';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { useKeyboardShortcutsStore } from '../../stores/keyboardShortcutsStore';
import { formatShortcut } from '../../components/Tooltip';
import { reportChromeActionFailed, reportChromeFeature } from '../telemetry';

/**
 * First run (docs/chrome-redesign-spec.md §2, #2024): the welcome page. With no
 * projects the pane shows a title, one line and three steps, with the folder
 * picker inside step one. It replaces the legacy onboarding modal in the new
 * shell; there is no cohort question.
 */

/** Where to get each agent CLI that isn't on PATH. */
const INSTALL_URLS: Record<string, string> = {
  'claude-code': 'https://docs.claude.com/en/docs/claude-code/setup',
  'codex-cli': 'https://github.com/openai/codex',
  'copilot-cli': 'https://github.com/github/copilot-cli',
};

const IS_MAC = typeof window !== 'undefined' && window.clubhouse?.platform === 'darwin';

/**
 * The provider mascots above the title. They come from #2019's awake mascots;
 * until those land this slot stays empty.
 */
function MascotSlot() {
  return <div data-testid="first-run-mascots" aria-hidden="true" />;
}

function Step({ n, title, active, children, detail }: { n: number; title: string; active?: boolean; detail: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-3 border-t border-surface-0">
      <span
        aria-hidden="true"
        className={`flex-shrink-0 w-[18px] h-[18px] rounded-full border-[1.5px] flex items-center justify-center text-[11px] ${active ? 'border-ctp-accent text-ctp-accent' : 'border-surface-2 text-ctp-overlay1'}`}
      >
        {n}
      </span>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <h2 className={`text-[13px] font-normal ${active ? 'text-ctp-text' : 'text-ctp-subtext1'}`}>{title}</h2>
        <p className="text-xs leading-normal text-ctp-overlay1">{detail}</p>
        {children}
      </div>
    </li>
  );
}

/** Installed agent CLIs, from checkOrchestrator, with an install link for any that are missing. */
function AgentClis() {
  const orchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const availability = useOrchestratorStore((s) => s.availability);
  const checkAll = useOrchestratorStore((s) => s.checkAllAvailability);
  const count = orchestrators.length;
  useEffect(() => { if (count > 0) void checkAll(); }, [count, checkAll]);
  if (count === 0) return null;
  return (
    <ul data-testid="first-run-clis" aria-label="Agent CLIs" className="mt-1.5 flex flex-wrap gap-x-[18px]">
      {orchestrators.map((o) => {
        const avail = availability[o.id];
        const found = avail?.available === true;
        const url = INSTALL_URLS[o.id];
        return (
          <li key={o.id} className="h-[30px] flex items-center gap-1.5 text-xs whitespace-nowrap">
            <span className={found ? 'text-ctp-text' : 'text-ctp-subtext1'}>{o.displayName}</span>
            {!avail ? (
              <span className="text-ctp-overlay1">checking</span>
            ) : found ? (
              <span className="text-ctp-overlay1">found</span>
            ) : url ? (
              <button
                type="button"
                onClick={() => { void window.clubhouse.app.openExternalUrl(url); reportChromeFeature('first_run_install'); }}
                className="text-ctp-accent hover:underline cursor-pointer focus-ring rounded"
              >
                Install
              </button>
            ) : (
              <span className="text-ctp-overlay1">not found</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function FirstRun() {
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  const addProject = useProjectStore((s) => s.addProject);
  const newAgentBinding = useKeyboardShortcutsStore((s) => s.shortcuts['new-quick-agent']?.currentBinding);
  const [dragging, setDragging] = useState(false);
  const [annex, setAnnex] = useState(false);

  // Annex (another machine as a satellite) is offered where its settings exist.
  useEffect(() => {
    let cancelled = false;
    window.clubhouse.app.isPreviewEligible().then((ok: boolean) => { if (!cancelled) setAnnex(!!ok); })
      .catch(() => { /* telemetry-exempt: the Annex line just stays hidden */ });
    return () => { cancelled = true; };
  }, []);

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

  const openAnnex = () => {
    const ui = useUIStore.getState();
    ui.setSettingsContext('app');
    ui.setSettingsSubPage('annex-control');
    if (ui.explorerTab !== 'settings') ui.toggleSettings();
    reportChromeFeature('host_settings_open');
  };

  // ⇧⌘N on macOS, Ctrl+Shift+N elsewhere.
  const shortcut = newAgentBinding ? formatShortcut(newAgentBinding) : null;

  return (
    <div
      data-testid="first-run"
      className="h-full overflow-y-auto bg-ctp-base flex justify-center"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={drop}
    >
      <div className="w-[480px] max-w-full px-6 pt-[84px] pb-10 flex flex-col">
        <MascotSlot />
        <h1 className="text-lg font-semibold text-ctp-text">Welcome to Clubhouse</h1>
        <p className="mt-1 text-[13px] text-ctp-overlay1">Run coding agents side by side, each on its own branch.</p>

        <ol className="mt-6 border-b border-surface-0">
          <Step n={1} active title="Add a project" detail="A folder with a git repository. Agents get their own branch and worktree inside it.">
            <div
              className={`mt-2 h-[72px] rounded-lg border border-dashed flex items-center justify-center gap-2.5 text-xs ${
                dragging ? 'border-ctp-accent text-ctp-text' : 'border-surface-2 text-ctp-overlay1'
              }`}
            >
              <span>Drop a folder here, or</span>
              <Button kind="primary" data-testid="first-run-choose" onClick={choose} className="focus-ring">
                Choose a folder…
              </Button>
            </div>
          </Step>
          <Step
            n={2}
            title="Start an agent"
            detail={<>Press New in the sidebar{shortcut ? <>, or {shortcut}</> : null}. These are the agent CLIs on this {IS_MAC ? 'Mac' : 'computer'}.</>}
          >
            <AgentClis />
          </Step>
          <Step n={3} title="Review its changes" detail="Select the agent, then open Git to see the diff and commit or open a pull request." />
        </ol>

        <p className="mt-3.5 text-xs text-ctp-overlay1">
          Guides for each step are in{' '}
          <button type="button" onClick={() => useUIStore.getState().toggleHelp()} className="text-ctp-accent hover:underline cursor-pointer focus-ring rounded">Help</button>.
          {annex && (
            <>
              {' '}Using Clubhouse on another {IS_MAC ? 'Mac' : 'computer'}?{' '}
              <button type="button" data-testid="first-run-annex" onClick={openAnnex} className="text-ctp-accent hover:underline cursor-pointer focus-ring rounded">Connect to it</button>.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
