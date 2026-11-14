import { AsyncLocalStorage } from 'node:async_hooks';

/** Main-only guard retained through helper disposal and the final delete boundary. */
const review = new AsyncLocalStorage<{ guard: (projectPath: string, agentId: string) => Promise<void>; onEffect?: () => void }>();

export function withDeleteReview<T>(guard: (projectPath: string, agentId: string) => Promise<void>, run: () => T, onEffect?: () => void): T {
  return review.run({ guard, onEffect }, run);
}

export async function assertDeleteReview(projectPath: string, agentId: string): Promise<void> {
  await review.getStore()?.guard(projectPath, agentId);
}

export function hasDeleteReview(): boolean { return review.getStore() !== undefined; }

/** Called immediately before a stop, file removal or membership write can change anything. */
export function noteDeleteReviewEffect(): void { review.getStore()?.onEffect?.(); }
