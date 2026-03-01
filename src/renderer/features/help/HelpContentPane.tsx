import { useMemo } from 'react';
import { marked } from 'marked';
import { useSafeMarkdownLinks } from '../../utils/safe-markdown-links';

interface HelpContentPaneProps {
  markdown: string | null;
}

export function HelpContentPane({ markdown }: HelpContentPaneProps) {
  const handleClick = useSafeMarkdownLinks();
  const html = useMemo(() => {
    if (!markdown) return null;
    return marked.parse(markdown, { async: false }) as string;
  }, [markdown]);

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
