/** Process-local provenance. No board field, snapshot or remote argument can set it. */
const posts = new Map<string, number>();
const TTL_MS = 10 * 60_000;
export function noteLocalGroupPost(group: string, id: string): void {
  const now = Date.now();
  for (const [key, at] of posts) if (now - at > TTL_MS) posts.delete(key);
  posts.set(JSON.stringify([group, id]), now);
}
export function isLocalGroupPost(group: string, id: string): boolean {
  const at = posts.get(JSON.stringify([group, id]));
  return at !== undefined && Date.now() - at <= TTL_MS;
}
export function resetLocalGroupPostsForTesting(): void { posts.clear(); requests.clear(); }

const requests = new Map<string, { at: number; expectedPost: string }>();
export function noteLocalGroupRequest(id: string, expectedPost: string): void {
  const now = Date.now();
  for (const [key, entry] of requests) if (now - entry.at > 24 * 60 * 60_000) requests.delete(key);
  requests.set(id, { at: now, expectedPost });
}
export function noteLocalGroupRequestResult(request: string, group: string, id: string): void {
  if (requests.get(request)?.expectedPost !== id) return;
  noteLocalGroupPost(group, id);
  requests.delete(request);
}
