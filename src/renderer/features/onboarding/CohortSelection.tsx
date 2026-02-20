import { Cohort } from '../../stores/onboardingStore';
import { NewDevAvatar, ExperiencedDevAvatar, SeasonedDevAvatar } from './illustrations';

interface CohortCardProps {
  title: string;
  description: string;
  avatar: React.ReactNode;
  onClick: () => void;
  testId: string;
}

function CohortCard({ title, description, avatar, onClick, testId }: CohortCardProps) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="flex flex-col items-center gap-3 p-6 rounded-xl border border-surface-1 bg-ctp-base
        hover:border-ctp-accent/50 hover:bg-surface-0 transition-colors cursor-pointer w-[200px]"
    >
      <div className="w-12 h-12">{avatar}</div>
      <h3 className="text-sm font-semibold text-ctp-text">{title}</h3>
      <p className="text-xs text-ctp-subtext0 text-center leading-relaxed">{description}</p>
    </button>
  );
}

interface CohortSelectionProps {
  onSelect: (cohort: Cohort) => void;
}

export function CohortSelection({ onSelect }: CohortSelectionProps) {
  return (
    <div className="flex flex-col items-center gap-8" data-testid="cohort-selection">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-ctp-text mb-2">Welcome to Clubhouse</h2>
        <p className="text-sm text-ctp-subtext0">Tell us about your experience so we can tailor your intro.</p>
      </div>

      <div className="flex gap-4">
        <CohortCard
          title="New to Development"
          description="I'm just getting started with coding and want to learn the basics."
          avatar={<NewDevAvatar />}
          onClick={() => onSelect('new-dev')}
          testId="cohort-new-dev"
        />
        <CohortCard
          title="Experienced Developer"
          description="I know my way around code but I'm new to AI agents."
          avatar={<ExperiencedDevAvatar />}
          onClick={() => onSelect('experienced-dev')}
          testId="cohort-experienced-dev"
        />
        <CohortCard
          title="Seasoned Agent Dev"
          description="I've worked with AI agents before and want advanced features."
          avatar={<SeasonedDevAvatar />}
          onClick={() => onSelect('seasoned-dev')}
          testId="cohort-seasoned-dev"
        />
      </div>
    </div>
  );
}
