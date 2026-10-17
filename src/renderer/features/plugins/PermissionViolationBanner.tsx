import { useState } from 'react';
import { usePluginStore } from '../../plugins/plugin-store';
import { NoticeCard } from '../../components/NoticeCard';
import { Button } from '../../components/Button';

/** `bar` is the classic strip; `card` is the new chrome's sidebar notice (#2014). */
export function PermissionViolationBanner({ variant = 'bar' }: { variant?: 'bar' | 'card' } = {}) {
  const violations = usePluginStore((s) => s.permissionViolations);
  const clearPermissionViolation = usePluginStore((s) => s.clearPermissionViolation);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const visible = violations.filter((v) => !dismissed.has(v.pluginId));
  if (visible.length === 0) return null;

  const dismissOne = (pluginId: string) => {
    setDismissed((prev) => new Set(prev).add(pluginId));
    clearPermissionViolation(pluginId);
  };

  if (variant === 'card') {
    return (
      <>
        {visible.map((v) => (
          <NoticeCard key={v.pluginId} tone="error" title="Plugin disabled" meta={v.pluginName} testId="permission-violation-banner"
            actions={<Button kind="quiet" onClick={() => dismissOne(v.pluginId)}>Dismiss</Button>}>
            {v.pluginName} tried to use <code className="font-mono text-ctp-subtext1">api.{v.apiName}</code> without
            the <code className="font-mono text-ctp-subtext1">{v.permission}</code> permission.
          </NoticeCard>
        ))}
      </>
    );
  }

  return (
    <>
      {visible.map((v) => (
        <div
          key={v.pluginId}
          data-testid="permission-violation-banner"
          className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-ctp-error/10 border-b border-ctp-error/20 text-ctp-error text-sm"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span className="flex-1">
            Plugin <strong>{v.pluginName}</strong> was disabled: it tried to use{' '}
            <code className="text-xs font-mono bg-ctp-error/20 px-1 py-0.5 rounded">api.{v.apiName}</code>{' '}
            without the required{' '}
            <code className="text-xs font-mono bg-ctp-error/20 px-1 py-0.5 rounded">{v.permission}</code>{' '}
            permission.
          </span>
          <button
            onClick={() => dismissOne(v.pluginId)}
            className="text-ctp-error/50 hover:text-ctp-error transition-colors cursor-pointer px-1"
          >
            x
          </button>
        </div>
      ))}
    </>
  );
}
