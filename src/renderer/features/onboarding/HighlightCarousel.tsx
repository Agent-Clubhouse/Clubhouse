import { Cohort } from '../../stores/onboardingStore';
import {
  ClubhouseStructureIllustration,
  GitBasicsIllustration,
  AgentsHandleTasksIllustration,
  GitWorktreeIllustration,
  AgentCustomizationIllustration,
  DurableWorktreeIllustration,
  MultiAgentHubIllustration,
} from './illustrations';

interface HighlightSlide {
  illustration: React.ReactNode;
  title: string;
  description: string;
}

function getSlidesForCohort(cohort: Cohort): HighlightSlide[] {
  const slide1: HighlightSlide = {
    illustration: <ClubhouseStructureIllustration className="w-full h-full" />,
    title: 'Projects, Quick Agents & Durable Agents',
    description:
      'Clubhouse organizes your work into projects. Use quick agents for fast tasks and durable agents for long-running missions that persist across sessions.',
  };

  if (cohort === 'new-dev') {
    return [
      slide1,
      {
        illustration: <GitBasicsIllustration className="w-full h-full" />,
        title: 'Git: Your Code Safety Net',
        description:
          'Git tracks every change you make. Think of it as unlimited undo for your code. Branches let you experiment without risking your working code.',
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
        illustration: <AgentCustomizationIllustration className="w-full h-full" />,
        title: 'Customize Your Agents',
        description:
          'Fine-tune agent behavior with permissions, skills, and system prompts. Control which tools agents can use and teach them domain-specific workflows.',
      },
    ];
  }

  // seasoned-dev
  return [
    slide1,
    {
      illustration: <DurableWorktreeIllustration className="w-full h-full" />,
      title: 'Durable Agents & Worktrees',
      description:
        'Durable agents operate in isolated worktrees with their own branches. They persist across sessions, handle complex multi-step missions, and produce commits and PRs autonomously.',
    },
    {
      illustration: <MultiAgentHubIllustration className="w-full h-full" />,
      title: 'The Multi-Agent Hub',
      description:
        'Monitor and coordinate multiple agents from the hub view. See status, progress, and output across all running agents in one place. Orchestrate complex workflows with agent delegation.',
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
