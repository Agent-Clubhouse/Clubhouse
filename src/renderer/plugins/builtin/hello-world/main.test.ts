import { describe, it, expect, vi } from 'vitest';
import { manifest } from './manifest';
import { activate, deactivate } from './main';
import { createMockContext, createMockAPI } from '../../testing';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';

describe('hello-world built-in plugin', () => {
  it('manifest validates via validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: { activate, deactivate } });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('activate registers the greet command', () => {
    const ctx = createMockContext({ scope: 'app', settings: { greeting: 'Hi!' } });
    const api = createMockAPI();
    const registerSpy = vi.spyOn(api.commands, 'register');

    activate(ctx, api);

    expect(registerSpy).toHaveBeenCalledWith('greet', expect.any(Function));
  });

  it('activate pushes a disposable to ctx.subscriptions', () => {
    const ctx = createMockContext({ scope: 'app', settings: { greeting: 'Hi!' } });
    const api = createMockAPI();

    activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(1);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
  });

  it('greet command calls api.ui.showNotice with the greeting from settings', () => {
    const greeting = 'Custom greeting!';
    const ctx = createMockContext({ scope: 'app', settings: { greeting } });
    const api = createMockAPI();
    const noticeSpy = vi.spyOn(api.ui, 'showNotice');

    // Capture the handler
    let handler: ((...args: unknown[]) => void) | undefined;
    vi.spyOn(api.commands, 'register').mockImplementation((_id, h) => {
      handler = h;
      return { dispose: () => {} };
    });

    activate(ctx, api);
    expect(handler).toBeDefined();
    handler!();

    expect(noticeSpy).toHaveBeenCalledWith(greeting);
  });

  it('uses default greeting when settings.greeting is not set', () => {
    const ctx = createMockContext({ scope: 'app', settings: {} });
    const api = createMockAPI();
    const noticeSpy = vi.spyOn(api.ui, 'showNotice');

    let handler: ((...args: unknown[]) => void) | undefined;
    vi.spyOn(api.commands, 'register').mockImplementation((_id, h) => {
      handler = h;
      return { dispose: () => {} };
    });

    activate(ctx, api);
    handler!();

    expect(noticeSpy).toHaveBeenCalledWith('Hello from a built-in plugin!');
  });

  it('deactivate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
