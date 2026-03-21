interface AnnexDisabledViewProps {
  pluginName: string;
}

export function AnnexDisabledView({ pluginName }: AnnexDisabledViewProps) {
  return (
    <div className="flex items-center justify-center h-full bg-ctp-base" data-testid="annex-disabled-view">
      <div className="text-center text-ctp-subtext0 max-w-md">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 opacity-50">
          <circle cx="12" cy="12" r="10" />
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
        </svg>
        <p className="text-lg mb-2">Not Annex Enabled</p>
        <p className="text-sm">
          <strong>{pluginName}</strong> has not declared Annex compatibility and cannot be used over remote control.
        </p>
      </div>
    </div>
  );
}
