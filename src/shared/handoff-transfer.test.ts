import { expect, it } from 'vitest';
import { parseHandoffTransferRequest } from './handoff-transfer';
const id = '17551191-93a4-4c8b-82d2-22629701d891';
it('accepts bounded indexed reads and manifest requests without accepting filesystem paths', () => {
  expect(parseHandoffTransferRequest({ op: 'manifest', id })).toEqual({ op: 'manifest', id });
  expect(parseHandoffTransferRequest({ op: 'read', id, file: -1, offset: 256 * 1024 })).toEqual({ op: 'read', id, file: -1, offset: 256 * 1024 });
});
it.each([
  null, [], { op: 'manifest', id, path: '../outside' }, { op: 'manifest', id: '../outside' },
  { op: 'read', id, file: 0, offset: -1 }, { op: 'read', id, file: -2, offset: 0 },
  { op: 'read', id, file: 10000, offset: 0 }, { op: 'read', id, file: 0, offset: Infinity },
  { op: 'read', id, file: 0, offset: 1.5 }, { op: 'read', id, file: 0, offset: 0, path: 'file.txt' },
  { op: 'write', id, file: 0, offset: 0 },
])('refuses malformed transfer request %j', (value) => expect(() => parseHandoffTransferRequest(value)).toThrow());
