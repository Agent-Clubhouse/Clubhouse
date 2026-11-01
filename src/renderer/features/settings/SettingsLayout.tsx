import type { ReactNode } from 'react';

/**
 * Page layout for the settings pages in the chrome style (#2016): an 18px
 * title, 13px sentence-case section headings, and field rows with the label
 * and help on the left and a 28px control on the right.
 * Buttons use the shared `Button`.
 */

/** 28px text input, select or similar single-line control. */
export const settingsInput =
  'h-7 px-2.5 rounded-md border border-surface-1 bg-ctp-crust text-xs text-ctp-text placeholder:text-ctp-overlay0 focus-ring disabled:opacity-50';

/** Multi-line text area. */
export const settingsTextArea =
  'w-full px-2.5 py-2 rounded-md border border-surface-1 bg-ctp-crust text-xs text-ctp-text font-mono leading-relaxed placeholder:text-ctp-overlay0 focus-ring resize-y disabled:opacity-50';

/** The small label above a stacked control (not a field row). */
export const settingsLabel = 'block text-xs text-ctp-overlay1 mb-1';

/** Help and secondary text. */
export const settingsHelp = 'text-xs text-ctp-overlay1';

/** An error line. Give it `role="alert"` so screen readers announce it. */
export const settingsError = 'text-xs text-ctp-error';

export function SettingsPage({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="h-full overflow-y-auto bg-ctp-base" data-testid={testId}>
      <div className="px-10 pt-7 pb-20 max-w-[720px]">
        <div className="flex items-start gap-3 mb-1.5">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-ctp-text">{title}</h2>
            {description && <div className="text-[12.5px] text-ctp-overlay1 mt-[3px]">{description}</div>}
          </div>
          {actions && <div className="flex-shrink-0 flex items-center gap-1.5">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A 13px section heading with optional meta text beside it. */
export function SettingsSection({
  title,
  meta,
  actions,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2.5 mt-[22px] mb-1">
        <h3 className="text-[13px] font-semibold text-ctp-text">{title}</h3>
        {meta != null && meta !== '' && <span className="text-xs text-ctp-overlay1">{meta}</span>}
        {actions && <span className="ml-auto self-center flex items-center gap-1.5">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

/** A settings row: label and help on the left, the control on the right. */
export function SettingsField({
  label,
  help,
  htmlFor,
  children,
  testId,
  disabled,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div
      className={`flex items-center gap-6 min-h-[46px] py-2 border-t border-surface-0 ${disabled ? 'opacity-50' : ''}`}
      data-testid={testId}
    >
      <div className="flex-1 min-w-0">
        <Label {...(htmlFor ? { htmlFor } : {})} className="block text-[13px] text-ctp-text">{label}</Label>
        {help && <div className="text-xs text-ctp-overlay1 mt-px">{help}</div>}
      </div>
      {children != null && <div className="flex-shrink-0 flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** A full-width block under a section heading (lists, editors), with the same top rule as a field row. */
export function SettingsBlock({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`py-2.5 border-t border-surface-0 ${className}`}>{children}</div>;
}
