import { useState } from 'react';

interface Props {
  label: string;
  synced: boolean;
  onToggle: (synced: boolean) => void;
}

export function ConfigOverrideToggle({ label, synced, onToggle }: Props) {
  const [confirming, setConfirming] = useState(false);

  const handleClick = () => {
    if (synced) {
      // Switching from synced → locally managed: no confirmation needed
      onToggle(false);
    } else {
      // Switching from locally managed → synced: show confirmation
      setConfirming(true);
    }
  };

  const handleConfirm = () => {
    setConfirming(false);
    onToggle(true);
  };

  const handleCancel = () => {
    setConfirming(false);
  };

  return (
    <div className="flex items-center gap-2 mb-2">
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors cursor-pointer
          border border-surface-2 hover:border-ctp-blue/50"
      >
        {synced ? (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-green">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span className="text-ctp-green">Synced from project</span>
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-peach">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span className="text-ctp-peach">Locally managed</span>
          </>
        )}
      </button>
      <span className="text-[10px] text-ctp-subtext0 uppercase tracking-wider">{label}</span>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-ctp-base border border-surface-2 rounded-lg p-4 max-w-sm shadow-xl">
            <h4 className="text-sm font-semibold text-ctp-text mb-2">Revert to project defaults?</h4>
            <p className="text-xs text-ctp-subtext0 mb-4">
              This will replace this agent's local {label.toLowerCase()} with the project default.
              Any local changes will be lost.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
                  text-ctp-text hover:bg-surface-1 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500/20 border border-red-500/50
                  text-red-400 hover:bg-red-500/30 cursor-pointer"
              >
                Revert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
