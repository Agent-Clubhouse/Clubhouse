import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { FileSearchResult, FileSearchFileResult } from '../../../../shared/types';
import { fileState } from './state';
import { getFileIconColor } from './file-icons';

// ── Icons ──────────────────────────────────────────────────────────────

const SearchIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('circle', { cx: 11, cy: 11, r: 8 }),
   React.createElement('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }));

const ClearIcon = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('line', { x1: 18, y1: 6, x2: 6, y2: 18 }),
   React.createElement('line', { x1: 6, y1: 6, x2: 18, y2: 18 }));

const ChevronRight = React.createElement('svg', {
  width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'flex-shrink-0',
}, React.createElement('polyline', { points: '9 18 15 12 9 6' }));

const ChevronDown = React.createElement('svg', {
  width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'flex-shrink-0',
}, React.createElement('polyline', { points: '6 9 12 15 18 9' }));

const FileIcon = (color: string) => React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: `${color} flex-shrink-0`,
}, React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
   React.createElement('polyline', { points: '14 2 14 8 20 8' }));

const BackIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('line', { x1: 19, y1: 12, x2: 5, y2: 12 }),
   React.createElement('polyline', { points: '12 19 5 12 12 5' }));

const SpinnerIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'animate-spin',
}, React.createElement('path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }));

// ── Toggle button ─────────────────────────────────────────────────────

function ToggleButton({ label, active, onClick, title }: {
  label: string;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return React.createElement('button', {
    className: `px-1 py-0 text-[10px] font-mono rounded border transition-colors ${
      active
        ? 'bg-ctp-surface1 border-ctp-blue text-ctp-blue'
        : 'bg-transparent border-ctp-surface0 text-ctp-subtext0 hover:text-ctp-text hover:border-ctp-surface1'
    }`,
    onClick,
    title,
  }, label);
}

// ── Highlighted match line ────────────────────────────────────────────

function HighlightedLine({ lineContent, column, length }: {
  lineContent: string;
  column: number;
  length: number;
}) {
  const start = column - 1;
  const end = start + length;
  const before = lineContent.slice(0, start);
  const match = lineContent.slice(start, end);
  const after = lineContent.slice(end);

  return React.createElement('span', { className: 'whitespace-pre' },
    React.createElement('span', { className: 'text-ctp-subtext0' }, before),
    React.createElement('span', { className: 'bg-ctp-yellow/30 text-ctp-yellow font-medium' }, match),
    React.createElement('span', { className: 'text-ctp-subtext0' }, after),
  );
}

// ── File result group ─────────────────────────────────────────────────

function FileResultGroup({ result, onMatchClick }: {
  result: FileSearchFileResult;
  onMatchClick: (filePath: string, line: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const fileName = result.filePath.split('/').pop() || result.filePath;
  const ext = fileName.lastIndexOf('.') > 0
    ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    : '';

  return React.createElement('div', { className: 'mb-0.5' },
    // File header
    React.createElement('div', {
      className: 'flex items-center gap-1 px-2 py-0.5 cursor-pointer rounded-sm hover:bg-ctp-surface0 transition-colors',
      onClick: () => setCollapsed(!collapsed),
    },
      collapsed ? ChevronRight : ChevronDown,
      FileIcon(getFileIconColor(ext)),
      React.createElement('span', {
        className: 'text-[11px] text-ctp-text truncate flex-1',
        title: result.filePath,
      }, result.filePath),
      React.createElement('span', {
        className: 'text-[10px] text-ctp-subtext0 flex-shrink-0 ml-1',
      }, String(result.matches.length)),
    ),

    // Matches
    !collapsed && React.createElement('div', { className: 'ml-4' },
      ...result.matches.slice(0, 100).map((match, i) =>
        React.createElement('div', {
          key: `${match.line}-${match.column}-${i}`,
          className: 'flex items-start gap-1 px-2 py-px cursor-pointer rounded-sm hover:bg-ctp-surface0 transition-colors text-[11px]',
          onClick: () => onMatchClick(result.filePath, match.line),
        },
          React.createElement('span', {
            className: 'text-ctp-subtext0 flex-shrink-0 w-8 text-right font-mono text-[10px]',
          }, String(match.line)),
          React.createElement('span', {
            className: 'truncate font-mono text-[10px] leading-4',
          },
            React.createElement(HighlightedLine, {
              lineContent: match.lineContent,
              column: match.column,
              length: match.length,
            }),
          ),
        ),
      ),
      result.matches.length > 100
        ? React.createElement('div', {
            className: 'px-2 py-0.5 text-[10px] text-ctp-subtext0 italic',
          }, `... and ${result.matches.length - 100} more matches`)
        : null,
    ),
  );
}

// ── Main SearchPanel component ────────────────────────────────────────

export function SearchPanel({ api }: { api: PluginAPI }) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [includePattern, setIncludePattern] = useState('');
  const [excludePattern, setExcludePattern] = useState('');
  const [results, setResults] = useState<FileSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchVersionRef = useRef(0);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery || searchQuery.length < 2) {
      setResults(null);
      return;
    }

    const version = ++searchVersionRef.current;
    setSearching(true);

    try {
      const includeGlobs = includePattern
        ? includePattern.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const excludeGlobs = excludePattern
        ? excludePattern.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;

      const result = await api.files.search(searchQuery, {
        caseSensitive,
        wholeWord,
        regex: useRegex,
        includeGlobs,
        excludeGlobs,
        maxResults: 10000,
      });

      if (searchVersionRef.current !== version) return;
      setResults(result);
    } catch {
      if (searchVersionRef.current !== version) return;
      setResults({ results: [], totalMatches: 0, truncated: false });
    } finally {
      if (searchVersionRef.current === version) {
        setSearching(false);
      }
    }
  }, [api, caseSensitive, wholeWord, useRegex, includePattern, excludePattern]);

  // Debounced search on query change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  const handleMatchClick = useCallback((filePath: string, line: number) => {
    fileState.navigateToMatch(filePath, line);
  }, []);

  const handleClear = useCallback(() => {
    setQuery('');
    setResults(null);
    inputRef.current?.focus();
  }, []);

  const handleBack = useCallback(() => {
    fileState.setSearchMode(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (query) {
        handleClear();
      } else {
        handleBack();
      }
    } else if (e.key === 'Enter') {
      doSearch(query);
    }
  }, [query, handleClear, handleBack, doSearch]);

  const fileCount = results?.results.length ?? 0;
  const totalMatches = results?.totalMatches ?? 0;

  return React.createElement('div', {
    className: 'flex flex-col h-full bg-ctp-mantle text-ctp-text',
  },
    // Header
    React.createElement('div', {
      className: 'flex flex-col border-b border-ctp-surface0 flex-shrink-0',
    },
      // Title row
      React.createElement('div', {
        className: 'flex items-center gap-2 px-2 py-1',
      },
        React.createElement('button', {
          className: 'p-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: handleBack,
          title: 'Back to file tree',
        }, BackIcon),
        React.createElement('span', { className: 'text-xs font-medium flex-1' }, 'Search'),
      ),

      // Search input row
      React.createElement('div', {
        className: 'flex items-center gap-1 px-2 pb-1',
      },
        React.createElement('div', {
          className: 'flex-1 flex items-center bg-ctp-base border border-ctp-surface0 rounded px-1.5 py-0.5 focus-within:border-ctp-blue transition-colors',
        },
          React.createElement('span', { className: 'text-ctp-subtext0 mr-1 flex-shrink-0' }, SearchIcon),
          React.createElement('input', {
            ref: inputRef,
            type: 'text',
            className: 'flex-1 bg-transparent text-xs text-ctp-text outline-none placeholder:text-ctp-subtext0 min-w-0',
            placeholder: 'Search files...',
            value: query,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
            onKeyDown: handleKeyDown,
          }),
          query && React.createElement('button', {
            className: 'text-ctp-subtext0 hover:text-ctp-text flex-shrink-0 ml-0.5',
            onClick: handleClear,
            title: 'Clear',
          }, ClearIcon),
        ),
      ),

      // Toggle buttons row
      React.createElement('div', {
        className: 'flex items-center gap-1 px-2 pb-1',
      },
        React.createElement(ToggleButton, {
          label: 'Aa',
          active: caseSensitive,
          onClick: () => setCaseSensitive(!caseSensitive),
          title: 'Match Case',
        }),
        React.createElement(ToggleButton, {
          label: 'Ab|',
          active: wholeWord,
          onClick: () => setWholeWord(!wholeWord),
          title: 'Match Whole Word',
        }),
        React.createElement(ToggleButton, {
          label: '.*',
          active: useRegex,
          onClick: () => setUseRegex(!useRegex),
          title: 'Use Regular Expression',
        }),
        React.createElement('div', { className: 'flex-1' }),
        React.createElement('button', {
          className: `text-[10px] px-1 rounded transition-colors ${
            showFilters
              ? 'text-ctp-blue'
              : 'text-ctp-subtext0 hover:text-ctp-text'
          }`,
          onClick: () => setShowFilters(!showFilters),
          title: 'Toggle include/exclude filters',
        }, 'Filters'),
      ),

      // Include/Exclude filters (collapsible)
      showFilters && React.createElement('div', {
        className: 'px-2 pb-1 space-y-1',
      },
        React.createElement('input', {
          type: 'text',
          className: 'w-full bg-ctp-base border border-ctp-surface0 rounded px-1.5 py-0.5 text-[10px] text-ctp-text outline-none placeholder:text-ctp-subtext0 focus:border-ctp-blue transition-colors',
          placeholder: 'Include (e.g. src/**/*.ts)',
          value: includePattern,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setIncludePattern(e.target.value),
        }),
        React.createElement('input', {
          type: 'text',
          className: 'w-full bg-ctp-base border border-ctp-surface0 rounded px-1.5 py-0.5 text-[10px] text-ctp-text outline-none placeholder:text-ctp-subtext0 focus:border-ctp-blue transition-colors',
          placeholder: 'Exclude (e.g. dist,*.min.js)',
          value: excludePattern,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setExcludePattern(e.target.value),
        }),
      ),
    ),

    // Status line
    (results || searching) && React.createElement('div', {
      className: 'flex items-center gap-1 px-2 py-0.5 text-[10px] text-ctp-subtext0 border-b border-ctp-surface0 flex-shrink-0',
    },
      searching
        ? React.createElement(React.Fragment, null, SpinnerIcon, ' Searching...')
        : results
          ? `${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}${results.truncated ? ' (truncated)' : ''}`
          : null,
    ),

    // Results
    React.createElement('div', { className: 'flex-1 overflow-auto py-0.5' },
      !results && !searching
        ? React.createElement('div', {
            className: 'px-3 py-8 text-xs text-ctp-subtext0 text-center',
          }, 'Type at least 2 characters to search')
        : results && results.results.length === 0 && !searching
          ? React.createElement('div', {
              className: 'px-3 py-8 text-xs text-ctp-subtext0 text-center',
            }, 'No results found')
          : results
            ? results.results.map((fileResult) =>
                React.createElement(FileResultGroup, {
                  key: fileResult.filePath,
                  result: fileResult,
                  onMatchClick: handleMatchClick,
                }),
              )
            : null,
    ),
  );
}
