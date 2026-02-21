import { OutputKind } from '../../../shared/types';

export interface OutputSegment {
  text: string;
  kind: OutputKind;
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hl]/g;

export class AgentOutputParser {
  private buffer = '';

  feed(rawData: string): OutputSegment[] {
    const clean = rawData.replace(ANSI_REGEX, '');
    this.buffer += clean;

    const segments: OutputSegment[] = [];
    const lines = this.buffer.split('\n');

    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      segments.push({
        text: trimmed,
        kind: classifyLine(trimmed),
      });
    }

    return segments;
  }

  flush(): OutputSegment[] {
    if (!this.buffer.trim()) return [];
    const result = [{ text: this.buffer.trim(), kind: classifyLine(this.buffer.trim()) }];
    this.buffer = '';
    return result;
  }
}

function classifyLine(line: string): OutputKind {
  if (/^(error|Error|ERROR|fatal|FATAL)/i.test(line)) return 'error';
  if (/^[✗✘❌]/.test(line)) return 'error';

  if (/^(Reading|Writing|Editing|Created|Updated|Deleted|Running|Searching)/i.test(line))
    return 'tool_summary';
  if (/^\s{2,}/.test(line) && /[{};()[\]]/.test(line)) return 'tool_summary';

  return 'response';
}
