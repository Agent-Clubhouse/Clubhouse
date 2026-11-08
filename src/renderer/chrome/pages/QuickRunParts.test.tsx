import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUBHOUSE_MCP_PART_ID, IDENTITY_BLOCK_ID, WORKING_IDENTITY_BLOCK_ID, type ManagedTemplate } from '../../../shared/managed-agents-types';
import type { QuickRunChanges } from '../../../shared/types';
import { NO_QUICK_CHANGES, QuickRunParts } from './QuickRunParts';

const part = (id: string, name: string, kind: string) => ({ id, name, kind, description: '', builtin: false, usedBy: [], templates: [] });
const template: ManagedTemplate = {
  id: 'tpl', name: 'Release', description: '', builtin: false, settings: {},
  setup: { blocks: [IDENTITY_BLOCK_ID, 'b-tone'], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID, 'p-workiq'] },
};
let templates: ManagedTemplate[];
let seen: QuickRunChanges[];

function Harness({ mcpLaunchFlags }: { mcpLaunchFlags: boolean }) {
  const [value, setValue] = useState<QuickRunChanges>(NO_QUICK_CHANGES);
  return <QuickRunParts template={template} value={value} onChange={(v) => { seen.push(v); setValue(v); }} disabled={false} mcpLaunchFlags={mcpLaunchFlags} />;
}

beforeEach(() => {
  seen = [];
  templates = [template];
  const m = window.clubhouse.managed;
  vi.spyOn(m, 'listTemplates').mockImplementation(async () => ({ ok: true, value: templates }) as never);
  vi.spyOn(m, 'listParts').mockImplementation(async (kind: string) => ({
    ok: true,
    value: kind === 'block'
      ? [part(IDENTITY_BLOCK_ID, 'Identity', 'block'), part(WORKING_IDENTITY_BLOCK_ID, 'Identity (working)', 'block'), part('b-tone', 'Tone', 'block'), part('b-extra', 'Extra', 'block')]
      : [part(CLUBHOUSE_MCP_PART_ID, 'Clubhouse', 'mcp'), part('p-workiq', 'WorkIQ', 'mcp'), part('p-github', 'GitHub', 'mcp')],
  }) as never);
});

const addOptions = () => Array.from((screen.getByTestId('quick-run-add') as HTMLSelectElement).options).map((o) => o.textContent);

describe('QuickRunParts (#2928)', () => {
  it('lists blocks as the run gets them: the working Identity, and the durable one is never offered', async () => {
    render(<Harness mcpLaunchFlags />);
    await waitFor(() => expect(screen.getByTestId('quick-run-parts').textContent).toContain('Identity (working)'));
    expect(screen.getByRole('checkbox', { name: /Identity \(working\)/ })).toBeChecked();
    expect(addOptions()).toEqual(['Add a part…', 'Extra', 'GitHub']);
    fireEvent.click(screen.getByRole('checkbox', { name: /Identity \(working\)/ }));
    expect(seen.at(-1)).toEqual({ added: [], removed: [WORKING_IDENTITY_BLOCK_ID] });
  });

  it('offers MCP servers only to a CLI that takes them at launch, and drops MCP changes when the CLI changes', async () => {
    const { rerender } = render(<Harness mcpLaunchFlags />);
    await waitFor(() => expect(screen.getByTestId('quick-run-parts').textContent).toContain('WorkIQ'));
    fireEvent.click(screen.getByRole('checkbox', { name: /WorkIQ/ }));
    fireEvent.change(screen.getByTestId('quick-run-add'), { target: { value: 'p-github' } });
    fireEvent.change(screen.getByTestId('quick-run-add'), { target: { value: 'b-extra' } });
    expect(seen.at(-1)).toEqual({ added: ['p-github', 'b-extra'], removed: ['p-workiq'] });
    rerender(<Harness mcpLaunchFlags={false} />);
    await waitFor(() => expect(seen.at(-1)).toEqual({ added: ['b-extra'], removed: [] }));
    expect(screen.getByTestId('quick-run-parts').textContent).not.toContain('WorkIQ');
    expect(addOptions()).not.toContain('GitHub');
  });

  it('follows the template as it is now: a part taken out since it was picked is no longer left out', async () => {
    const listeners: Array<() => void> = [];
    vi.spyOn(window.clubhouse.managed, 'onChanged').mockImplementation(((fn: () => void) => { listeners.push(fn); return () => undefined; }) as never);
    render(<Harness mcpLaunchFlags />);
    await waitFor(() => expect(screen.getByTestId('quick-run-parts').textContent).toContain('Tone'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tone/ }));
    expect(seen.at(-1)).toEqual({ added: [], removed: ['b-tone'] });
    templates = [{ ...template, setup: { ...template.setup, blocks: [IDENTITY_BLOCK_ID] } }];
    act(() => { for (const fn of listeners) fn(); });
    await waitFor(() => expect(screen.getByTestId('quick-run-parts').textContent).not.toContain('Tone'));
    await waitFor(() => expect(seen.at(-1)).toEqual({ added: [], removed: [] }));
  });
});
