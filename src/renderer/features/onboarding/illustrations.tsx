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
      <text x="160" y="55" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Durable Agents</text>
      <rect x="130" y="70" width="60" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.4" />
      <rect x="130" y="80" width="40" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.6" />

      <rect x="115" y="115" width="90" height="70" rx="12" fill="rgb(var(--ctp-surface0))" />
      <text x="160" y="142" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Quick Agents</text>
      <circle cx="140" cy="163" r="6" fill="rgb(var(--ctp-accent))" opacity="0.5" />
      <circle cx="160" cy="163" r="6" fill="rgb(var(--ctp-accent))" opacity="0.7" />
      <circle cx="180" cy="163" r="6" fill="rgb(var(--ctp-accent))" opacity="0.9" />

      <rect x="220" y="10" width="90" height="180" rx="12" fill="rgb(var(--ctp-surface0))" />
      <text x="265" y="40" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Terminal</text>
      <rect x="232" y="55" width="66" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="232" y="65" width="50" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <rect x="232" y="75" width="58" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="232" y="85" width="42" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
    </svg>
  );
}

export function AgentBranchesIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Main branch line */}
      <line x1="60" y1="40" x2="60" y2="160" stroke="rgb(var(--ctp-accent))" strokeWidth="3" opacity="0.6" />

      {/* Agent branch */}
      <line x1="60" y1="70" x2="160" y2="70" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />
      <line x1="160" y1="70" x2="160" y2="120" stroke="rgb(var(--ctp-accent))" strokeWidth="3" opacity="0.4" />
      <line x1="160" y1="120" x2="60" y2="135" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" strokeDasharray="4" />

      {/* Main commits */}
      <circle cx="60" cy="40" r="8" fill="rgb(var(--ctp-accent))" />
      <circle cx="60" cy="70" r="8" fill="rgb(var(--ctp-accent))" />
      <circle cx="60" cy="135" r="8" fill="rgb(var(--ctp-accent))" />
      <circle cx="60" cy="160" r="8" fill="rgb(var(--ctp-accent))" />

      {/* Agent commits */}
      <circle cx="160" cy="70" r="6" fill="rgb(var(--ctp-accent))" opacity="0.6" />
      <circle cx="160" cy="95" r="6" fill="rgb(var(--ctp-accent))" opacity="0.6" />
      <circle cx="160" cy="120" r="6" fill="rgb(var(--ctp-accent))" opacity="0.6" />

      {/* Labels */}
      <text x="80" y="44" fontSize="11" fill="rgb(var(--ctp-text))">your project</text>
      <text x="175" y="74" fontSize="11" fill="rgb(var(--ctp-subtext0))">agent's copy</text>

      {/* Agent icon on branch */}
      <text x="185" y="100" fontSize="14">🤖</text>

      {/* Explanation */}
      <rect x="210" y="40" width="100" height="120" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="260" y="65" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Agents work</text>
      <text x="260" y="82" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">on a copy</text>
      <text x="260" y="110" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">Your code</text>
      <text x="260" y="127" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">stays safe</text>
      <text x="260" y="148" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-subtext0))">until you merge</text>
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
      <rect x="140" y="20" width="70" height="60" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.2" stroke="rgb(var(--ctp-accent))" strokeWidth="1" />
      <text x="175" y="45" textAnchor="middle" fontSize="9" fill="rgb(var(--ctp-text))">Worktree A</text>
      <text x="175" y="60" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">feature-1</text>

      <rect x="140" y="90" width="70" height="60" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.2" stroke="rgb(var(--ctp-accent))" strokeWidth="1" />
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

