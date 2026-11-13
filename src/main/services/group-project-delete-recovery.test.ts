import { describe, expect, it } from 'vitest';
import { createDeleteRecovery } from './group-project-delete-recovery';

describe('recoverable group project cascade', () => {
  it.each(['canvas', 'bindings', 'finish'] as const)('resumes after a failure in %s', async (failedStep) => {
    const state = { tombstone: false, done: false, cards: true, bindings: true, shouldFail: true };
    const failOnce = (step: string) => {
      if (state.shouldFail && step === failedStep) { state.shouldFail = false; throw new Error(step); }
    };
    const operations = {
      begin: async () => { state.tombstone = true; },
      cleanup: async () => { failOnce('canvas'); state.cards = false; failOnce('bindings'); state.bindings = false; },
      finish: async () => { failOnce('finish'); state.done = true; },
      pending: async () => state.tombstone && !state.done ? ['gp'] : [],
      exclusive: async <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
    await expect(createDeleteRecovery(operations).delete('gp', 4)).rejects.toThrow(failedStep);
    expect(state.tombstone).toBe(true);
    // A new service simulates the next application process using the durable tombstone.
    await createDeleteRecovery(operations).recover();
    expect(state).toMatchObject({ tombstone: true, done: true, cards: false, bindings: false });
  });

  it('does not run cleanup when writing the tombstone fails', async () => {
    let cleaned = false;
    const service = createDeleteRecovery({
      begin: async () => { throw new Error('disk'); }, cleanup: async () => { cleaned = true; },
      finish: async () => {}, pending: async () => [], exclusive: async (_id, operation) => operation(),
    });
    await expect(service.delete('gp', 1)).rejects.toThrow('disk');
    expect(cleaned).toBe(false);
  });
});
