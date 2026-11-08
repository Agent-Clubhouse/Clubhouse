/**
 * A quick agent's parts for one launch (#2928, D102): the template's
 * instruction blocks and MCP servers, each kept or left out, plus parts added
 * from the library. It is the preview: what's ticked is what the run gets.
 * Nothing is saved; the template, the library and the next launch don't
 * change. Skills aren't listed, since a quick agent has no folder of its own
 * to get them (D25), and MCP servers only for a CLI that takes them at
 * launch. Blocks show as the run gets them: the working Identity in place of
 * the durable one.
 */
import { useEffect, useId } from 'react';
import { CLUBHOUSE_MCP_PART_ID, IDENTITY_BLOCK_ID, isListed, workingIdentityBlocks, type ManagedPartSummary, type ManagedTemplate } from '../../../shared/managed-agents-types';
import type { QuickRunChanges } from '../../../shared/types';
import { useManagedParts, useManagedTemplates } from '../../features/managed/managedApi';
import { builtFromLine } from '../../features/managed/attribution';
import { Row, selectClass } from './newAgentUi';

export const NO_QUICK_CHANGES: QuickRunChanges = { added: [], removed: [] };

/** "Release template, plus Extra, minus Tone", or the template as is. */
export function quickRunSummary(template: Pick<ManagedTemplate, 'name'>, changes: QuickRunChanges, nameOf: (id: string) => string | undefined): string {
  if (changes.added.length === 0 && changes.removed.length === 0) return 'The template as it is. Untick a part to leave it out of this run, or add one.';
  return `${builtFromLine(template.name, changes, nameOf)}. For this run only: the template doesn’t change.`;
}

export function QuickRunParts({ template: picked, value, onChange, disabled, mcpLaunchFlags }: {
  template: ManagedTemplate;
  value: QuickRunChanges;
  onChange: (next: QuickRunChanges) => void;
  disabled: boolean;
  /** The CLI takes MCP servers at launch; without that, a quick agent gets none (D25). */
  mcpLaunchFlags: boolean;
}) {
  const addId = useId();
  const blocks = useManagedParts('block');
  const mcps = useManagedParts('mcp');
  // The template as it is now, not as it was when picked.
  const template = useManagedTemplates().value?.find((t) => t.id === picked.id) ?? picked;
  const library = [...(blocks.value ?? []), ...(mcps.value ?? [])];
  const byId = new Map(library.map((p) => [p.id, p]));
  const nameOf = (id: string) => byId.get(id)?.name;
  const isMcp = (id: string) => byId.get(id)?.kind === 'mcp';
  const inTemplate = [
    ...workingIdentityBlocks(template.setup.blocks),
    ...(mcpLaunchFlags ? template.setup.mcps.filter((id) => id !== CLUBHOUSE_MCP_PART_ID) : []),
  ];
  const listedIds = [...inTemplate, ...value.added];
  // What a person could add to a setup: library parts that are offered, not already here. The durable
  // Identity never: the run gets the working one in its place.
  const addable = (list: ManagedPartSummary[] | null) => (list ?? []).filter((p) => isListed(p) && p.id !== CLUBHOUSE_MCP_PART_ID && p.id !== IDENTITY_BLOCK_ID && !listedIds.includes(p.id));
  const loaded = blocks.value !== null && mcps.value !== null;
  // Only changes that reach the run: no MCP server for a CLI without launch flags (picked after the parts),
  // and nothing left out that the template no longer has.
  useEffect(() => {
    if (!loaded) return;
    const added = mcpLaunchFlags ? value.added : value.added.filter((id) => !isMcp(id));
    const removed = value.removed.filter((id) => inTemplate.includes(id));
    if (added.length !== value.added.length || removed.length !== value.removed.length) onChange({ added, removed });
  });
  const toggle = (id: string, keep: boolean) => {
    if (value.added.includes(id)) {
      if (!keep) onChange({ ...value, added: value.added.filter((x) => x !== id) });
      return;
    }
    onChange({ ...value, removed: keep ? value.removed.filter((x) => x !== id) : [...value.removed, id] });
  };
  const add = (id: string) => {
    if (!id) return;
    // Ticking a left-out template part again is the way back, so adding one just keeps it.
    if (inTemplate.includes(id)) onChange({ ...value, removed: value.removed.filter((x) => x !== id) });
    else onChange({ ...value, added: [...value.added, id] });
  };
  const loading = blocks.value === null || mcps.value === null;
  const error = blocks.error ?? mcps.error;

  return (
    <Row
      label="This run"
      top
      htmlFor={addId}
      help={error
        ? <span className="text-ctp-error" role="alert">{error}</span>
        : <span data-testid="quick-run-summary">{loading ? 'Loading parts' : quickRunSummary(template, value, nameOf)}</span>}
    >
      <div className="w-[288px] flex flex-col gap-1.5">
        <fieldset className="max-h-40 overflow-y-auto rounded-md border border-surface-1 bg-ctp-crust p-1.5" data-testid="quick-run-parts">
          <legend className="sr-only">Parts for this run</legend>
          {listedIds.length === 0 && <p className="h-6 flex items-center text-xs text-ctp-overlay1">The template has no instruction blocks or MCP servers.</p>}
          {listedIds.map((id) => {
            const part = byId.get(id);
            const added = value.added.includes(id);
            return (
              <label key={id} className="h-6 flex items-center gap-1.5 text-xs text-ctp-text cursor-pointer" title={part?.description}>
                <input
                  type="checkbox"
                  checked={added || !value.removed.includes(id)}
                  disabled={disabled}
                  onChange={(e) => toggle(id, e.target.checked)}
                  className="w-3.5 h-3.5 accent-ctp-accent"
                />
                <span className="truncate">{part?.name ?? (loading ? 'Loading' : 'A part no longer in the library')}</span>
                <span className="ml-auto flex-shrink-0 text-ctp-overlay1">{added ? 'Added' : part?.kind === 'mcp' ? 'MCP server' : 'Instructions'}</span>
              </label>
            );
          })}
        </fieldset>
        <select
          id={addId}
          aria-label="Add a part to this run"
          data-testid="quick-run-add"
          value=""
          disabled={disabled || loading}
          onChange={(e) => add(e.target.value)}
          className={`${selectClass} w-full`}
        >
          <option value="">Add a part…</option>
          {addable(blocks.value).length > 0 && (
            <optgroup label="Instruction blocks">
              {addable(blocks.value).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          )}
          {mcpLaunchFlags && addable(mcps.value).length > 0 && (
            <optgroup label="MCP servers">
              {addable(mcps.value).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          )}
        </select>
      </div>
    </Row>
  );
}