export function ProjectToolsIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Issues */}
      <rect x="20" y="30" width="85" height="140" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="62" y="58" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Issues</text>
      <circle cx="40" cy="78" r="5" fill="rgb(var(--ctp-accent))" opacity="0.7" />
      <rect x="50" y="74" width="44" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <circle cx="40" cy="96" r="5" fill="rgb(var(--ctp-accent))" opacity="0.5" />
      <rect x="50" y="92" width="38" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <circle cx="40" cy="114" r="5" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="50" y="110" width="42" height="6" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <rect x="32" y="132" width="60" height="6" rx="3" fill="rgb(var(--ctp-surface2))" />
      <rect x="32" y="148" width="45" height="6" rx="3" fill="rgb(var(--ctp-surface2))" />

      {/* Wiki */}
      <rect x="118" y="30" width="85" height="140" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="160" y="58" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Wiki</text>
      <rect x="130" y="72" width="62" height="5" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.4" />
      <rect x="130" y="83" width="55" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <rect x="130" y="93" width="60" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <rect x="130" y="103" width="48" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <rect x="130" y="118" width="62" height="5" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.4" />
      <rect x="130" y="129" width="52" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />
      <rect x="130" y="139" width="58" height="4" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />

      {/* Automations */}
      <rect x="216" y="30" width="85" height="140" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="258" y="58" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Automations</text>
      <rect x="230" y="72" width="52" height="22" rx="6" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="1" />
      <text x="256" y="87" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Trigger</text>
      <line x1="256" y1="94" x2="256" y2="108" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.4" />
      <polygon points="252,106 260,106 256,112" fill="rgb(var(--ctp-accent))" opacity="0.4" />
      <rect x="230" y="112" width="52" height="22" rx="6" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="1" />
      <text x="256" y="127" textAnchor="middle" fontSize="8" fill="rgb(var(--ctp-subtext0))">Action</text>
      <line x1="256" y1="134" x2="256" y2="148" stroke="rgb(var(--ctp-accent))" strokeWidth="1.5" opacity="0.4" />
      <polygon points="252,146 260,146 256,152" fill="rgb(var(--ctp-accent))" opacity="0.4" />
      <rect x="230" y="152" width="52" height="14" rx="6" fill="rgb(var(--ctp-accent))" opacity="0.1" />
      <text x="256" y="162" textAnchor="middle" fontSize="7" fill="rgb(var(--ctp-subtext0))">...</text>
    </svg>
  );
}

export function ParallelAgentsIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Main repo */}
      <rect x="15" y="55" width="70" height="90" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="50" y="80" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Your</text>
      <text x="50" y="93" textAnchor="middle" fontSize="10" fill="rgb(var(--ctp-text))">Repo</text>
      <rect x="27" y="108" width="46" height="5" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.4" />
      <rect x="27" y="118" width="38" height="5" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="27" y="128" width="42" height="5" rx="2" fill="rgb(var(--ctp-accent))" opacity="0.2" />

      {/* Fan-out lines */}
      <line x1="85" y1="80" x2="130" y2="40" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />
      <line x1="85" y1="100" x2="130" y2="100" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />
      <line x1="85" y1="120" x2="130" y2="160" stroke="rgb(var(--ctp-accent))" strokeWidth="2" opacity="0.4" />

      {/* Agent 1 + worktree */}
      <rect x="130" y="15" width="170" height="50" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="1" />
      <text x="148" y="38" fontSize="14">🤖</text>
      <text x="170" y="35" fontSize="9" fill="rgb(var(--ctp-text))">Agent 1</text>
      <text x="170" y="50" fontSize="8" fill="rgb(var(--ctp-subtext0))">feature/auth</text>
      <rect x="248" y="28" width="40" height="8" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="248" y="42" width="32" height="8" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.2" />

      {/* Agent 2 + worktree */}
      <rect x="130" y="75" width="170" height="50" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="1" />
      <text x="148" y="98" fontSize="14">🤖</text>
      <text x="170" y="95" fontSize="9" fill="rgb(var(--ctp-text))">Agent 2</text>
      <text x="170" y="110" fontSize="8" fill="rgb(var(--ctp-subtext0))">fix/perf-regression</text>
      <rect x="248" y="88" width="36" height="8" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="248" y="102" width="44" height="8" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.2" />

      {/* Agent 3 + worktree */}
      <rect x="130" y="135" width="170" height="50" rx="8" fill="rgb(var(--ctp-accent))" opacity="0.15" stroke="rgb(var(--ctp-accent))" strokeWidth="1" />
      <text x="148" y="158" fontSize="14">🤖</text>
      <text x="170" y="155" fontSize="9" fill="rgb(var(--ctp-text))">Agent 3</text>
      <text x="170" y="170" fontSize="8" fill="rgb(var(--ctp-subtext0))">refactor/api-layer</text>
      <rect x="248" y="148" width="42" height="8" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.3" />
      <rect x="248" y="162" width="30" height="8" rx="3" fill="rgb(var(--ctp-accent))" opacity="0.2" />
    </svg>
  );
}

