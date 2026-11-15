import { vi } from 'vitest';

/** Extend small settings-consumer fs mocks to support temp-file writes. */
export function atomicFsPromises(writeFile: (file: string, body: string, encoding: string) => Promise<unknown>) {
  return {
    open: vi.fn(async (file: string) => ({
      writeFile: (body: string, encoding: string) => writeFile(file, body, encoding),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    stat: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
    chmod: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  };
}
