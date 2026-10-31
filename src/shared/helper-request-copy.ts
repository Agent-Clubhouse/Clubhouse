/**
 * The Needs you lines for helper requests (#2229, #2234), shared so a paired
 * phone (#159) shows the desktop's words.
 */
import type { HelperDisposeRequest } from './types';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The Needs you line for a pending dispose: who asked, and what the checks found. */
export function describeHelperDisposeRequest(orchestratorName: string, request: Pick<HelperDisposeRequest, 'checks' | 'forceRequested'>): string {
  const { checks, forceRequested } = request;
  const facts: string[] = [];
  if (checks.dirty > 0) facts.push(plural(checks.dirty, 'uncommitted file', 'uncommitted files'));
  if (checks.unpushed > 0) facts.push(plural(checks.unpushed, 'unpushed commit', 'unpushed commits'));
  if (checks.unmerged) facts.push(plural(checks.unmerged, 'unmerged commit', 'unmerged commits'));
  if (checks.error) facts.push(checks.error);
  const what = facts.length > 0 ? facts.join(', ') : 'nothing would be lost';
  return `${orchestratorName} asked to dispose this helper${forceRequested ? ' (forced)' : ''}. ${what[0].toUpperCase()}${what.slice(1)}.`;
}

/** The Needs you line for one waiting start; `projectName` when it is in another project (#2515). */
export function describeHelperStart(helperName: string, projectName?: string): string {
  return `Wants to start the helper ${helperName}${projectName ? ` in ${projectName}` : ''}`;
}
