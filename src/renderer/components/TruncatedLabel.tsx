import { Tooltip } from './Tooltip';

/** A one-line label that shows its full text in a tooltip only when it's cut off. */
export function TruncatedLabel({ text, className = '' }: { text: string; className?: string }) {
  return (
    <Tooltip content={text} onlyWhenTruncated>
      <span className={`truncate ${className}`}>{text}</span>
    </Tooltip>
  );
}
