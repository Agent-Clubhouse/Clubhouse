import { useOnboardingStore, Cohort } from '../../stores/onboardingStore';

interface TopicSection {
  title: string;
  body: string;
}

function getTopicsForCohort(cohort: Cohort): TopicSection[] {
  const shared: TopicSection = {
    title: 'Projects, Quick Agents & Durable Agents',
    body: 'Clubhouse organizes everything into projects — each project maps to a repository or workspace on your machine. Inside a project you have two kinds of agents: quick agents handle short, focused tasks like answering questions, generating snippets, or running one-off commands. Durable agents are long-lived — they get their own branch and worktree, persist across sessions, and are designed for larger missions like building a feature end-to-end, performing multi-step refactors, or running test suites. You can have multiple durable agents active at once, each working independently.',
  };

  if (cohort === 'new-dev') {
    return [
      shared,
      {
        title: 'How Agents Work Under the Hood',
        body: 'When an agent works on your code, it creates a branch — think of it as a separate copy of your project. The agent makes all its changes on that copy, so your main project is never affected until you decide to merge. Merging means taking the agent\'s work and bringing it into your main project. You don\'t need to learn Git commands to use Clubhouse — the agents handle all of that for you. Just know that your code is always safe, and you\'re always in control of what gets merged.',
      },
      {
        title: 'Let Agents Do the Heavy Lifting',
        body: 'The core workflow in Clubhouse is simple: describe what you need in plain language, and an agent does the work. Agents can write code, create files, run tests, fix bugs, and open pull requests — all from your description. You review the result and decide whether to accept it. Think of agents as tireless collaborators: they don\'t get bored, they don\'t forget context, and they can work on multiple things at once. Start with small tasks to build confidence, then work your way up to larger missions.',
      },
    ];
  }

  if (cohort === 'experienced-dev') {
    return [
      shared,
      {
        title: 'Git Worktrees for Parallel Work',
        body: 'Every durable agent in Clubhouse operates in its own Git worktree — a fully independent checkout of the same repository. This means no more stashing work-in-progress, no branch-switching overhead, and no merge conflicts between agents. Each worktree has its own working directory and branch, so agents can write code, run builds, and execute tests in complete isolation. You can have multiple agents working in parallel on different features, bug fixes, or refactors without any of them interfering with each other or with your own work.',
      },
      {
        title: 'Built-in Project Tools',
        body: 'Clubhouse includes a suite of project tools so your workflow stays in one place. Issues lets you track bugs, features, and tasks directly inside the app — create them manually or let agents file them as they discover problems. The Wiki gives you a place to document architecture decisions, onboarding guides, API references, and anything else your team needs to know. Both integrate with your agents, so your project management and your coding environment are the same thing.',
      },
    ];
  }

  // seasoned-dev
  return [
    shared,
    {
      title: 'Parallel Agents, Isolated Worktrees',
      body: 'Clubhouse is built for running multiple agents simultaneously. Each durable agent gets its own Git worktree with a dedicated branch, so you can spin up three, five, or ten agents at once — each tackling a different task — without any coordination overhead. There\'s no stashing, no branch switching, and no risk of agents stepping on each other\'s work. Agents operate fully independently: they write code, run tests, commit, and produce PRs in their isolated environments. You monitor everything from the hub and merge results when they\'re ready.',
    },
    {
      title: 'Per-Agent Settings',
      body: 'Each agent can be configured independently with its own permissions, system prompts, and tool constraints. You can scope an agent to read-only access for safe exploration, give another full write and deploy permissions for shipping, or restrict a third to only run tests. System prompts let you give each agent specific instructions — "focus only on the API layer," "follow our style guide," "never modify the database schema" — so they stay focused on their mission. This per-worktree configuration means you can run agents with very different trust levels and responsibilities side by side, all within the same project.',
    },
  ];
}

function CohortTopics({ cohort }: { cohort: Cohort }) {
  const topics = getTopicsForCohort(cohort);

  return (
    <div className="space-y-6 mt-6" data-testid="getting-started-topics">
      <div className="border-t border-surface-0" />
      <h3 className="text-sm font-medium text-ctp-text">Your Learning Track</h3>
      {topics.map((topic, i) => (
        <div key={i} className="space-y-1.5" data-testid={`topic-section-${i}`}>
          <h4 className="text-sm font-medium text-ctp-text">{topic.title}</h4>
          <p className="text-sm text-ctp-subtext0 leading-relaxed">{topic.body}</p>
        </div>
      ))}
    </div>
  );
}

export function GettingStartedSettingsView() {
  const completed = useOnboardingStore((s) => s.completed);
  const cohort = useOnboardingStore((s) => s.cohort);
  const startOnboarding = useOnboardingStore((s) => s.startOnboarding);

  return (
    <div className="h-full bg-ctp-base overflow-y-auto" data-testid="getting-started-settings">
      <div className="max-w-xl mx-auto px-6 py-8">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Getting Started</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Review the onboarding walkthrough anytime.
        </p>

        <div className="flex items-center justify-between p-4 rounded-xl border border-surface-1 bg-ctp-mantle">
          <div>
            <p className="text-sm font-medium text-ctp-text">Onboarding Walkthrough</p>
            <p className="text-xs text-ctp-subtext0 mt-1">
              {completed
                ? "You've completed the onboarding flow. Show it again to revisit the highlights."
                : "Walk through Clubhouse's key features and get set up."}
            </p>
          </div>
          <button
            onClick={startOnboarding}
            data-testid="show-onboarding-btn"
            className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer flex-shrink-0 ml-4"
          >
            {completed ? 'Show Again' : 'Start'}
          </button>
        </div>

        {cohort && <CohortTopics cohort={cohort} />}
      </div>
    </div>
  );
}
