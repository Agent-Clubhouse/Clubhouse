/** A local memory copy for coordination, never an agreement permission or work request. */
import { createHash } from 'crypto';
import { parseHandoff, type Handoff } from '../../shared/handoffs';
import { memoryWrite } from './dispatcher/dispatcher-memory';
import { dayKey } from './dispatcher/dispatcher-memory-timeline';

export async function recordFederationHandoff(input: Handoff, label: string, root?: string): Promise<void> {
  const record = parseHandoff(input);
  const key = createHash('sha256').update(record.id).digest('hex').slice(0, 32);
  const page = `topics/remote-handoff-${key}.md`;
  const safe = (text: string) => JSON.stringify(text).replace(/[<>]/g, '');
  await memoryWrite(page, (previous) => {
    const version = previous && /Source: local Handoff agreement [^\n]+, version (\d+)/.exec(previous);
    if (version && Number(version[1]) >= record.version) return previous!;
    return `Status: confirmed\nSource: local Handoff agreement ${record.id}, version ${record.version}\n\n# Remote Handoff ${record.id}\nState: ${record.state}\n`
    + `Local sending agent: ${safe(record.from.agentId)}\nTarget: ${safe(label)}\nTask title (untrusted): ${safe(record.task.title)}\n`
    + `Mode: ${record.mode}\n\nThis is an agreement record, separate from a request handled by the Dispatcher. It never grants approval or makes this Dispatcher a Handoff participant. The sending agent uses get_handoff for the authoritative agreement and responds through its normal permissions.\n`;
  }, 'remote handoff record', root, { preserveFreshness: true });
  const token = `[Handoff ${record.id} version ${record.version}](${`../${page}`})`;
  await memoryWrite(`timeline/${dayKey(new Date(record.updatedAt))}.md`, (previous) => {
    if (previous?.includes(token)) return previous;
    return `${previous ?? `# ${dayKey(new Date(record.updatedAt))}\n\n`}- ${token}: ${record.state}, from ${safe(record.from.agentId)} to ${safe(label)}.\n`;
  }, 'remote handoff timeline', root);
}
