import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const createFromTemplate = vi.fn();
vi.mock('../../features/agents/create-agent', () => ({
  createDurableAgentFromTemplate: (...args: unknown[]) => createFromTemplate(...args),
}));
vi.mock('../../features/agents/AgentGalleryDialog', () => ({
  AgentGalleryDialog: ({ onClose, onCreate }: { onClose: () => void; onCreate: (p: unknown, c: string) => void }) => (
    <div data-testid="gallery">
      <button type="button" onClick={onClose}>Close gallery</button>
      <button type="button" onClick={() => onCreate({ id: 'reviewer', name: 'Reviewer' }, 'indigo')}>Pick</button>
    </div>
  ),
}));
vi.mock('../../features/agents/TemplateConfigDialog', () => ({
  TemplateConfigDialog: ({ onClose, onCreate }: { onClose: () => void; onCreate: (c: unknown) => void }) => (
    <div data-testid="template-config">
      <button type="button" onClick={onClose}>Close config</button>
      <button type="button" onClick={() => onCreate({ name: 'keen-heron' })}>Create from template</button>
    </div>
  ),
}));

import { ChromeAgentDialogs, useChromeDialogStore } from './ChromeAgentDialogs';
import { useProjectStore } from '../../stores/projectStore';

beforeEach(() => {
  createFromTemplate.mockReset().mockResolvedValue('t-new');
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/ch' }] as never });
  useChromeDialogStore.setState({ request: null });
});

const open = (opener?: { onCreated?: (id: string) => void; onClosed?: (id: string | null) => void }) =>
  act(() => useChromeDialogStore.getState().openGallery('p1', opener));

describe('ChromeAgentDialogs: From a template… for a New agent page opener', () => {
  it('reports an agent made from a template, then closes', async () => {
    const events: string[] = [];
    render(<ChromeAgentDialogs />);
    open({ onCreated: (id) => events.push(`created:${id}`), onClosed: (id) => events.push(`closed:${id}`) });
    fireEvent.click(screen.getByText('Pick'));
    fireEvent.click(screen.getByText('Create from template'));
    await waitFor(() => expect(events).toEqual(['created:t-new', 'closed:t-new']));
    expect(createFromTemplate).toHaveBeenCalledWith({ id: 'p1', path: '/ch' }, { name: 'keen-heron' });
  });

  it('ends with onClosed(null) when the template fails', async () => {
    createFromTemplate.mockResolvedValue(null);
    const onCreated = vi.fn();
    const onClosed = vi.fn();
    render(<ChromeAgentDialogs />);
    open({ onCreated, onClosed });
    fireEvent.click(screen.getByText('Pick'));
    fireEvent.click(screen.getByText('Create from template'));
    await waitFor(() => expect(onClosed).toHaveBeenCalledExactlyOnceWith(null));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('ends with onClosed(null) when the gallery or the template dialog is dismissed', () => {
    const onClosed = vi.fn();
    render(<ChromeAgentDialogs />);
    open({ onClosed });
    fireEvent.click(screen.getByText('Close gallery'));
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(null);
    onClosed.mockClear();
    open({ onClosed });
    fireEvent.click(screen.getByText('Pick'));
    fireEvent.click(screen.getByText('Close config'));
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('works without an opener, as from the New menu', async () => {
    render(<ChromeAgentDialogs />);
    open();
    fireEvent.click(screen.getByText('Pick'));
    fireEvent.click(screen.getByText('Create from template'));
    await waitFor(() => expect(createFromTemplate).toHaveBeenCalled());
  });
});
