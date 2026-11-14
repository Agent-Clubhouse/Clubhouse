import { AsyncLocalStorage } from 'node:async_hooks';

/** Main-only guard retained through helper disposal and the final delete boundary. */
const review = new AsyncLocalStorage<(projectPath: string, agentId: string) => Promise<void>>();

export function withDeleteReview<T>(guard: (projectPath: string, agentId: string) => Promise<void>, run: () => T): T {
  return review.run(guard, run);
}

export async function assertDeleteReview(projectPath: string, agentId: string): Promise<void> {
  await review.getStore()?.(projectPath, agentId);
}

export function hasDeleteReview(): boolean { return review.getStore() !== undefined; }
