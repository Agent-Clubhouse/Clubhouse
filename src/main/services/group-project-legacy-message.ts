import type { BulletinMessage, GroupProject } from '../../shared/group-project-types';
import type { WriteAuthor } from '../../shared/group-project-network';
import type { groupProjectHost } from './group-project-host';

type LegacyMessageHost = Pick<typeof groupProjectHost, 'resolveMembers' | 'addressOf' | 'ensureInbox' | 'post'>;

/** Deprecated phone/plugin tap requests now create durable board posts. */
export async function postLegacyGroupMessage(
  host: LegacyMessageHost, project: GroupProject, sender: string, targetAgentId: string | null, message: string, author: WriteAuthor,
): Promise<BulletinMessage | null> {
  let topic = 'general';
  if (targetAgentId) {
    const member = (await host.resolveMembers(project.id)).find((m) => m.address === host.addressOf(project, targetAgentId));
    if (!member) return null;
    topic = await host.ensureInbox(project.id, member.name, member.address);
  }
  return host.post(project.id, sender, topic, message, { author });
}
