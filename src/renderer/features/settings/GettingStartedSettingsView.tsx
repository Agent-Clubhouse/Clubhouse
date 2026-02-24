import { useOnboardingStore } from '../../stores/onboardingStore';

export function GettingStartedSettingsView() {
  const completed = useOnboardingStore((s) => s.completed);
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
      </div>
    </div>
  );
}
