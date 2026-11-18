/** Board mentions use addresses as identity, even when display names collide. */
export interface MentionMember { address: string; name: string; computer?: string }
export interface MentionResult { addresses: Set<string>; ambiguous: string[] }

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Resolve plain and computer-qualified mentions using the existing @name boundaries. */
export function resolveMentions(body: string, members: ReadonlyArray<MentionMember>): MentionResult {
  const addresses = new Set<string>();
  const ambiguous: string[] = [];
  const names = new Map<string, MentionMember[]>();
  for (const member of members) {
    if (!member.name) continue;
    const key = member.name.toLowerCase();
    names.set(key, [...names.get(key) ?? [], member]);
  }
  for (const matches of names.values()) {
    const name = matches[0].name;
    // A qualified mention must never fall back to a plain mention of this name.
    const plain = new RegExp(`(^|[^\\w@])@${escape(name)}(?![\\w@-])`, 'i');
    if (plain.test(body)) {
      for (const member of matches) addresses.add(member.address);
      if (new Set(matches.map(m => m.address)).size > 1) ambiguous.push(name);
    }
    for (const member of matches) {
      if (member.computer && new RegExp(`(^|[^\\w@])@${escape(name)}@${escape(member.computer)}(?![\\w@-])`, 'i').test(body)) {
        addresses.add(member.address);
      }
    }
  }
  return { addresses, ambiguous };
}
