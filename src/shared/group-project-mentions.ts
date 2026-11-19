/** Board mentions use addresses as identity, even when display names collide. */
export interface MentionMember { address: string; name: string; computer?: string }
export interface MentionResult { addresses: Set<string>; ambiguous: string[] }

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Resolve plain and computer-qualified mentions using the existing @name boundaries. */
export function resolveMentions(body: string, members: ReadonlyArray<MentionMember>): MentionResult {
  const addresses = new Set<string>();
  const ambiguous = new Set<string>();
  const names = new Map<string, MentionMember[]>();
  const qualified = new Map<string, MentionMember[]>();
  for (const member of members) {
    if (!member.name) continue;
    const key = member.name.toLowerCase();
    names.set(key, [...names.get(key) ?? [], member]);
    if (member.computer) {
      const token = `${key}@${member.computer.toLowerCase()}`;
      qualified.set(token, [...qualified.get(token) ?? [], member]);
    }
  }
  const longestFirst = (tokens: Map<string, MentionMember[]>, plain: boolean) => [...tokens]
    .sort(([a], [b]) => b.length - a.length)
    .map(([token, matches]) => ({ token, matches, plain, pattern: new RegExp(`@${escape(token)}(?![\\w@-])`, 'iy') }));
  // Qualified tokens take precedence; within each kind, claim the longest alias.
  const tokens = [...longestFirst(qualified, false), ...longestFirst(names, true)];
  for (let position = body.indexOf('@'); position !== -1; position = body.indexOf('@', position + 1)) {
    if (position > 0 && /[\w@]/.test(body[position - 1])) continue;
    const match = tokens.find(({ pattern }) => {
      pattern.lastIndex = position;
      return pattern.test(body);
    });
    if (!match) continue;
    for (const member of match.matches) addresses.add(member.address);
    if (match.plain && new Set(match.matches.map(m => m.address)).size > 1) ambiguous.add(match.token);
    // Do not scan an @ inside a token that has already claimed this position.
    position = match.pattern.lastIndex - 1;
  }
  return { addresses, ambiguous: [...names].filter(([name]) => ambiguous.has(name)).map(([, matches]) => matches[0].name) };
}
