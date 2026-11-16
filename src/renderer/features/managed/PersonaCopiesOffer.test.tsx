import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPersonaCopies } from '../../../shared/managed-agents-types';
import { PersonaCopiesOffer, removeLine, repeatsLine, sizeText } from './PersonaCopiesOffer';

/** Remove duplicate copies on the agent's Settings card (#3579). */

const m = () => window.clubhouse.managed;
const offer: ManagedPersonaCopies = {
  blockId: 'asset-notes', blockName: 'clever-panda notes', revision: 1,
  personas: [{ name: 'Orchestrator', copies: 21, keep: 'one' }], removed: 20, bytesSaved: 124_000,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('offer copy', () => {
  it('says how many times, how many copies go and the size saved', () => {
    expect(repeatsLine(offer)).toBe('clever-panda notes repeats the Orchestrator persona 21 times.');
    expect(removeLine(offer)).toBe('Removing 20 copies keeps one and saves 121 KB. Your own text in the block stays as it is.');
    expect(removeLine({ ...offer, personas: [{ name: 'Orchestrator', copies: 21, keep: 'none' }], removed: 21 }))
      .toBe('Removing all 21 copies saves 121 KB. Every agent using this block already has the built-in Orchestrator block. Your own text in the block stays as it is.');
    expect(repeatsLine({ ...offer, personas: [{ name: 'Orchestrator', copies: 2, keep: 'one' }, { name: 'Researcher', copies: 3, keep: 'one' }] }))
      .toBe('clever-panda notes repeats the Orchestrator persona twice and the Researcher persona 3 times.');
    expect(sizeText(820)).toBe('820 bytes');
  });
});

describe('PersonaCopiesOffer', () => {
  it('shows nothing when no block repeats a persona', async () => {
    const list = vi.spyOn(m(), 'personaCopies').mockResolvedValue({ ok: true, value: [] } as never);
    render(<PersonaCopiesOffer projectPath="/p" agentId="panda" />);
    await waitFor(() => expect(list).toHaveBeenCalledWith('/p', 'panda'));
    expect(screen.queryByTestId('details-setup-persona-copies')).toBeNull();
  });

  it('offers removal, removes with the revision it showed, and Undo restores the revision before', async () => {
    vi.spyOn(m(), 'personaCopies').mockResolvedValue({ ok: true, value: [offer] } as never);
    const remove = vi.spyOn(m(), 'removePersonaCopies').mockResolvedValue({ ok: true, value: { blockId: 'asset-notes', fromRevision: 1, revision: 2, removed: 20, bytesSaved: 124_000 } } as never);
    const restore = vi.spyOn(m(), 'restorePartRevision').mockResolvedValue({ ok: true, value: {} } as never);
    render(<PersonaCopiesOffer projectPath="/p" agentId="panda" />);

    expect(await screen.findByTestId('details-setup-persona-copies')).toHaveTextContent('clever-panda notes repeats the Orchestrator persona 21 times. Removing 20 copies keeps one and saves 121 KB.');
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('details-setup-persona-copies-remove'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/p', 'panda', 'asset-notes', 1, 20));
    expect(await screen.findByTestId('details-setup-persona-copies-done')).toHaveTextContent('Removed 20 copies from clever-panda notes and saved 121 KB.');
    expect(screen.queryByTestId('details-setup-persona-copies')).toBeNull();

    fireEvent.click(screen.getByTestId('details-setup-persona-copies-undo'));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('asset-notes', 1, 2));
    await waitFor(() => expect(screen.queryByTestId('details-setup-persona-copies-done')).toBeNull());
  });

  it('shows a refused removal and keeps the offer', async () => {
    vi.spyOn(m(), 'personaCopies').mockResolvedValue({ ok: true, value: [offer] } as never);
    vi.spyOn(m(), 'removePersonaCopies').mockResolvedValue({ ok: false, code: 'stale', message: 'It changed since you opened it.' } as never);
    render(<PersonaCopiesOffer projectPath="/p" agentId="panda" />);
    fireEvent.click(await screen.findByTestId('details-setup-persona-copies-remove'));
    expect(await screen.findByRole('alert')).toHaveTextContent('It changed since you opened it.');
    expect(screen.getByTestId('details-setup-persona-copies')).toBeInTheDocument();
  });
});
