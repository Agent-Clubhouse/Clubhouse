import type { ReactNode } from 'react';

/**
 * Chrome-sized pieces for the agent settings pages (#2015): 13px sentence-case
 * headings, field rows, 28px controls. The button classes stand in for the
 * shared Button (#2013/#2014) until it lands; swap them for it then.
 */

export type ButtonKind = 'primary' | 'ghost' | 'quiet' | 'danger';

const BUTTON_KIND: Record<ButtonKind, string> = {
  primary: 'bg-ctp-accent border-ctp-accent text-ctp-crust hover:bg-ctp-accent/85',
  ghost: 'border-surface-1 text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text',
  quiet: 'border-transparent text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text',
  danger: 'border-surface-1 text-ctp-error hover:bg-surface-0',
};

export const buttonClass = (kind: ButtonKind = 'ghost') =>
  `h-7 px-2.5 rounded-md border inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap flex-shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_KIND[kind]}`;

export const selectClass =
  'h-7 w-[200px] rounded-md border border-surface-1 bg-ctp-base px-2 text-xs text-ctp-text focus:outline-none focus:border-ctp-accent disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';

export const inputClass =
  'h-7 rounded-md border border-surface-1 bg-ctp-crust px-2.5 text-xs text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-accent disabled:opacity-50 disabled:cursor-not-allowed';

export const textareaClass =
  'w-full rounded-md border border-surface-1 bg-ctp-crust px-2.5 py-2 font-mono text-xs leading-[1.65] text-ctp-text placeholder:text-ctp-overlay0 resize-y focus:outline-none focus:border-ctp-accent disabled:text-ctp-overlay0 disabled:cursor-not-allowed';

/** 13px semibold heading with an optional secondary note beside it. */
export function SectionHeading({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5 mt-[22px] mb-1">
      <h3 className="text-[13px] font-semibold text-ctp-text">{title}</h3>
      {sub && <span className="text-xs text-ctp-overlay1 min-w-0 truncate">{sub}</span>}
    </div>
  );
}

/** The selected page's title in the new chrome. */
export function PageTitle({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 mb-1.5">
      <div className="flex-1 min-w-0">
        <h2 className="text-lg font-semibold text-ctp-text">{title}</h2>
        {sub && <div className="text-xs text-ctp-overlay1 mt-0.5">{sub}</div>}
      </div>
      {right && <div className="flex-shrink-0 flex items-center gap-1.5">{right}</div>}
    </div>
  );
}

/** A setting: label and help on the left, its control on the right. */
export function Field({ label, help, children, htmlFor, testId }: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex items-center gap-6 min-h-[46px] py-2 border-t border-surface-0">
      <div className="flex-1 min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] text-ctp-text">{label}</label>
        ) : (
          <div className="text-[13px] text-ctp-text">{label}</div>
        )}
        {help && <div className="text-xs text-ctp-overlay1 mt-px">{help}</div>}
      </div>
      <div className="flex-shrink-0 flex items-center gap-2">{children}</div>
    </div>
  );
}

/** Label above a text area. */
export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-xs text-ctp-overlay1 mb-1">{children}</label>;
}