export function PerAgentSettingsIllustration({ className }: { className?: string }) {
  return (
    <svg {...SVG_DEFAULTS} viewBox="0 0 320 200" className={className}>
      {/* Agent A */}
      <rect x="15" y="15" width="140" height="75" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="38" y="40" fontSize="14">🤖</text>
      <text x="58" y="38" fontSize="9" fill="rgb(var(--ctp-text))">Agent A</text>
      <rect x="28" y="50" width="115" height="14" rx="4" fill="rgb(var(--ctp-accent))" opacity="0.12" />
      <text x="33" y="60" fontSize="7" fill="rgb(var(--ctp-accent))">⚙</text>
      <text x="44" y="60" fontSize="7" fill="rgb(var(--ctp-subtext0))">Read-only, no deploy</text>
      <rect x="28" y="68" width="115" height="14" rx="4" fill="rgb(var(--ctp-accent))" opacity="0.08" />
      <text x="33" y="78" fontSize="7" fill="rgb(var(--ctp-accent))">💬</text>
      <text x="44" y="78" fontSize="7" fill="rgb(var(--ctp-subtext0))">"Focus on tests only"</text>

      {/* Agent B */}
      <rect x="165" y="15" width="140" height="75" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="188" y="40" fontSize="14">🤖</text>
      <text x="208" y="38" fontSize="9" fill="rgb(var(--ctp-text))">Agent B</text>
      <rect x="178" y="50" width="115" height="14" rx="4" fill="rgb(var(--ctp-accent))" opacity="0.12" />
      <text x="183" y="60" fontSize="7" fill="rgb(var(--ctp-accent))">⚙</text>
      <text x="194" y="60" fontSize="7" fill="rgb(var(--ctp-subtext0))">Full write access</text>
      <rect x="178" y="68" width="115" height="14" rx="4" fill="rgb(var(--ctp-accent))" opacity="0.08" />
      <text x="183" y="78" fontSize="7" fill="rgb(var(--ctp-accent))">💬</text>
      <text x="194" y="78" fontSize="7" fill="rgb(var(--ctp-subtext0))">"Implement feature X"</text>

      {/* Agent C */}
      <rect x="90" y="110" width="140" height="75" rx="10" fill="rgb(var(--ctp-surface0))" />
      <text x="113" y="135" fontSize="14">🤖</text>
      <text x="133" y="133" fontSize="9" fill="rgb(var(--ctp-text))">Agent C</text>
      <rect x="103" y="145" width="115" height="14" rx="4" fill="rgb(var(--ctp-accent))" opacity="0.12" />
      <text x="108" y="155" fontSize="7" fill="rgb(var(--ctp-accent))">⚙</text>
      <text x="119" y="155" fontSize="7" fill="rgb(var(--ctp-subtext0))">Deploy allowed</text>
      <rect x="103" y="163" width="115" height="14" rx="4" fill="rgb(var(--ctp-accent))" opacity="0.08" />
      <text x="108" y="173" fontSize="7" fill="rgb(var(--ctp-accent))">💬</text>
      <text x="119" y="173" fontSize="7" fill="rgb(var(--ctp-subtext0))">"Ship to staging"</text>
    </svg>
  );
}
