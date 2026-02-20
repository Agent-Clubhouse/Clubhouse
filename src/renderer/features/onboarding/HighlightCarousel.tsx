import { Cohort } from '../../stores/onboardingStore';
import {
  ClubhouseStructureIllustration,
  AgentBranchesIllustration,
  AgentsHandleTasksIllustration,
  GitWorktreeIllustration,
  ProjectToolsIllustration,
  ParallelAgentsIllustration,
  PerAgentSettingsIllustration,
} from './illustrations';

interface HighlightSlide {
  illustration: React.ReactNode;
  title: string;
  description: string;
}

function getSlidesForCohort(cohort: Cohort): HighlightSlide[] {
  const slide1: HighlightSlide = {
    illustration: <ClubhouseStructureIllustration className="w-full h-full" />,
    title: 'Projects, Durable Agents & Quick Agents',
    description:
      'Clubhouse organizes your work into projects. Use durable agents for long-running missions that persist across sessions and quick agents for fast, one-off tasks.',
  };

  if (cohort === 'new-dev') {
    return [
      slide1,
      {
        illustration: <AgentBranchesIllustration className="w-full h-full" />,
        title: 'Agents Use Git Under the Hood',
        description:
          'Agents use Git under the hood to keep your code safe. Tell an agent to branch off, make changes, and merge back when you\'re happy with the result. Your main project is never touched until you say so.',
      },
      {
        illustration: <AgentsHandleTasksIllustration className="w-full h-full" />,
        title: 'Let Agents Do the Heavy Lifting',
        description:
          'Describe what you need and agents write code, run tests, and open pull requests for you. Review their work and merge when you\'re happy.',
      },
    ];
  }

  if (cohort === 'experienced-dev') {
    return [
      slide1,
      {
        illustration: <GitWorktreeIllustration className="w-full h-full" />,
        title: 'Git Worktrees for Parallel Work',
        description:
          'Each durable agent gets its own worktree — a separate checkout of the same repo. No more stashing or branch switching; agents work in parallel without conflicts.',
      },
      {
        illustration: <ProjectToolsIllustration className="w-full h-full" />,
        title: 'Built-in Project Tools',
        description:
          'Track work with Issues, document knowledge in the Wiki, and set up Automations — all without leaving Clubhouse. Enable and configure project tools in the Plugins settings page.',
      },
    ];
  }

  // seasoned-dev
  return [
    slide1,
    {
      illustration: <ParallelAgentsIllustration className="w-full h-full" />,
      title: 'Parallel Agents, Isolated Worktrees',
      description:
        'Spin up multiple agents at once, each in its own worktree with a dedicated branch. They work in parallel without conflicts — no stashing, no branch switching, no waiting.',
    },
    {
      illustration: <PerAgentSettingsIllustration className="w-full h-full" />,
      title: 'Per-Agent Settings',
      description:
        'Give each agent its own permissions, system prompts, and tool constraints. Scope instructions per worktree so agents stay focused on their mission without overstepping.',
    },
  ];
}

interface HighlightCarouselProps {
  cohort: Cohort;
  currentIndex: number;
  onNext: () => void;
  onPrev: () => void;
}

export function HighlightCarousel({ cohort, currentIndex, onNext, onPrev }: HighlightCarouselProps) {
  const slides = getSlidesForCohort(cohort);
  const slide = slides[currentIndex];

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-[520px]" data-testid="highlight-carousel">
      {/* Illustration */}
      <div className="w-full h-[200px] flex items-center justify-center rounded-lg bg-ctp-base border border-surface-0 overflow-hidden">
        {slide.illustration}
      </div>

      {/* Text */}
      <div className="text-center px-4">
        <h2 className="text-lg font-semibold text-ctp-text mb-2">{slide.title}</h2>
        <p className="text-sm text-ctp-subtext0 leading-relaxed">{slide.description}</p>
      </div>

      {/* Dots */}
      <div className="flex gap-2" data-testid="carousel-dots">
        {slides.map((_, i) => (
          <span
            key={i}
            className={`w-2 h-2 rounded-full transition-colors ${
              i === currentIndex ? 'bg-ctp-accent' : 'bg-surface-2'
            }`}
            data-testid={`carousel-dot-${i}`}
          />
        ))}
      </div>

      {/* Navigation */}
      <div className="flex gap-3">
        <button
          onClick={onPrev}
          className="px-4 py-2 text-sm rounded-lg bg-surface-0 border border-surface-2 text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1 transition-colors cursor-pointer"
          data-testid="carousel-prev"
        >
          Back
        </button>
        <button
          onClick={onNext}
          className="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
          data-testid="carousel-next"
        >
          {currentIndex === slides.length - 1 ? 'Continue' : 'Next'}
        </button>
      </div>
    </div>
  );
}
