/**
 * The confirmation before Clubhouse MCP goes off, at app or project level, for
 * every setting that can do it: its own switch, a project's override, and
 * Clubhouse mode, which it falls back to. Main counts what the change would do
 * (services/mcp-off-impact). Nothing is saved until the user confirms.
 */

import { useCallback, useState } from 'react';
import type { McpOffImpact } from '../../../shared/mcp-off-impact';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { rendererLog } from '../../plugins/renderer-logger';
import { settingsError, settingsHelp } from './SettingsLayout';

export type McpProposal = Parameters<typeof window.clubhouse.app.getMcpOffImpact>[0];

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function join(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What stops working, in one sentence. `projectName` narrows it to a project. */
export function mcpOffLead(impact: McpOffImpact | null, projectName?: string): string {
  if (!impact) return 'Helpers, orchestration and connections to the Dispatcher stop working where Clubhouse MCP goes off.';
  if (impact.appKeptByClubhouseMode && !projectName) {
    return 'Clubhouse mode keeps Clubhouse MCP on at app level, so nothing stops working yet. Turning off Clubhouse mode would turn it off.';
  }
  if (projectName) return `In ${projectName}, helpers, orchestration and connections to the Dispatcher stop working.`;
  return impact.dispatcherGoesOff
    ? 'Helpers, orchestration, connections to the Dispatcher and the Dispatcher itself stop working.'
    : 'Helpers, orchestration and connections to the Dispatcher stop working.';
}

/** The live counts. */
export function mcpOffCounts(impact: McpOffImpact): string {
  const losing = `${plural(impact.agentsLosing, 'agent')} ${impact.agentsLosing === 1 ? 'loses' : 'lose'} Clubhouse tools`;
  const parts = [
    impact.agentsKeeping > 0 ? `${losing}, and ${impact.agentsKeeping} ${impact.agentsKeeping === 1 ? 'keeps' : 'keep'} them.` : `${losing}.`,
    ...(impact.quickAgentsLosing > 0 ? [`${plural(impact.quickAgentsLosing, 'running quick agent')} ${impact.quickAgentsLosing === 1 ? 'loses' : 'lose'} them too.`] : []),
    ...(impact.helpersReportOnly > 0 ? [`${plural(impact.helpersReportOnly, 'helper')} can only report to ${impact.helpersReportOnly === 1 ? 'its' : 'their'} parent.`] : []),
    `${plural(impact.runningOrchestratorsWithHelpers, 'running orchestrator')} ${impact.runningOrchestratorsWithHelpers === 1 ? 'has' : 'have'} helpers.`,
  ];
  if (impact.appLoses) parts.push(impact.dispatcherRunning ? 'The Dispatcher is running.' : 'The Dispatcher is not running.');
  return parts.join(' ');
}

/** What keeps MCP. Empty when nothing does. */
export function mcpOffKeeps({ keeps }: McpOffImpact): string {
  const items = [
    ...keeps.projects.map((p) => `${p.name} (${p.via === 'clubhouse_mode' ? 'Clubhouse mode' : 'its own setting'})`),
    ...keeps.agents.map((a) => `${a.name} in ${a.project} (its own setting)`),
  ];
  return items.length > 0 ? `These keep Clubhouse MCP: ${join(items)}.` : '';
}

export const MCP_OFF_RUNNING_NOTE = 'Stops new Clubhouse tool calls for these agents now. Running agents keep working on what they can do without Clubhouse tools, and can’t message other agents. Helpers can still report to their parent.';
export const MCP_OFF_OLDER_GO_NOTE = 'Older Clubhouse Go versions may not show a Dispatcher that’s still running with MCP off. You can stop it here.';
export const MCP_OFF_RESTORE_NOTE = 'Turning Clubhouse MCP back on restores your saved settings. It doesn’t start any session.';

interface Pending {
  impact: McpOffImpact | null;
  projectName?: string;
  apply: () => unknown;
  saved: () => boolean;
}

export const MCP_OFF_SAVE_FAILED = 'Couldn’t save, so Clubhouse MCP hasn’t changed. Try again.';
export const MCP_OFF_STOP_FAILED = 'Clubhouse MCP is off, but the Dispatcher couldn’t be stopped. You can stop it from its view.';

/**
 * `requestMcpChange` asks main what a change would turn off, and applies it
 * straight away when that is nothing. `always` shows the dialog regardless, for
 * MCP's own switch, where nothing going off still needs saying. Render
 * `mcpOffDialog` once.
 */
export function useMcpOffConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [stopDispatcher, setStopDispatcher] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * `saved` says whether the change took: the stores roll a failed save back and
   * don't reject, so `apply` resolving proves nothing.
   */
  const requestMcpChange = useCallback(async ({ proposal, projectName, always, apply, saved }: {
    proposal: McpProposal;
    projectName?: string;
    always?: boolean;
    apply: () => unknown;
    saved: () => boolean;
  }): Promise<void> => {
    let impact: McpOffImpact | null = null;
    try {
      impact = await window.clubhouse.app.getMcpOffImpact(proposal);
    } catch (err) {
      // telemetry-exempt: logged; the dialog still asks, without the counts.
      rendererLog('core:mcp', 'warn', 'Could not read what turning off Clubhouse MCP would do', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    if (impact && !impact.turnsOff && !always) {
      await apply();
      return;
    }
    setStopDispatcher(false);
    setFailure(null);
    setPending({ impact, projectName, apply, saved });
  }, []);

  /** Stays open until the save has taken, so a failed one can't read as done. It stops nothing then. */
  const confirm = async () => {
    if (!pending || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      let took = false;
      try {
        await pending.apply();
        took = pending.saved();
      } catch (err) {
        rendererLog('core:mcp', 'warn', 'Could not save turning off Clubhouse MCP', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
      if (!took) {
        setFailure(MCP_OFF_SAVE_FAILED);
        return;
      }
      if (stopDispatcher && pending.impact?.dispatcherRunning) {
        try {
          await window.clubhouse.dispatcher.stop();
        } catch (err) {
          rendererLog('core:mcp', 'warn', 'Could not stop the Dispatcher after turning off Clubhouse MCP', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
          setFailure(MCP_OFF_STOP_FAILED);
          return;
        }
      }
      setPending(null);
    } finally {
      setSaving(false);
    }
  };

  const impact = pending?.impact ?? null;
  const offerStop = !!impact?.appLoses && impact.dispatcherRunning;
  const mcpOffDialog = (
    <Modal
      open={!!pending}
      onClose={() => setPending(null)}
      title="Turn off Clubhouse MCP?"
      width="w-[480px]"
      testId="mcp-off-dialog"
      footer={(
        <>
          <Button kind="ghost" onClick={() => setPending(null)} data-testid="mcp-off-cancel">Cancel</Button>
          <Button kind="primary" disabled={saving} onClick={() => void confirm()} data-testid="mcp-off-confirm">Turn off</Button>
        </>
      )}
    >
      <div className={`${settingsHelp} flex flex-col gap-2`}>
        <p data-testid="mcp-off-lead">{mcpOffLead(impact, pending?.projectName)}</p>
        {impact?.turnsOff && <p data-testid="mcp-off-counts">{mcpOffCounts(impact)}</p>}
        {impact && mcpOffKeeps(impact) && <p data-testid="mcp-off-keeps">{mcpOffKeeps(impact)}</p>}
        {!!impact?.unreadableProjects.length && <p data-testid="mcp-off-unread">These counts leave out {join(impact.unreadableProjects)}, which couldn’t be read.</p>}
        {impact?.turnsOff !== false && <p>{MCP_OFF_RUNNING_NOTE}</p>}
        <p>{MCP_OFF_RESTORE_NOTE}</p>
        {offerStop && (
          <label className="flex items-start gap-2 mt-1 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 cursor-pointer"
              checked={stopDispatcher}
              onChange={(e) => setStopDispatcher(e.target.checked)}
              data-testid="mcp-off-stop-dispatcher"
            />
            <span>Also stop the Dispatcher now. This interrupts whatever it is doing.</span>
          </label>
        )}
        {offerStop && <p data-testid="mcp-off-older-go">{MCP_OFF_OLDER_GO_NOTE}</p>}
        {failure && <p className={settingsError} role="alert" data-testid="mcp-off-failure">{failure}</p>}
      </div>
    </Modal>
  );
  return { requestMcpChange, mcpOffDialog };
}
