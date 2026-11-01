import { useRef, useState, type ReactNode } from 'react';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

/**
 * Changing an agent's CLI starts a new session on its next wake (#2593): main
 * drops the resume id, as a conversation can't move to another CLI. An agent
 * with a saved session asks first; one without changes at once. The saved
 * session is read when the choice is made, since a page's copy of the config
 * can predate the agent's last run. Used by each desktop page that changes it.
 */
export function useCliChangeConfirm({ projectPath, agentId, agentName, enabled, apply }: {
  projectPath: string | undefined;
  agentId: string;
  agentName: string;
  /** False once the CLI can't change here (the agent woke): an open question goes away unanswered. */
  enabled: boolean;
  apply: (cli: string) => unknown;
}): { requestCliChange: (cli: string) => Promise<void>; cliChangeDialog: ReactNode } {
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const [pending, setPending] = useState<{ agentId: string; cli: string } | null>(null);
  const latest = useRef(0);

  const requestCliChange = async (cli: string) => {
    const request = ++latest.current;
    // Can't tell means ask: the question costs a click, a lost session can't come back.
    let hasSession = true;
    if (projectPath) {
      try {
        const config = await window.clubhouse.agent.getDurableConfig(projectPath, agentId);
        hasSession = !!config?.lastSessionId;
      } catch {
        // telemetry-exempt: the user is asked, as for an agent with a session.
      }
    }
    if (request !== latest.current) return;
    if (hasSession) setPending({ agentId, cli });
    else await apply(cli);
  };

  const open = enabled && pending?.agentId === agentId;
  const cli = pending?.cli ?? '';
  const cliName = allOrchestrators.find((o) => o.id === cli)?.displayName ?? cli;
  const cliChangeDialog = (
    <ConfirmDestructiveAction
      open={open}
      title={`Change the CLI to ${cliName}?`}
      description={`${agentName} starts a new session on ${cliName} the next time it wakes. Its current conversation can’t move to another CLI.`}
      confirmLabel="Change CLI"
      onCancel={() => setPending(null)}
      onConfirm={() => {
        setPending(null);
        void apply(cli);
      }}
    />
  );
  return { requestCliChange, cliChangeDialog };
}
