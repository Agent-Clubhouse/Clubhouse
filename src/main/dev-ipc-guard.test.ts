import { describe, it, expect } from 'vitest';

/**
 * These tests validate the dev-only IPC guard pattern used in the preload.
 * The actual preload code gates devSimulateUpdateRestart behind NODE_ENV === 'development'.
 * We test the guard logic in isolation since the preload module requires Electron runtime.
 */

function isDevOnlyAllowed(): boolean {
  return process.env.NODE_ENV === 'development';
}

describe('dev-only IPC guard', () => {
  it('allows dev-only APIs in development mode', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      expect(isDevOnlyAllowed()).toBe(true);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('blocks dev-only APIs in production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(isDevOnlyAllowed()).toBe(false);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('blocks dev-only APIs when NODE_ENV is undefined', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      expect(isDevOnlyAllowed()).toBe(false);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
