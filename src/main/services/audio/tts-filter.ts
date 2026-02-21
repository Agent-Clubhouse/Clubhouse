import { OutputKind, TTSFilter } from '../../../shared/types';

export function shouldSpeak(text: string, kind: OutputKind, filter: TTSFilter): boolean {
  if (!text.trim()) return false;
  switch (kind) {
    case 'response': return filter.speakResponses;
    case 'tool_summary': return filter.speakToolSummaries;
    case 'error': return filter.speakErrors;
    case 'status_change': return filter.speakStatus;
    default: return false;
  }
}
