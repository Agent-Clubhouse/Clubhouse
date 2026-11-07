import { useEffect, useRef, useState } from 'react';
import type { NewAgentCompositionPreview } from '../../../shared/new-agent-composition';

export interface NewAgentCompositionSelection {
  projectId: string;
  enabled: boolean;
  preview: NewAgentCompositionPreview | null;
}

export function NewAgentCompositionPicker({ projectId, disabled, onChange }: {
  projectId: string;
  disabled: boolean;
  onChange: (selection: NewAgentCompositionSelection) => void;
}) {
  const [base, setBase] = useState('');
  const [blocks, setBlocks] = useState<string[]>([]);
  const [availableBlocks, setAvailableBlocks] = useState<Array<{ id: string; name: string }>>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [available, setAvailable] = useState<Array<{ id: string; name: string }>>([]);
  const [preview, setPreview] = useState<NewAgentCompositionPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const token = useRef<string | null>(null);
  const release = () => {
    const current = token.current; token.current = null;
    if (current) void window.clubhouse.agent.discardNewComposition(current).catch(() => {});
  };
  useEffect(() => {
    generation.current++; release(); setPreview(null); setPending(false); setError('');
    onChange({ projectId, enabled: !!base, preview: null });
    return () => { generation.current++; release(); };
  }, [projectId, base, skills, blocks, onChange]);
  const requestPreview = async () => {
    const request = ++generation.current;
    release(); setPreview(null); setPending(true); setError('');
    onChange({ projectId, enabled: true, preview: null });
    try {
      const result = await window.clubhouse.agent.previewNewComposition(projectId, base, skills, blocks);
      if (generation.current !== request) {
        void window.clubhouse.agent.discardNewComposition(result.token).catch(() => {}); return;
      }
      token.current = result.token; setPreview(result); setAvailable(result.availableSkills); setAvailableBlocks(result.availableBlocks ?? []);
      onChange({ projectId, enabled: true, preview: result });
    } catch (error) {
      if (generation.current === request) setError(error instanceof Error ? error.message : 'Preview unavailable.');
    } finally { if (generation.current === request) setPending(false); }
  };
  return <section aria-label="New agent Builder" className="flex flex-col gap-2 py-2 text-sm">
    <label>Composition <select aria-label="New agent composition" value={base} disabled={disabled}
      onChange={(event) => { setBase(event.target.value); setSkills([]); setAvailable([]); setBlocks([]); setAvailableBlocks([]); }}>
      <option value="">Use legacy persona</option>
      <option value="builtin-builder-custom">Custom (Identity)</option>
      <option value="builtin-builder-orchestrator">Orchestrator</option>
      <option value="builtin-builder-project-manager">Project Manager</option>
      <option value="builtin-builder-researcher">Researcher</option>
    </select></label>
    {base && <>
      <p>Save a composition for a sleeping agent. This does not start or adopt it. Review next-start adoption separately.</p>
      {availableBlocks.length > 0 && <fieldset><legend>Shared instruction blocks</legend>
        <p>Selected blocks follow the role in selection order. Preview and Create save references; sources remain unchanged.</p>
        {availableBlocks.map((block) => <label key={block.id} className="flex gap-2">
          <input type="checkbox" disabled={disabled || pending} checked={blocks.includes(block.id)}
            onChange={() => setBlocks((ids) => ids.includes(block.id) ? ids.filter((id) => id !== block.id) : [...ids, block.id])} />{block.name}
        </label>)}
      </fieldset>}
      {available.map((skill) => <label key={skill.id} className="flex gap-2">
        <input type="checkbox" disabled={disabled || pending} checked={skills.includes(skill.id)}
          onChange={() => setSkills((ids) => ids.includes(skill.id) ? ids.filter((id) => id !== skill.id) : [...ids, skill.id])} />{skill.name}
      </label>)}
      <button type="button" disabled={disabled || pending} onClick={() => { void requestPreview(); }}>Preview saved composition</button>
      {preview && <>
        <pre aria-label="Reviewed composition" className="text-xs whitespace-pre-wrap max-h-64 overflow-auto">{preview.text}</pre>
        <p>Skills: {preview.skills.map((skill) => `${skill.name} (revision ${skill.revision})`).join(', ') || 'None'}. Create confirms this saved composition; provider loading is unverified.</p>
      </>}
      {error && <p role="alert">{error}</p>}
    </>}
  </section>;
}
