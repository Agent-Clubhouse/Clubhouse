import { useCallback, useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useHelpSections } from './useHelpSections';
import { useSafeMarkdownLinks } from '../../utils/safe-markdown-links';
import { renderMarkdownSafe } from '../../utils/safe-markdown';

interface HelpContentPaneProps {
  markdown: string | null;
  /** `chrome`: the new shell's article, alone in the pane at a readable width. */
  variant?: 'classic' | 'chrome';
}

/** A link to another Help topic: `#help:<topic-id>`. */
const HELP_LINK = /^#help:([a-z0-9-]+)$/;

export function HelpContentPane({ markdown, variant = 'classic' }: HelpContentPaneProps) {
  const safeClick = useSafeMarkdownLinks();
  const { all } = useHelpSections();
  // Topic links open that topic in Help; every other link keeps the safe handling.
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const topicId = (e.target as HTMLElement).closest('a')?.getAttribute('href')?.match(HELP_LINK)?.[1];
    const section = topicId ? all.find((s) => s.topics.some((t) => t.id === topicId)) : undefined;
    if (!topicId || !section) { safeClick(e); return; }
    e.preventDefault();
    const ui = useUIStore.getState();
    ui.setHelpSection(section.id);
    ui.setHelpTopic(topicId);
  }, [all, safeClick]);
  const html = useMemo(() => {
    if (!markdown) return null;
    return renderMarkdownSafe(markdown);
  }, [markdown]);

  if (variant === 'chrome') {
    return (
      <div data-testid="help-article" className="h-full min-h-0 overflow-y-auto">
        {html ? (
          <article
            className="help-content help-content-chrome max-w-[680px] px-12 pt-8 pb-16"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={handleClick}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-[13px] text-ctp-overlay1">Pick a topic in the sidebar.</div>
        )}
      </div>
    );
  }

  if (!html) {
    return (
      <div className="flex-1 flex items-center justify-center text-ctp-subtext0 text-sm">
        Select a topic from the sidebar
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <div
        className="help-content max-w-3xl"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
      />
    </div>
  );
}
