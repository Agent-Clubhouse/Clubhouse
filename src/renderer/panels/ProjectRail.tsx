import { useProjectStore } from '../stores/projectStore';

function ProjectIcon({ name, isActive, onClick }: {
  name: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const letter = name.charAt(0).toUpperCase();
  return (
    <button
      onClick={onClick}
      title={name}
      className={`
        w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold
        transition-all duration-150 cursor-pointer
        ${isActive
          ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30'
          : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
        }
      `}
    >
      {letter}
    </button>
  );
}

export function ProjectRail() {
  const { projects, activeProjectId, setActiveProject, pickAndAddProject } =
    useProjectStore();

  const isHome = activeProjectId === null;

  return (
    <div className="flex flex-col items-center py-3 gap-2 bg-ctp-mantle border-r border-surface-0 h-full">
      {/* Home button */}
      <button
        onClick={() => setActiveProject(null)}
        title="Home"
        className={`
          w-10 h-10 rounded-lg flex items-center justify-center
          transition-all duration-150 cursor-pointer
          ${isHome
            ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30'
            : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
          }
        `}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>

      <div className="w-6 border-t border-surface-2 my-1" />

      {projects.map((p) => (
        <ProjectIcon
          key={p.id}
          name={p.name}
          isActive={p.id === activeProjectId}
          onClick={() => setActiveProject(p.id)}
        />
      ))}
      <button
        onClick={() => pickAndAddProject()}
        title="Add project"
        className="w-10 h-10 rounded-lg flex items-center justify-center text-lg
          text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1
          transition-all duration-150 cursor-pointer border border-dashed border-surface-2"
      >
        +
      </button>
    </div>
  );
}
