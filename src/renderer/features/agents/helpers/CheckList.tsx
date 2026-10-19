import type { CheckLine } from './helper-model';

const ICON: Record<CheckLine['kind'], { path: string; className: string; label: string }> = {
  ok: { path: 'M5 12l5 5 9-10', className: 'text-ctp-success', label: 'OK' },
  info: { path: 'M12 8h.01M11 12h1v5h1', className: 'text-ctp-overlay1', label: 'Note' },
  risk: { path: 'M12 4l9 16H3zM12 10v4M12 17h.01', className: 'text-ctp-warning', label: 'Would be lost' },
  failed: { path: 'M6 6l12 12M18 6L6 18', className: 'text-ctp-error', label: 'Couldn’t check' },
};

/** Dispose checks as a short list, one icon and line each (mockup "Disposing"). */
export function CheckList({ lines, testId }: { lines: CheckLine[]; testId?: string }) {
  return (
    <ul className="flex flex-col" data-testid={testId}>
      {lines.map((line) => {
        const icon = ICON[line.kind];
        return (
          <li key={line.text} className="flex items-start gap-2.5 py-1 text-[13px] text-ctp-text" data-check={line.kind}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={icon.label} className={`flex-shrink-0 mt-px ${icon.className}`}>
              <path d={icon.path} />
            </svg>
            <span className="min-w-0" title={line.detail}>{line.text}</span>
          </li>
        );
      })}
    </ul>
  );
}
