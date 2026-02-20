import { useEffect, useCallback } from 'react';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { CohortSelection } from './CohortSelection';
import { HighlightCarousel } from './HighlightCarousel';
import { GetStartedScreen } from './GetStartedScreen';

export function OnboardingModal() {
  const showOnboarding = useOnboardingStore((s) => s.showOnboarding);
  const step = useOnboardingStore((s) => s.step);
  const cohort = useOnboardingStore((s) => s.cohort);
  const highlightIndex = useOnboardingStore((s) => s.highlightIndex);
  const selectCohort = useOnboardingStore((s) => s.selectCohort);
  const nextHighlight = useOnboardingStore((s) => s.nextHighlight);
  const prevHighlight = useOnboardingStore((s) => s.prevHighlight);
  const dismissOnboarding = useOnboardingStore((s) => s.dismissOnboarding);
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const setSettingsContext = useUIStore((s) => s.setSettingsContext);

  const handleDismiss = useCallback(() => {
    dismissOnboarding();
  }, [dismissOnboarding]);

  const handleGetStarted = useCallback(() => {
    dismissOnboarding();
    pickAndAddProject();
  }, [dismissOnboarding, pickAndAddProject]);

  const handleOpenHelp = useCallback(() => {
    dismissOnboarding();
    setExplorerTab('help');
  }, [dismissOnboarding, setExplorerTab]);

  const handleOpenExtensibility = useCallback(() => {
    dismissOnboarding();
    setExplorerTab('settings');
    setSettingsContext('app');
    setSettingsSubPage('plugins');
  }, [dismissOnboarding, setExplorerTab, setSettingsContext, setSettingsSubPage]);

  // Escape key to dismiss
  useEffect(() => {
    if (!showOnboarding) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDismiss();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showOnboarding, handleDismiss]);

  if (!showOnboarding) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      data-testid="onboarding-backdrop"
      onClick={handleDismiss}
    >
      <div
        className="bg-ctp-mantle rounded-xl w-[700px] max-h-[85vh] flex flex-col shadow-xl relative overflow-hidden"
        data-testid="onboarding-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Skip / Close button */}
        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-lg
            text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 transition-colors cursor-pointer"
          data-testid="onboarding-skip"
          aria-label="Skip onboarding"
        >
          ✕
        </button>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center p-8">
          {step === 'cohort-select' && (
            <CohortSelection onSelect={selectCohort} />
          )}

          {step === 'highlights' && cohort && (
            <HighlightCarousel
              cohort={cohort}
              currentIndex={highlightIndex}
              onNext={nextHighlight}
              onPrev={prevHighlight}
            />
          )}

          {step === 'get-started' && (
            <GetStartedScreen
              onGetStarted={handleGetStarted}
              onOpenHelp={handleOpenHelp}
              onOpenExtensibility={handleOpenExtensibility}
            />
          )}
        </div>
      </div>
    </div>
  );
}
