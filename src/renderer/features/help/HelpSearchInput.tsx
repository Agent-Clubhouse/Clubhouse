import { useRef, useEffect } from 'react';

interface HelpSearchInputProps {
  query: string;
  onQueryChange: (query: string) => void;
}

export function HelpSearchInput({ query, onQueryChange }: HelpSearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-0 bg-ctp-mantle">
      <svg
        className="w-4 h-4 text-ctp-subtext0 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
        />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search help..."
        className="flex-1 bg-transparent text-ctp-text text-sm outline-none placeholder:text-ctp-subtext0 min-w-0"
        spellCheck={false}
        autoComplete="off"
      />
      {query && (
        <button
          onClick={() => onQueryChange('')}
          className="text-ctp-subtext0 hover:text-ctp-text text-xs cursor-pointer"
          aria-label="Clear search"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
