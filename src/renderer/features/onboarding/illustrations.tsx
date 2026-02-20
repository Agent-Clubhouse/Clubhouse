/** Placeholder SVG illustrations for the onboarding flow.
 *  These use Catppuccin-compatible CSS variable colors via currentColor
 *  and explicit RGB values for accent fills. */

const SVG_DEFAULTS = { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 200 160' } as const;

/* ── Cohort avatars (small, 48x48) ─────────────────────────────── */

export function NewDevAvatar({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 48 48" className={className}>
      <circle cx="24" cy="24" r="22" fill="rgb(var(--ctp-accent))" opacity="0.15" />
      <text x="24" y="30" textAnchor="middle" fontSize="22" fill="rgb(var(--ctp-accent))">
        🌱
      </text>
    </svg>
  );
}

export function ExperiencedDevAvatar({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 48 48" className={className}>
      <circle cx="24" cy="24" r="22" fill="rgb(var(--ctp-accent))" opacity="0.15" />
      <text x="24" y="30" textAnchor="middle" fontSize="22" fill="rgb(var(--ctp-accent))">
        🔧
      </text>
    </svg>
  );
}

export function SeasonedDevAvatar({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 48 48" className={className}>
      <circle cx="24" cy="24" r="22" fill="rgb(var(--ctp-accent))" opacity="0.15" />
      <text x="24" y="30" textAnchor="middle" fontSize="22" fill="rgb(var(--ctp-accent))">
        🚀
      </text>
    </svg>
  );
}

/* ── Carousel illustrations (large, ~320x200 visible area) ───── */

export function ClubhouseStructureIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      <rect x="10" y="10" width="90" height="180" rx="12" fill="rgb(var(--ctp-surface0))" />
      <text x="55" y="60" textAnchor="middle" fontSize="11" fill="rgb(var(--ctp-subtext0))">Projects</text>
      <rect x="30" y="75" width="50" height="8" rx="4" fill="rgb(var(--ctp-accent))" opacity="0.6" />
      <rect x="30" y="90" width="50" height="8" rx="4" fill="rgb(var(--ctp-surface2))" />
      <rect x="30" y="105" width="50" height="8" rx="4" fill="rgb(var(--ctp-surface2))" />

      <rect x="115" y="30" width="90" height="70" rx="12" fill="rgb(var(--ctp-surface0))" />
      <text x="160" y="55" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Quick Agents</text>
      <circle cx="140" cy="78" r="6" fill="rgb(var(--ctp-accent))" opacity="0.5" />
      <circle cx="160" cy="78" r="6" fill="rgb(var(--ctp-accent))" opacity="0.7" />
      <circle cx="180" cy="78" r="6" fill="rgb(var(--ctp-accent))" opacity="0.9" />

      <rect x="115" y="115" width="90" height="70" rx="12" fill="rgb(var(--ctp-surface0))" />
      <text x="160" y="142" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Durable Agents</text>
      <rect x="130" y="155" width="60" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.4" />
      <rect x="130" y="165" width="40" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.6" />

      <rect x="220" y="10" width="90" height="180" rx="12" fill="rgb(var(--ctp-surface0))" />
      <text x="265" y="40" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Terminal</text>
      <rect x="232" y="55" width="66" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="232" y="65" width="50" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <rect x="232" y="75" width="58" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="232" y="85" width="42" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
    </svg>
  );
}

export function GitBasicsIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Branch lines */}
      <line x1="60" y1="40" x2="60" y2="160" stroke="rgb(var(--ctp-accent))" strokeWidth="3" opacity="0.6" />
      <line x1="60" y1="80" x2="160" y2="80" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />
      <line x1="160" y1="80" x2="160" y2="130" stroke="rgb(var(--ctp-accent))" strokeWidth="3" opacity="0.4" />
      <line x1="160" y1="130" x2="60" y2="140" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" strokeDasharray="4" />

      {/* Commit dots */}
      <circle cx="60" cy="40" r="8" fill="rgb(var(--ctp-accent))" />
      <circle cx="60" cy="80" r="8" fill="rgb(var(--ctp-accent))" />
      <circle cx="60" cy="120" r="8" fill="rgb(var(--ctp-accent))" />
      <circle cx="60" cy="160" r="8" fill="rgb(var(--ctp-accent))" />
      <circle cx="160" cy="80" r="6" fill="rgb(var(--ctp-accent))" opacity="0.6" />
      <circle cx="160" cy="105" r="6" fill="rgb(var(--ctp-accent))" opacity="0.6" />
      <circle cx="160" cy="130" r="6" fill="rgb(var(--ctp-accent))" opacity="0.6" />

      {/* Labels */}
      <text x="80" y="44" fontSize="11" fill="rgb(var(--ctp-text))">main</text>
      <text x="175" y="84" fontSize="11" fill="rgb(var(--ctp-subtext0))">feature</text>

      <rect x="200" y="30" width="100" height="140" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="250" y="55" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Save points</text>
      <text x="250" y="75" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">for your code</text>
      <text x="250" y="110" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Branches let</text>
      <text x="250" y="130" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">you experiment</text>
      <text x="250" y="150" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">safely</text>
    </svg>
  );
}

