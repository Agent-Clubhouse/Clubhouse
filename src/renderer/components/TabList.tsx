import { useRef, type KeyboardEvent } from 'react';

/**
 * A tab strip with the WAI-ARIA tabs pattern: `tablist` of `tab`s, one tab
 * in the Tab order (roving tabindex), Left and Right move and wrap, Home and
 * End go to the ends, and moving selects. Each tab controls the one panel,
 * drawn by the caller with {@link tabPanelProps}.
 */
export function TabList<T extends string>({ label, idPrefix, value, options, onChange, className, tabClassName, testIdPrefix }: {
  label: string;
  /** Unique on the page; from useId. */
  idPrefix: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (next: T) => void;
  className?: string;
  tabClassName: (selected: boolean) => string;
  testIdPrefix?: string;
}) {
  const tabs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = options.findIndex((o) => o.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % options.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = options[next].id;
    onChange(id);
    tabs.current.get(id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => { if (el) tabs.current.set(o.id, el); else tabs.current.delete(o.id); }}
            type="button"
            role="tab"
            id={tabId(idPrefix, o.id)}
            aria-selected={selected}
            aria-controls={panelId(idPrefix)}
            tabIndex={selected ? 0 : -1}
            data-testid={testIdPrefix ? `${testIdPrefix}-${o.id}` : undefined}
            onClick={() => onChange(o.id)}
            className={tabClassName(selected)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function tabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

function panelId(idPrefix: string): string {
  return `${idPrefix}-panel`;
}

/** Props for the panel the selected tab shows. Panels here always hold controls, so the panel itself isn't a Tab stop. */
export function tabPanelProps(idPrefix: string, selected: string): { role: 'tabpanel'; id: string; 'aria-labelledby': string } {
  return { role: 'tabpanel', id: panelId(idPrefix), 'aria-labelledby': tabId(idPrefix, selected) };
}
