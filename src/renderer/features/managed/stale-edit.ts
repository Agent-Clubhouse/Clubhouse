/**
 * A part edit that lost a race (#2897): what each version says, as text, and
 * the lines that differ. Used by the stale edit dialog to show their version
 * against yours before anything is saved.
 */
import type { ManagedPartContent } from '../../../shared/managed-agents-types';

export interface PartVersion {
  name: string;
  description: string;
  content: ManagedPartContent;
}

/** A part as plain lines: its name and description, then its text, files or command. Never env values. */
export function partAsText(v: PartVersion): string {
  const head = [`Name: ${v.name}`, ...(v.description ? [`Description: ${v.description}`] : [])];
  const c = v.content;
  if (c.kind === 'block') return [...head, '', c.content].join('\n');
  if (c.kind === 'skill') {
    const lines = [...head, `Folder: ${c.skillName}`];
    for (const f of [...c.files].sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))) {
      const notes = [f.encoding === 'base64' ? 'binary' : null, f.executable ? 'executable' : null].filter(Boolean).join(', ');
      lines.push('', `File: ${f.path}${notes ? ` (${notes})` : ''}`);
      if (f.encoding !== 'base64') lines.push(f.content);
    }
    return lines.join('\n');
  }
  return [
    ...head,
    `Server key: ${c.serverKey}`,
    `Transport: ${c.transport}`,
    ...(c.transport === 'stdio' ? [`Command: ${c.command ?? ''}`, ...(c.args ?? []).map((a) => `Argument: ${a}`)] : [`URL: ${c.url ?? ''}`]),
    ...(c.envVars ?? []).map((n) => `Environment: ${n}`),
  ].join('\n');
}

export { lineDiff, type DiffLine } from '../../../shared/line-diff';
