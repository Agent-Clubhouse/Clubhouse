import { describe, it, expect, afterEach } from 'vitest';
import { fireEvent, screen, act } from '@testing-library/react';
import { showInputDialog, showConfirmDialog } from './PluginDialog';

// Cleanup any leftover dialog containers after each test
afterEach(() => {
  document.querySelectorAll('[data-plugin-dialog]').forEach((el) => el.remove());
});

describe('showInputDialog', () => {
  it('renders a dialog with the prompt as header', async () => {
    act(() => {
      showInputDialog('File name');
    });

    expect(screen.getByTestId('plugin-dialog')).toBeTruthy();
    expect(screen.getByText('File name')).toBeTruthy();
  });

  it('pre-fills and selects the default value', async () => {
    act(() => {
      showInputDialog('New name', 'old.txt');
    });

    const input = screen.getByTestId('plugin-dialog-input') as HTMLInputElement;
    expect(input.value).toBe('old.txt');
  });

  it('resolves with input value when OK is clicked', async () => {
    let result: { promise: Promise<string | null>; cleanup: () => void };

    act(() => {
      result = showInputDialog('Name', 'test');
    });

    const input = screen.getByTestId('plugin-dialog-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'newfile.ts' } });

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-ok'));
    });

    const value = await result!.promise;
    expect(value).toBe('newfile.ts');
  });

  it('resolves with null when Cancel is clicked', async () => {
    let result: { promise: Promise<string | null>; cleanup: () => void };

    act(() => {
      result = showInputDialog('Name');
    });

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-cancel'));
    });

    const value = await result!.promise;
    expect(value).toBeNull();
  });

  it('resolves with null when Escape is pressed', async () => {
    let result: { promise: Promise<string | null>; cleanup: () => void };

    act(() => {
      result = showInputDialog('Name', 'val');
    });

    const input = screen.getByTestId('plugin-dialog-input');
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    const value = await result!.promise;
    expect(value).toBeNull();
  });

  it('resolves with value when Enter is pressed', async () => {
    let result: { promise: Promise<string | null>; cleanup: () => void };

    act(() => {
      result = showInputDialog('Name', 'hello');
    });

    const input = screen.getByTestId('plugin-dialog-input');
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    const value = await result!.promise;
    expect(value).toBe('hello');
  });

  it('resolves with null when overlay is clicked', async () => {
    let result: { promise: Promise<string | null>; cleanup: () => void };

    act(() => {
      result = showInputDialog('Name');
    });

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-overlay'));
    });

    const value = await result!.promise;
    expect(value).toBeNull();
  });

  it('cleanup resolves with null', async () => {
    let result: { promise: Promise<string | null>; cleanup: () => void };

    act(() => {
      result = showInputDialog('Name', 'val');
    });

    act(() => {
      result!.cleanup();
    });

    const value = await result!.promise;
    expect(value).toBeNull();
  });

  it('removes container from DOM after resolving', async () => {
    let result: { promise: Promise<string | null>; cleanup: () => void };

    act(() => {
      result = showInputDialog('Name');
    });

    expect(document.querySelector('[data-plugin-dialog="input"]')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-cancel'));
    });

    await result!.promise;
    expect(document.querySelector('[data-plugin-dialog="input"]')).toBeNull();
  });

  it('has proper styling classes for elevation and contrast', () => {
    act(() => {
      showInputDialog('Test');
    });

    const dialog = screen.getByTestId('plugin-dialog');
    expect(dialog.className).toContain('shadow-2xl');
    expect(dialog.className).toContain('rounded-xl');
    expect(dialog.className).toContain('border-ctp-surface1');
  });
});

describe('showConfirmDialog', () => {
  it('renders a confirm dialog with the message', () => {
    act(() => {
      showConfirmDialog('Are you sure?');
    });

    expect(screen.getByTestId('plugin-dialog')).toBeTruthy();
    expect(screen.getByTestId('plugin-dialog-message').textContent).toBe('Are you sure?');
  });

  it('resolves true when Confirm is clicked', async () => {
    let result: { promise: Promise<boolean>; cleanup: () => void };

    act(() => {
      result = showConfirmDialog('Proceed?');
    });

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-confirm'));
    });

    const value = await result!.promise;
    expect(value).toBe(true);
  });

  it('resolves false when Cancel is clicked', async () => {
    let result: { promise: Promise<boolean>; cleanup: () => void };

    act(() => {
      result = showConfirmDialog('Proceed?');
    });

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-cancel'));
    });

    const value = await result!.promise;
    expect(value).toBe(false);
  });

  it('resolves true when Enter is pressed', async () => {
    let result: { promise: Promise<boolean>; cleanup: () => void };

    act(() => {
      result = showConfirmDialog('Proceed?');
    });

    act(() => {
      fireEvent.keyDown(document, { key: 'Enter' });
    });

    const value = await result!.promise;
    expect(value).toBe(true);
  });

  it('resolves false when Escape is pressed', async () => {
    let result: { promise: Promise<boolean>; cleanup: () => void };

    act(() => {
      result = showConfirmDialog('Proceed?');
    });

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    const value = await result!.promise;
    expect(value).toBe(false);
  });

  it('resolves false when overlay is clicked', async () => {
    let result: { promise: Promise<boolean>; cleanup: () => void };

    act(() => {
      result = showConfirmDialog('Proceed?');
    });

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-overlay'));
    });

    const value = await result!.promise;
    expect(value).toBe(false);
  });

  it('uses destructive styling for delete messages', () => {
    act(() => {
      showConfirmDialog('Delete "readme.md"? This cannot be undone.');
    });

    const confirmBtn = screen.getByTestId('plugin-dialog-confirm');
    expect(confirmBtn.className).toContain('bg-ctp-red');
    expect(confirmBtn.textContent).toBe('Delete');
  });

  it('uses accent styling for non-destructive messages', () => {
    act(() => {
      showConfirmDialog('Are you sure you want to proceed?');
    });

    const confirmBtn = screen.getByTestId('plugin-dialog-confirm');
    expect(confirmBtn.className).toContain('bg-ctp-accent');
    expect(confirmBtn.textContent).toBe('Confirm');
  });

  it('cleanup resolves with false', async () => {
    let result: { promise: Promise<boolean>; cleanup: () => void };

    act(() => {
      result = showConfirmDialog('Proceed?');
    });

    act(() => {
      result!.cleanup();
    });

    const value = await result!.promise;
    expect(value).toBe(false);
  });

  it('removes container from DOM after resolving', async () => {
    let result: { promise: Promise<boolean>; cleanup: () => void };

    act(() => {
      result = showConfirmDialog('Proceed?');
    });

    expect(document.querySelector('[data-plugin-dialog="confirm"]')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByTestId('plugin-dialog-cancel'));
    });

    await result!.promise;
    expect(document.querySelector('[data-plugin-dialog="confirm"]')).toBeNull();
  });
});
