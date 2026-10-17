import { useMemo, useRef } from 'react';
import type { Agent, AgentDetailedStatus, Project } from '../../../shared/types';
import { AgentRow, MarkedText } from './AgentRow';
import { ProjectSquare } from './ProjectGroup';
import { useTreeKeyboard } from './ProjectTree';
import { agentDot, filterTree } from './treeModel';

/**
 * The project tree narrowed by the sidebar filter (#2031): each project with a
 * match, its matching agents (sleeping ones too) with the matched letters
 * marked. With nothing found, Search everything hands the query to the palette.
 */

const ROW_INDENT = 26;

const ChevronDown = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export interface FilterResultsProps {
  query: string;
  projects: Project[];
  projectIcons: Record<string, string>;
  agentsByProject: Record<string, Agent[]>;
  detailed: Record<string, AgentDetailedStatus>;
  activeAgentId: string | null;
  onSelectProject: (projectId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onOpenTerminal?: (agent: Agent) => void;
  terminalProjectIds?: ReadonlySet<string>;
  onSearchEverything: () => void;
}

export function FilterResults(props: FilterResultsProps) {
  const { query, projects, projectIcons, agentsByProject, detailed, activeAgentId } = props;
  const { groups, count } = useMemo(() => filterTree(query, projects, agentsByProject), [query, projects, agentsByProject]);
  const treeRef = useRef<HTMLDivElement>(null);
  const keyboard = useTreeKeyboard(treeRef, activeAgentId ? `agent:${activeAgentId}` : null);
  const q = query.trim();

  if (groups.length === 0) {
    return (
      <section aria-label="Filter results" data-testid="filter-results" className="flex flex-col min-h-0">
        <div className="flex-shrink-0 flex items-center px-3 pt-2 pb-1 border-t border-surface-0">
          <span className="text-xs font-semibold text-ctp-subtext0">No matches</span>
        </div>
        <div className="px-3.5 py-3 flex flex-col gap-2.5">
          <p className="text-[12.5px] leading-normal text-ctp-overlay1">
            No agent or project here matches <span className="text-ctp-text">{q}</span>.
          </p>
          <div>
            <button
              type="button"
              data-testid="filter-search-everything"
              onClick={props.onSearchEverything}
              className="h-7 px-2.5 rounded-md border border-surface-1 flex items-center gap-1.5 text-xs font-medium text-ctp-text hover:bg-surface-0 cursor-pointer focus-ring"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              Search everything
            </button>
          </div>
          <p className="text-xs text-ctp-overlay1">Opens the command palette with {q} already typed.</p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Filter results" data-testid="filter-results" className="flex flex-col min-h-0">
      <div className="flex-shrink-0 flex items-center px-3 pt-2 pb-1 border-t border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0">{count} {count === 1 ? 'match' : 'matches'}</span>
        <span className="ml-auto text-xs text-ctp-overlay1">{groups.length} {groups.length === 1 ? 'project' : 'projects'}</span>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Matching projects and agents"
        onKeyDown={keyboard.onKeyDown}
        onFocus={keyboard.onFocus}
        className="flex-1 min-h-0 overflow-y-auto pb-2 flex flex-col gap-px"
      >
        {groups.map(({ project, agents }) => {
          const key = `project:${project.id}`;
          return (
            <div key={project.id} role="group" className="flex flex-col gap-px">
              <div
                role="treeitem"
                aria-level={1}
                aria-expanded={agents.length > 0 ? true : undefined}
                aria-selected={false}
                data-tree-key={key}
                data-testid={`filter-project-${project.id}`}
                onClick={() => props.onSelectProject(project.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelectProject(project.id); } }}
                className="h-7 mx-1.5 pl-2 pr-2.5 rounded-md flex items-center gap-[7px] text-[13px] text-ctp-text cursor-pointer hover:bg-surface-0/60 focus-ring"
              >
                <span className="text-ctp-overlay0 flex">{ChevronDown}</span>
                <ProjectSquare project={project} iconUrl={projectIcons[project.id]} />
                <span className="font-semibold truncate"><MarkedText text={project.displayName || project.name} query={q} /></span>
              </div>
              {agents.length > 0 && <div className="flex flex-col gap-px px-1.5">{agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    dot={agentDot(agent, detailed[agent.id])}
                    detailed={detailed[agent.id]}
                    active={agent.id === activeAgentId}
                    indent={ROW_INDENT}
                    projectPath={project.path}
                    onSelect={props.onSelectAgent}
                    onOpenTerminal={props.terminalProjectIds?.has(project.id) ? props.onOpenTerminal : undefined}
                    parentKey={key}
                    highlight={q}
                  />
              ))}</div>}
            </div>
          );
        })}
        <div className="mx-3.5 mt-2.5 flex items-center gap-1.5 text-xs text-ctp-overlay1">
          <kbd className="border border-surface-1 rounded px-1 leading-4 font-sans">Esc</kbd>
          clears the filter
        </div>
      </div>
    </section>
  );
}
