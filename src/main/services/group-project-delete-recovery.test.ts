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

describe('durable cascade recovery', () => {
  it.each(['cards', 'bindings', 'record'] as const)('resumes persisted work after %s fails', async (failedStep) => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-delete-recovery-'));
    const file = (name: string) => path.join(dir, name);
    try {
      await Promise.all(['cards', 'bindings', 'record'].map((name) => fs.writeFile(file(name), 'present')));
      let failure: string | null = failedStep;
      const failOnce = (step: string) => {
        if (failure === step) { failure = null; throw new Error(step); }
      };
      const operations = () => ({
        begin: async () => { await fs.writeFile(file('tombstone'), 'deleting'); },
        cleanup: async () => {
          failOnce('cards'); await fs.rm(file('cards'), { force: true });
          failOnce('bindings'); await fs.rm(file('bindings'), { force: true });
        },
        finish: async () => { failOnce('record'); await fs.rm(file('record'), { force: true }); await fs.writeFile(file('tombstone'), 'done'); },
        pending: async () => (await fs.readFile(file('tombstone'), 'utf8')) === 'deleting' ? ['gp'] : [],
        exclusive: async <T>(_id: string, operation: () => Promise<T>) => operation(),
      });
      await expect(createDeleteRecovery(operations()).delete('gp', 1)).rejects.toThrow(failedStep);
      expect(await fs.readFile(file('tombstone'), 'utf8')).toBe('deleting');
      await createDeleteRecovery(operations()).recover();
      expect(await fs.readFile(file('tombstone'), 'utf8')).toBe('done');
      for (const name of ['cards', 'bindings', 'record']) await expect(fs.stat(file(name))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
