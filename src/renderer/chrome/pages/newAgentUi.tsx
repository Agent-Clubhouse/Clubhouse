/** Layout pieces shared by the New agent page and its managed steps (#2031, #2893). */

export const IS_MAC = typeof window !== 'undefined' && window.clubhouse?.platform === 'darwin';

export const inputClass = 'h-7 px-2 rounded-md border border-surface-1 bg-ctp-crust text-[13px] text-ctp-text placeholder:text-ctp-overlay0 focus-ring';
export const selectClass = `${inputClass} pr-6 cursor-pointer`;
export const mono = 'font-mono text-xs';
/** The quiet text link in a footer's left corner ("Copy another agent…", "Back"). */
export const footerLinkClass = 'text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer focus-ring rounded disabled:opacity-50 disabled:cursor-not-allowed';

export function Row({ label, htmlFor, help, top, children }: { label: string; htmlFor?: string; help?: React.ReactNode; top?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex gap-4 py-1.5 ${top ? 'items-start' : 'items-center'}`}>
      <label htmlFor={htmlFor} className={`flex-shrink-0 w-28 text-[13px] text-ctp-subtext1 ${top ? 'pt-1.5' : ''}`}>{label}</label>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">{children}</div>
        {help && <div className="text-xs leading-normal text-ctp-overlay1">{help}</div>}
      </div>
    </div>
  );
}

export const Rule = () => <div className="h-px bg-surface-0 my-2" />;

/** A segmented control like Kind's Durable | Quick, as a radio group. */
export function Segmented<T extends string>({ label, value, options, onChange, testIdPrefix }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (next: T) => void;
  testIdPrefix?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 gap-0.5 rounded-[7px] bg-ctp-crust">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.id}` : undefined}
          onClick={() => onChange(o.id)}
          className={`h-6 px-3 rounded-[5px] text-xs cursor-pointer focus-ring ${value === o.id ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