export function AgentsHandleTasksIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* User */}
      <circle cx="60" cy="60" r="20" fill="rgb(var(--ctp-surface0))" />
      <text x="60" y="66" textAnchor="middle" fontSize="18">👤</text>
      <text x="60" y="100" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">You</text>

      {/* Arrow */}
      <line x1="90" y1="60" x2="140" y2="60" stroke="rgb(var(--ctp-accent))" strokeWidth="2" markerEnd="url(#arrow)" />
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="rgb(var(--ctp-accent))" />
        </marker>
      </defs>

      {/* Mission box */}
      <rect x="145" y="40" width="70" height="40" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <text x="180" y="65" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Mission</text>

      {/* Arrow to agent */}
      <line x1="220" y1="60" x2="245" y2="60" stroke="rgb(var(--ctp-accent))" strokeWidth="2" markerEnd="url(#arrow)" />

      {/* Agent */}
      <circle cx="270" cy="60" r="20" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <text x="270" y="66" textAnchor="middle" fontSize="18">🤖</text>
      <text x="270" y="100" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Agent</text>

      {/* Result files */}
      <rect x="100" y="130" width="120" height="50" rx="8" fill="rgb(var(--ctp-surface0))" />
      <text x="160" y="152" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Code changes,</text>
      <text x="160" y="168" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">tests, and PRs</text>
      <line x1="270" y1="85" x2="200" y2="130" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" strokeDasharray="4" />
    </svg>
  );
}

export function GitWorktreeIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Main repo */}
      <rect x="20" y="20" width="80" height="160" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="60" y="50" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Main Repo</text>
      <rect x="32" y="65" width="56" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.5" />
      <rect x="32" y="80" width="56" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="32" y="95" width="56" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.4" />

      {/* Worktree branches */}
      <line x1="100" y1="80" x2="140" y2="50" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />
      <line x1="100" y1="100" x2="140" y2="100" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />
      <line x1="100" y1="120" x2="140" y2="150" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />

      {/* Worktrees */}
      <rect x="140" y="20" width="70" height="60" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="1" opacity="0.3" />
      <text x="175" y="45" textAnchor="middle" fontSize="9" fill="rgb(var(--ctp-text))">Worktree A</text>
      <text x="175" y="60" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">feature-1</text>

      <rect x="140" y="90" width="70" height="60" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="1" opacity="0.3" />
      <text x="175" y="115" textAnchor="middle" fontSize="9" fill="rgb(var(--ctp-text))">Worktree B</text>
      <text x="175" y="130" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">bugfix-2</text>

      <rect x="140" y="160" width="70" height="30" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.1" />
      <text x="175" y="180" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">...</text>

      {/* Description */}
      <rect x="230" y="40" width="80" height="120" rx="8" fill="rgb(var(--ctp-surface0))" />
      <text x="270" y="70" textAnchor="middle" fontSize="9" fill="rgb(var(--ctp-subtext0))">Parallel work</text>
      <text x="270" y="85" textAnchor="middle" fontSize="9" fill="rgb(var(--ctp-subtext0))">without</text>
      <text x="270" y="100" textAnchor="middle" fontSize="9" fill="rgb(var(--ctp-subtext0))">switching</text>
      <text x="270" y="115" textAnchor="middle" fontSize="9" fill="rgb(var(--ctp-subtext0))">branches</text>
    </svg>
  );
}

