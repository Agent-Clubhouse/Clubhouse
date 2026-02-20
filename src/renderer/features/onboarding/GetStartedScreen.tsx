interface GetStartedScreenProps {
  onGetStarted: () => void;
  onOpenHelp: () => void;
  onOpenExtensibility: () => void;
}

export function GetStartedScreen({ onGetStarted, onOpenHelp, onOpenExtensibility }: GetStartedScreenProps) {
  return (
    <div className="flex flex-col items-center gap-8 max-w-[420px]" data-testid="get-started-screen">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-ctp-text mb-2">You're All Set!</h2>
        <p className="text-sm text-ctp-subtext0 leading-relaxed">
          Ready to start building? Here are some resources to help you along the way.
        </p>
      </div>

      <div className="flex flex-col gap-3 w-full">
        <button
          onClick={onOpenHelp}
          data-testid="onboarding-help-btn"
          className="flex items-center gap-3 p-4 rounded-xl border border-surface-1 bg-ctp-base
            hover:border-ctp-accent/50 hover:bg-surface-0 transition-colors cursor-pointer text-left"
        >
          <span className="text-2xl">📖</span>
          <div>
            <p className="text-sm font-medium text-ctp-text">In-App Help</p>
            <p className="text-xs text-ctp-subtext0">Browse guides and documentation</p>
          </div>
        </button>

        <button
          onClick={onOpenExtensibility}
          data-testid="onboarding-extensibility-btn"
          className="flex items-center gap-3 p-4 rounded-xl border border-surface-1 bg-ctp-base
            hover:border-ctp-accent/50 hover:bg-surface-0 transition-colors cursor-pointer text-left"
        >
          <span className="text-2xl">🧩</span>
          <div>
            <p className="text-sm font-medium text-ctp-text">Extensibility & Plugins</p>
            <p className="text-xs text-ctp-subtext0">Learn how to extend Clubhouse with plugins and custom skills</p>
          </div>
        </button>
      </div>

      <button
        onClick={onGetStarted}
        data-testid="onboarding-get-started-btn"
        className="px-6 py-3 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer w-full"
      >
        Get Started
      </button>
    </div>
  );
}
