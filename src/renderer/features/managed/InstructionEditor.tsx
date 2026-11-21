import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { MarkdownPreview } from '../../plugins/builtin/files/MarkdownPreview';
import { textareaClass } from '../agents/agentSettingsUi';

/** Local rendering only: the draft stays in the caller, and is never presented as delivered instructions. */
export function InstructionEditor({ id, label, value, onChange, disabled, testId }: {
  id?: string;
  label: string;
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const generatedId = useId();
  const previewId = useId();
  const [preview, setPreview] = useState(false);
  return (
    <div className="@container min-w-0 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id ?? generatedId} className="text-xs text-ctp-subtext1">{label}</label>
        <Button kind="quiet" className="ml-auto" aria-expanded={preview} aria-controls={previewId} onClick={() => setPreview(!preview)}>
          {preview ? 'Hide preview' : 'Show preview'}
        </Button>
      </div>
      <div className={`grid grid-cols-1 ${preview ? '@min-[640px]:grid-cols-2' : ''} gap-3 min-w-0 items-start`}>
        <textarea
          id={id ?? generatedId}
          data-testid={testId}
          className={`${textareaClass} min-w-0 min-h-80 w-full`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
        />
        {preview && (
          <section id={previewId} aria-label="Draft preview" className="min-w-0 rounded-md border border-surface-1 overflow-hidden">
            <p className="px-3 py-2 text-xs text-ctp-overlay1 border-b border-surface-0">Draft preview · unsaved text, wildcards as written</p>
            <div className="min-h-80 max-h-[60vh] overflow-auto [overflow-wrap:anywhere]">
              <MarkdownPreview content={value} allowLocalFiles={false} allowLocalImages={false} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
