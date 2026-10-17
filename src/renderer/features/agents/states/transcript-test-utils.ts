import { vi, type Mock } from 'vitest';

type Page = { events: unknown[]; totalEvents: number } | null;
type PageFn = (agentId: string, offset: number, limit: number) => Promise<Page>;

/**
 * Test helper: drive `readTranscriptFrom` (byte cursor) from page-style
 * fixtures, treating the cursor as an event index. Assign `transcript.page`
 * per test (offset → page).
 */
export function installTranscriptShim(): { page: Mock<PageFn> } {
  const transcript = { page: vi.fn<PageFn>(async () => ({ events: [], totalEvents: 0 })) };
  window.clubhouse.agent.readTranscriptFrom = vi.fn(async (agentId: string, cursor: number) => {
    const p = await transcript.page(agentId, cursor, 200);
    if (!p) return null;
    const next = cursor + p.events.length;
    return { events: p.events, cursor: next, skipped: 0, more: p.events.length > 0 && next < p.totalEvents, reset: false };
  });
  return transcript;
}
