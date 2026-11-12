import { useEffect, useId, useRef, useState } from 'react';
import type { ConnectionGuidanceSnapshot } from '../../../../shared/connection-guidance';
import type { ConnectionToolCatalog } from '../../../../main/services/clubhouse-mcp/types';
import { Button } from '../../../components/Button';
import { reportChromeActionFailed } from '../../../chrome/telemetry';

export interface GuidanceDirection {
  from: string;
  to: string;
  label: string;
}

interface Draft {
  snapshot: ConnectionGuidanceSnapshot;
  catalog: ConnectionToolCatalog | undefined;
  catalogError?: string;
  instructions: Record<string, string>;
  confirmed: boolean;
  dirty: boolean;
}

const keyOf = (direction: GuidanceDirection) => JSON.stringify([direction.from, direction.to]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ConnectionGuidanceEditor({ directions }: { directions: GuidanceDirection[] }) {
  const [selected, setSelected] = useState(0);
  const [tool, setTool] = useState('*');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reload, setReload] = useState(0);
  const previewRequest = useRef(0);
  const selectId = useId();
  const directionKey = JSON.stringify(directions.map(({ from, to }) => [from, to]));

  useEffect(() => {
    let active = true;
    previewRequest.current += 1;
    setPreview(null);
    setErrors({});
    setSelected((before) => before < (JSON.parse(directionKey) as Array<unknown>).length ? before : 0);
    for (const [from, to] of JSON.parse(directionKey) as Array<[string, string]>) {
      const key = JSON.stringify([from, to]);
      Promise.allSettled([
        window.clubhouse.mcpBinding.getConnectionGuidance(from, to),
        window.clubhouse.mcpBinding.getConnectionToolCatalog(from, to),
      ]).then(([guidance, tools]) => {
        if (tools.status === 'rejected') reportChromeActionFailed('agent_settings_save', tools.reason);
        if (guidance.status === 'rejected') {
          reportChromeActionFailed('agent_settings_save', guidance.reason);
          if (active) setErrors((before) => ({ ...before, [key]: errorText(guidance.reason) }));
          return;
        }
        const snapshot = guidance.value;
        if (active) setDrafts((before) => ({
          ...before,
          [key]: {
            snapshot, catalog: tools.status === 'fulfilled' ? tools.value : undefined,
            catalogError: tools.status === 'rejected' ? errorText(tools.reason) : undefined,
            instructions: before[key]?.dirty ? before[key].instructions : { ...snapshot.instructions },
            confirmed: false, dirty: before[key]?.dirty ?? false,
          },
        }));
      }).catch((error: unknown) => {
        reportChromeActionFailed('agent_settings_save', error);
        if (active) setErrors((before) => ({ ...before, [key]: errorText(error) }));
      });
    }
    return () => { active = false; previewRequest.current += 1; };
  }, [directionKey, reload]);

  const direction = directions[selected] ?? directions[0];
  if (!direction) return null;
  const key = keyOf(direction);
  const draft = drafts[key];
  const catalogTools = draft?.catalog?.state === 'available' ? draft.catalog.tools : [];
  const catalogUnavailable = draft?.catalog?.state !== 'available';
  const readOnly = !draft || draft.snapshot.readOnly || draft.snapshot.unreadable.length > 0;
  const toolOptions = [...new Set([...catalogTools.map((entry) => entry.suffix), ...Object.keys(draft?.instructions ?? {})])].filter((suffix) => suffix !== '*');
  const update = (changes: Partial<Draft>) => {
    setDrafts((before) => ({ ...before, [key]: { ...before[key], ...changes } }));
    setMessage('');
    setPreview(null);
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setErrors((before) => ({ ...before, [key]: '' }));
    setMessage('');
    try {
      const snapshot = await window.clubhouse.mcpBinding.saveConnectionGuidance(direction.from, direction.to, {
        instructions: draft.instructions, revision: draft.snapshot.revision, replaceAcrossSources: draft.confirmed,
      });
      setDrafts((before) => ({ ...before, [key]: { ...before[key], snapshot, instructions: { ...snapshot.instructions }, dirty: false, confirmed: false } }));
      if (tool !== '*' && !snapshot.instructions[tool] && !catalogTools.some((entry) => entry.suffix === tool)) setTool('*');
      setMessage(snapshot.notice ?? `Saved: ${direction.label}. Sessions were not restarted.`);
    } catch (error) {
      reportChromeActionFailed('agent_settings_save', error);
      setErrors((before) => ({ ...before, [key]: `${errorText(error)} Your draft is still here.` }));
    } finally {
      setSaving(false);
    }
  };
  const showPreview = async () => {
    if (!draft) return;
    setPreviewing(true);
    setPreview(null);
    const request = ++previewRequest.current;
    try {
      const descriptions = await window.clubhouse.mcpBinding.previewConnectionGuidance(direction.from, direction.to, draft.instructions);
      if (request === previewRequest.current) setPreview(descriptions);
    } catch (error) {
      reportChromeActionFailed('agent_settings_save', error);
      setErrors((before) => ({ ...before, [key]: errorText(error) }));
    } finally {
      setPreviewing(false);
    }
  };
  const reverseIndex = directions.findIndex((other) => other.from === direction.to && other.to === direction.from);
  const reverse = reverseIndex < 0 ? undefined : drafts[keyOf(directions[reverseIndex])];
  const copyToReverse = () => {
    if (!draft || !reverse) return;
    const reverseKey = keyOf(directions[reverseIndex]);
    setDrafts((before) => ({
      ...before,
      [reverseKey]: { ...before[reverseKey], instructions: { ...draft.instructions }, dirty: true, confirmed: false },
    }));
    setSelected(reverseIndex);
    setTool('*');
    setPreview(null);
    setMessage('Copied to the reverse draft only. Save that direction separately.');
  };

  return (
    <section className="mt-4 border-t border-surface-1 pt-3" aria-label="Directional guidance" data-testid="connection-guidance-editor">
      <h3 className="text-[13px] text-ctp-text mb-2">Guidance</h3>
      <div className="flex flex-wrap gap-2 mb-2" role="group" aria-label="Guidance direction">
        {directions.map((entry, index) => (
          <Button key={keyOf(entry)} kind={index === selected ? 'primary' : 'quiet'} disabled={saving || previewing} onClick={() => {
            setSelected(index); setTool('*'); setPreview(null); setMessage('');
          }}>{entry.label}</Button>
        ))}
      </div>
      <p className="text-xs text-ctp-overlay1 mb-2">Guidance changes descriptions, not permissions. Each direction is saved separately.</p>
      {errors[key] && <p role="alert" className="text-xs text-ctp-error mb-2">{errors[key]}</p>}
      {!draft ? (
        errors[key] ? <Button onClick={() => setReload((value) => value + 1)}>Retry guidance</Button> : <p className="text-xs text-ctp-overlay1">Loading guidance...</p>
      ) : (
        <>
          {draft.snapshot.readOnlyReason && <p role="alert" className="text-xs text-ctp-overlay1 mb-2">{draft.snapshot.readOnlyReason}</p>}
          {draft.snapshot.unreadable.length > 0 && <p role="alert" className="text-xs text-ctp-error mb-2">Some sources could not be checked: {draft.snapshot.unreadable.join(', ')}. Reload before editing.</p>}
          {catalogUnavailable && <p role="alert" className="text-xs text-ctp-error mb-2">Tool catalog unavailable{draft.catalogError ? `: ${draft.catalogError}` : ''}. Default and saved tool guidance can still be edited. Reload after tools are registered.</p>}
          <label htmlFor={selectId} className="block text-xs text-ctp-subtext1">Apply guidance to</label>
          <select id={selectId} value={tool} disabled={saving || previewing} onChange={(event) => { setTool(event.target.value); setPreview(null); }}
            className="mt-1 w-full h-7 bg-ctp-base border border-surface-1 rounded-md px-2 text-xs text-ctp-text focus-ring" data-testid="wire-instructions-tool-select">
            <option value="*">Default for all tools</option>
            {toolOptions.map((suffix) => {
              const entry = catalogTools.find((candidate) => candidate.suffix === suffix);
              return <option key={suffix} value={suffix}>{suffix}{entry ? entry.available ? '' : ' (unavailable now)' : ' (saved; unavailable)'}</option>;
            })}
          </select>
          <textarea aria-label="Instructions" value={draft.instructions[tool] ?? ''} disabled={readOnly || saving || previewing}
            onChange={(event) => update({ instructions: { ...draft.instructions, [tool]: event.target.value }, dirty: true })}
            className="mt-2 w-full h-28 bg-ctp-base border border-surface-1 rounded-md px-2.5 py-2 text-xs text-ctp-text resize-y focus-ring" data-testid="wire-instructions-textarea" />
          <p className="text-xs text-ctp-overlay1">A nonempty per-tool override replaces the default. Clear it to use the default. Unavailable saved overrides are kept.</p>
          {draft.snapshot.sources.length > 0 && (
            <details className="mt-2 text-xs text-ctp-subtext1">
              <summary>{draft.snapshot.conflictingSources ? 'Conflicting original guidance' : 'Original source guidance'} (retained)</summary>
              {draft.snapshot.sources.map((source, index) => (
                <div key={`${source.sourceId}-${index}`} className="mt-2">
                  <strong title={source.storeId}>{source.label ?? source.sourceId}</strong>
                  {Object.entries(source.instructions).map(([suffix, text]) => <pre key={suffix} className="whitespace-pre-wrap break-words">{suffix}: {text}</pre>)}
                  {Object.keys(source.instructions).length === 0 && <p>No original guidance.</p>}
                </div>
              ))}
            </details>
          )}
          {draft.snapshot.needsSourceConfirmation && (
            <label className="flex items-start gap-2 text-xs text-ctp-subtext1 mt-2">
              <input type="checkbox" checked={draft.confirmed} disabled={readOnly || saving} onChange={(event) => update({ confirmed: event.target.checked })} />
              Replace effective guidance across this direction's sources; keep their originals.
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Button kind="primary" disabled={readOnly || saving || previewing || !draft.dirty || (draft.snapshot.needsSourceConfirmation && !draft.confirmed)} onClick={() => void save()} data-testid="wire-instructions-save">{saving ? 'Saving...' : 'Save direction'}</Button>
            <Button disabled={catalogUnavailable || saving || previewing} onClick={() => void showPreview()}>{previewing ? 'Loading preview...' : 'Preview descriptions'}</Button>
            {reverse && <Button disabled={readOnly || reverse.snapshot.readOnly || reverse.snapshot.unreadable.length > 0 || saving || previewing} onClick={copyToReverse}>Copy guidance to reverse draft</Button>}
            {(errors[key] || readOnly || catalogUnavailable) && <Button disabled={saving || previewing} onClick={() => setReload((value) => value + 1)}>Reload sources and keep draft</Button>}
          </div>
          {preview && <div className="mt-3 text-xs text-ctp-subtext1" aria-label="Effective descriptions">
            {Object.entries(preview).filter(([suffix]) => tool === '*' || tool === suffix).map(([suffix, text]) => (
              <details key={suffix} open={tool !== '*'}><summary>{suffix}</summary><pre className="whitespace-pre-wrap break-words">{text}</pre></details>
            ))}
            {Object.keys(preview).length === 0 && <p>No tools are registered for this target.</p>}
          </div>}
          {message && <p role="status" className="mt-2 text-xs text-ctp-subtext1">{message}</p>}
        </>
      )}
    </section>
  );
}
