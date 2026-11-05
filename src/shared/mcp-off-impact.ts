/** What keeps a project on Clubhouse MCP once the change is saved. */
export type McpKeptBy = 'project_setting' | 'clubhouse_mode';

/** What a proposed MCP or Clubhouse mode change would turn off (services/mcp-off-impact). */
export interface McpOffImpact {
  /** The change takes MCP away from the app, a project or an agent. */
  turnsOff: boolean;
  /** MCP goes off at app level. */
  appLoses: boolean;
  /** MCP's own switch is off under this change and Clubhouse mode keeps it on at app level. */
  appKeptByClubhouseMode: boolean;
  /** Projects that lose MCP, by name. */
  projectsLosing: string[];
  /** Agents that lose Clubhouse tools, helpers aside. */
  agentsLosing: number;
  /** Agents that keep MCP: in a project that keeps it, or through their own setting. */
  agentsKeeping: number;
  /** Helpers that lose it. They can still report to their parent. */
  helpersReportOnly: number;
  /** Of those, the ones whose saved settings let them orchestrate. */
  orchestratorsLosing: number;
  /** Of those, the ones connected to the Dispatcher. */
  connectedLosing: number;
  /** Of those, the ones running now. They keep running. */
  runningLosing: number;
  /** Of those, the ones with helpers. */
  runningOrchestratorsWithHelpers: number;
  /** The Dispatcher is on and this change turns it off. */
  dispatcherGoesOff: boolean;
  dispatcherRunning: boolean;
  /** What keeps MCP through a setting of its own. */
  keeps: {
    projects: Array<{ name: string; via: McpKeptBy }>;
    agents: Array<{ name: string; project: string }>;
  };
  /** Projects left out of the counts because their agents couldn't be read. */
  unreadableProjects: string[];
}
