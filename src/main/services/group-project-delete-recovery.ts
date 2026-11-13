/**
 * Run an idempotent cascade with the host tombstone as the durable journal.
 * The host hides a project as soon as begin resolves. Failed work remains
 * pending so startup can repeat cleanup before completing the tombstone.
 */
export interface DeleteRecoveryOperations {
  begin: (id: string, expectedSequence: number) => Promise<void>;
  cleanup: (id: string) => Promise<void>;
  finish: (id: string) => Promise<void>;
  pending: () => Promise<string[]>;
  exclusive: <T>(id: string, operation: () => Promise<T>) => Promise<T>;
}

export function createDeleteRecovery(operations: DeleteRecoveryOperations) {
  const complete = async (id: string) => {
    await operations.cleanup(id);
    await operations.finish(id);
  };
  return {
    delete: (id: string, sequence: number) => operations.exclusive(id, async () => {
      await operations.begin(id, sequence);
      await complete(id);
    }),
    recover: async () => {
      const errors: unknown[] = [];
      for (const id of await operations.pending()) {
        try { await operations.exclusive(id, () => complete(id)); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new Error(`${errors.length} group project deletion(s) could not be completed.`);
    },
  };
}
