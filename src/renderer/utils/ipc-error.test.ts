import { describe, it, expect } from 'vitest';
import { ipcErrorMessage } from './ipc-error';

describe('ipcErrorMessage', () => {
  it("drops Electron's remote-method prefix", () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'dispatcher:setEnabled': Error: Turn it on first."))).toBe('Turn it on first.');
  });

  it('keeps other messages and stringifies non-errors', () => {
    expect(ipcErrorMessage(new Error('IPC down'))).toBe('IPC down');
    expect(ipcErrorMessage('nope')).toBe('nope');
  });
});
