import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { assertReviewReceipt, parseReviewEntry, readReviewEntry } from '../e2e/review-entry';

const entry = { executablePath: path.resolve('electron'), bootstrapPath: path.resolve('bootstrap.cjs'), receiptPath: path.resolve('receipt.jsonl') };
describe('explicit review entry without launching', () => {
  it('leaves ordinary launches unchanged and retains only the three explicit paths', () => {
    expect(readReviewEntry(undefined)).toBeUndefined();
    expect(parseReviewEntry(entry)).toEqual(entry);
  });
  it('refuses partial, relative, extra and NUL-containing entry fields', () => {
    for (const value of [null, [], {}, { ...entry, receiptPath: 'relative' }, { ...entry, env: {} }, { ...entry, bootstrapPath: `${entry.bootstrapPath}\0` }]) {
      expect(() => parseReviewEntry(value)).toThrow();
    }
  });
  it('requires ordered pre-main receipts belonging to the actual owned process', () => {
    const row = (kind: string, pid = 12) => JSON.stringify({ kind, pid });
    expect(() => assertReviewReceipt(`${row('install-start')}\n${row('guard-installed-before-main')}\n`, 12)).not.toThrow();
    for (const raw of ['', row('guard-installed-before-main'), `${row('guard-installed-before-main')}\n${row('install-start')}`, `${row('install-start', 13)}\n${row('guard-installed-before-main', 13)}`, '{']) {
      expect(() => assertReviewReceipt(raw, 12)).toThrow();
    }
    expect(() => assertReviewReceipt('', undefined)).toThrow();
  });
});
