import { ReactNode } from 'react';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, compact = false }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-4 gap-1' : 'py-8 gap-2'}`}>
      {icon && (
        <div className="text-ctp-overlay0 mb-1">
          {icon}
        </div>
      )}
      <span className={`font-medium text-ctp-subtext1 ${compact ? 'text-xs' : 'text-sm'}`}>{title}</span>
      {description && (
        <p className="text-xs text-ctp-overlay0 max-w-[240px] leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
