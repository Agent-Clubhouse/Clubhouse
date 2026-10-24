import { EventEmitter } from 'node:events';
import type { App } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { installClientCertificatePolicy } from './client-certificate-policy';

describe('background client certificate selection', () => {
  it('declines a platform client certificate for a background net request', () => {
    const app = new EventEmitter(), event = { preventDefault: vi.fn() }, callback = vi.fn();
    installClientCertificatePolicy(app as unknown as App);
    app.emit('select-client-certificate', event, null, 'https://example.test', [{}], callback);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith();
  });

  it('does not override the existing browser-window certificate policy', () => {
    const app = new EventEmitter(), event = { preventDefault: vi.fn() }, callback = vi.fn();
    installClientCertificatePolicy(app as unknown as App);
    app.emit('select-client-certificate', event, { id: 1 }, 'https://example.test', [{}], callback);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});