export function AgentCustomizationIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Agent */}
      <circle cx="60" cy="100" r="30" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <text x="60" y="106" textAnchor="middle" fontSize="24">🤖</text>

      {/* Config items */}
      <rect x="120" y="20" width="180" height="40" rx="8" fill="rgb(var(--ctp-surface0))" />
      <text x="135" y="38" fontSize="10" fill="rgb(var(--ctp-accent))">⚙</text>
      <text x="150" y="38" fontSize="10" fill="rgb(var(--ctp-text))">Permissions</text>
      <text x="150" y="52" fontSize="8" fill="rgb(var(--ctp-subtext0))">Control what agents can do</text>

      <rect x="120" y="75" width="180" height="40" rx="8" fill="rgb(var(--ctp-surface0))" />
      <text x="135" y="93" fontSize="10" fill="rgb(var(--ctp-accent))">📋</text>
      <text x="150" y="93" fontSize="10" fill="rgb(var(--ctp-text))">Skills</text>
      <text x="150" y="107" fontSize="8" fill="rgb(var(--ctp-subtext0))">Teach agents new abilities</text>

      <rect x="120" y="130" width="180" height="40" rx="8" fill="rgb(var(--ctp-surface0))" />
      <text x="135" y="148" fontSize="10" fill="rgb(var(--ctp-accent))">💬</text>
      <text x="150" y="148" fontSize="10" fill="rgb(var(--ctp-text))">Prompts</text>
      <text x="150" y="162" fontSize="8" fill="rgb(var(--ctp-subtext0))">Guide behavior with system prompts</text>

      {/* Connecting lines */}
      <line x1="90" y1="85" x2="120" y2="40" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.3" />
      <line x1="90" y1="100" x2="120" y2="95" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.3" />
      <line x1="90" y1="115" x2="120" y2="150" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.3" />
    </svg>
  );
}

export function DurableWorktreeIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Durable agent */}
      <rect x="20" y="40" width="80" height="120" rx="12" fill="rgb(var(--ctp-accent))" opacity="0.15" />
      <text x="60" y="70" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Durable</text>
      <text x="60" y="85" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Agent</text>
      <text x="60" y="115" textAnchor="middle" fontSize="20">🏠</text>
      <text x="60" y="145" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Persistent</text>

      {/* Arrow */}
      <line x1="105" y1="100" x2="135" y2="100" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.5" />
      <polygon points="135,95 145,100 135,105" fill="rgb(var(--ctp-accent))" opacity="0.5" />

      {/* Worktree */}
      <rect x="150" y="20" width="150" height="70" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="225" y="45" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Own Worktree</text>
      <text x="225" y="62" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Isolated branch + directory</text>
      <text x="225" y="78" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Won't conflict with your work</text>

      {/* Mission */}
      <rect x="150" y="110" width="150" height="70" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="225" y="135" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Long-Running Tasks</text>
      <text x="225" y="152" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Features, refactors, fixes</text>
      <text x="225" y="168" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Commits, branches, and PRs</text>
    </svg>
  );
}

export function MultiAgentHubIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Hub center */}
      <circle cx="160" cy="100" r="35" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.3" />
      <text x="160" y="96" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Agent</text>
      <text x="160" y="112" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Hub</text>

      {/* Surrounding agents */}
      <circle cx="60" cy="50" r="20" fill="rgb(var(--ctp-surface0))" />
      <text x="60" y="56" textAnchor="middle" fontSize="14">🤖</text>
      <line x1="80" y1="60" x2="130" y2="80" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.3" />

      <circle cx="260" cy="50" r="20" fill="rgb(var(--ctp-surface0))" />
      <text x="260" y="56" textAnchor="middle" fontSize="14">🤖</text>
      <line x1="240" y1="60" x2="190" y2="80" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.3" />

      <circle cx="60" cy="150" r="20" fill="rgb(var(--ctp-surface0))" />
      <text x="60" y="156" textAnchor="middle" fontSize="14">🤖</text>
      <line x1="80" y1="140" x2="130" y2="120" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.3" />

      <circle cx="260" cy="150" r="20" fill="rgb(var(--ctp-surface0))" />
      <text x="260" y="156" textAnchor="middle" fontSize="14">🤖</text>
      <line x1="240" y1="140" x2="190" y2="120" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.3" />

      {/* Labels */}
      <text x="60" y="25" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Agent 1</text>
      <text x="260" y="25" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Agent 2</text>
      <text x="60" y="185" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Agent 3</text>
      <text x="260" y="185" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Agent 4</text>
    </svg>
  );
}
