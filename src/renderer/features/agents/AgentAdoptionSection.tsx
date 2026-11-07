import { useEffect, useRef, useState } from 'react';
import type { ActivationDeliveryPreview, ActivationObservation, ActivationPolicyChoice, ActivationReceiptView, ActivationUiErrorCode } from '../../../shared/managed-activation-ui';
import { Button } from '../../components/Button';
import { SectionHeading, selectClass } from './agentSettingsUi';

const ERROR_COPY: Record<ActivationUiErrorCode, string> = {
  stale: 'The saved blocks, target or receipt changed. Refresh and review a new delivery preview.',
  target_unavailable: 'This local agent is unavailable for adoption. Dispatcher agents, helpers and disposed agents are excluded.',
  not_permitted: 'Only a local user can adopt a snapshot.',
  unsupported: 'This delivery supports local macOS Claude fresh terminal sessions. Resume, chat and other platforms or providers are unsupported.',
  incompatible: 'Existing hooks, MCP, Clubhouse materialization, helpers, wrappers or command prefixes need delivery this adapter cannot preserve. Your settings were kept.',
  capability_unproven: 'The installed CLI has not established support for the required session flags.',
  capability_stale: 'The installed CLI changed. Review a new delivery preview before adopting.',
  busy: 'The agent is changing state. Refresh before trying again.',
  catalog_blocked: 'The saved composition has conflicting or unsupported delivery, such as MCP, native subagents or operational defaults.',
  skill_unsupported: 'A selected skill has unsupported frontmatter or dynamic command interpolation.',
  unreconciled: 'A previous start has no confirmed end. Another start is blocked until it is reconciled.',
  failed: 'Could not load or save adoption. Refresh before trying again.',
};

function observationText(item: ActivationObservation): string {
  if (item.outcome === 'process_not_created') return 'Process not created.';
  if (item.outcome === 'process_started_receipt_failed') return `PTY creation observed, but receipt persistence failed. Cleanup ${item.cleanupRequested ? 'requested' : 'not requested'}; exit ${item.cleanupConfirmed ? 'confirmed' : 'unconfirmed'}.`;
  if (item.outcome === 'pty_process_created') return `PTY process created at ${item.startedAt}. ${item.endedAt ? `Exit observed at ${item.endedAt}.` : 'No exit observation is recorded.'}`;
  return 'Start intent recorded. Process creation has no receipt.';
}

/** Only saved catalog selection enters this surface. Draft block text never enters its requests. */
export function AgentAdoptionSection({ projectId, agentId, compositionRevision, hasDrafts }: {
  projectId: string; agentId: string; compositionRevision: number; hasDrafts: boolean;
}) {
  const targetKey = JSON.stringify([projectId, agentId, compositionRevision]);
  const [choices, setChoices] = useState<{ targetKey: string; content: ActivationPolicyChoice['content'] | ''; structure: ActivationPolicyChoice['structure'] | '' }>({ targetKey, content: '', structure: '' });
  const contentChoice = choices.targetKey === targetKey ? choices.content : '';
  const structureChoice = choices.targetKey === targetKey ? choices.structure : '';
  const [state, setState] = useState<{ key: string; view: ActivationReceiptView } | null>(null);
  const receipt = state?.key === targetKey ? state.view : null;
  const requestKey = JSON.stringify([targetKey, hasDrafts, contentChoice, structureChoice, receipt?.receiptRevision]);
  const currentKey = useRef(requestKey); currentKey.current = requestKey;
  const currentTarget = useRef(targetKey); currentTarget.current = targetKey;
  const operation = useRef(0);
  const readSequence = useRef(0);
  const mutationEpoch = useRef(0);
  const receiptRef = useRef<{ key: string; view: ActivationReceiptView } | null>(null);
  if (receiptRef.current?.key !== targetKey) receiptRef.current = null;
  const inFlight = useRef(false);
  const [previewState, setPreviewState] = useState<{ key: string; view: ActivationDeliveryPreview } | null>(null);
  const preview = previewState?.key === requestKey && !hasDrafts ? previewState.view : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const target = { projectId, agentId };

  function acceptReceipt(key: string, view: ActivationReceiptView) {
    if (receiptRef.current?.key === key && receiptRef.current.view.receiptRevision > view.receiptRevision) return;
    receiptRef.current = { key, view }; setState({ key, view });
  }
  async function refresh() {
    const captured = targetKey; const read = ++readSequence.current; const epoch = mutationEpoch.current;
    const current = () => currentTarget.current === captured && readSequence.current === read && mutationEpoch.current === epoch;
    try {
      const result = await window.clubhouse.agentSettings.activationRead(target);
      if (!current()) return;
      if (result.ok === true) acceptReceipt(captured, result.view);
      else setError(ERROR_COPY[result.code]);
    } catch {
      // telemetry-exempt: an obsolete read error must not replace newer mutation or target state.
      if (current()) setError(ERROR_COPY.failed);
    }
  }
  useEffect(() => {
    setError(''); setNotice(''); setPreviewState(null); setBusy(false); inFlight.current = false;
    operation.current++; mutationEpoch.current++; readSequence.current++;
    void refresh();
    return () => { readSequence.current++; };
  }, [projectId, agentId, compositionRevision, targetKey]);
  useEffect(() => { setPreviewState(null); }, [requestKey]);

  const matchesSaved = receipt?.compositionRevision === compositionRevision;
  const canPreview = !!receipt && matchesSaved && !hasDrafts && !!contentChoice && !!structureChoice;
  async function action(kind: 'preview' | 'adopt' | 'unassign') {
    if (inFlight.current || busy || !receipt || (kind !== 'unassign' && !canPreview) || (kind === 'adopt' && !preview)) return;
    const captured = requestKey; const call = ++operation.current;
    readSequence.current++;
    if (kind !== 'preview') mutationEpoch.current++;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    if (kind !== 'adopt') setPreviewState(null);
    try {
      if (kind === 'preview') {
        const result = await window.clubhouse.agentSettings.activationPreview({ target, compositionRevision, receiptRevision: receipt.receiptRevision,
          policy: { content: contentChoice as ActivationPolicyChoice['content'], structure: structureChoice as ActivationPolicyChoice['structure'] } });
        if (currentKey.current !== captured || operation.current !== call) return;
        if (result.ok === true) setPreviewState({ key: captured, view: result.view }); else { setError(ERROR_COPY[result.code]); await refresh(); }
      } else if (kind === 'adopt') {
        const result = await window.clubhouse.agentSettings.activationAdopt({ target, compositionRevision, receiptRevision: receipt.receiptRevision,
          policy: preview!.policy, deliveryToken: preview!.deliveryToken });
        if (currentTarget.current !== targetKey || operation.current !== call) return;
        setPreviewState(null);
        if (result.ok === true) { acceptReceipt(targetKey, result.view); setNotice('Snapshot saved for the next supported fresh start. This action did not start the agent.'); }
        else { setError(ERROR_COPY[result.code]); await refresh(); }
      } else {
        const result = await window.clubhouse.agentSettings.activationUnassign({ target, receiptRevision: receipt.receiptRevision });
        if (currentTarget.current !== targetKey || operation.current !== call) return;
        setPreviewState(null);
        if (result.ok === true) { acceptReceipt(targetKey, result.view); setNotice('Future adoption removed. Retained history and running sessions were kept.'); }
        else { setError(ERROR_COPY[result.code]); await refresh(); }
      }
    } catch {
      // telemetry-exempt: raw IPC errors may contain private text or paths; show a fixed message.
      if (currentKey.current === captured && operation.current === call) { setPreviewState(null); setError(ERROR_COPY.failed); }
    } finally { if (operation.current === call) { inFlight.current = false; setBusy(false); } }
  }

  return <section aria-label="Next-start adoption" className="border-t border-surface-0 mt-6 pt-3">
    <SectionHeading title="Next-start adoption" />
    <p className="text-ctp-subtext0 mb-2">Builder edits remain saved only. A separate adopted snapshot can be passed on a supported fresh start. Adoption does not start or wake this agent.</p>
    <p className="text-xs text-ctp-overlay1 mb-3">Choose both policy parameters for this snapshot. No automatic update policy is set. Delivery currently supports local macOS Claude fresh terminal sessions with compatible existing settings.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-ctp-subtext0">Content revisions
        <select aria-label="Content revision policy" className={`${selectClass} w-full mt-1`} value={contentChoice} disabled={busy || hasDrafts}
          onChange={(event) => setChoices({ targetKey, content: event.target.value as typeof contentChoice, structure: structureChoice })}>
          <option value="">Choose content policy</option><option value="takeable">Latest revisions this agent can take</option><option value="hold-preview">Hold revisions shown in this preview</option>
        </select>
      </label>
      <label className="text-xs text-ctp-subtext0">Template structure
        <select aria-label="Structure adoption policy" className={`${selectClass} w-full mt-1`} value={structureChoice} disabled={busy || hasDrafts}
          onChange={(event) => setChoices({ targetKey, content: contentChoice, structure: event.target.value as typeof structureChoice })}>
          <option value="">Choose structure policy</option><option value="accepted">Keep accepted structure</option><option value="latest-if-clean">Use clean structure updates</option>
        </select>
      </label>
    </div>
    {hasDrafts && <p className="text-xs text-ctp-subtext0 mt-2">Save or discard Builder drafts before reviewing adoption. The effective preview above can include unsaved text.</p>}
    {receipt && !matchesSaved && <p className="text-xs text-ctp-subtext0 mt-2">The saved blocks changed. Reload Builder before reviewing adoption.</p>}
    <div className="flex flex-wrap gap-2 my-3">
      <Button kind="ghost" disabled={busy || !canPreview} onClick={() => void action('preview')}>Preview saved delivery</Button>
      <Button kind="quiet" disabled={busy} onClick={() => { setError(''); setPreviewState(null); void refresh(); }}>Refresh receipts</Button>
      <Button kind="quiet" disabled={busy || hasDrafts || !receipt?.desiredGenerationId} onClick={() => void action('unassign')}>Remove future adoption</Button>
    </div>
    {error && <p role="alert" className="text-ctp-error my-2">{error}</p>}
    <p role="status" aria-live="polite" className="text-xs text-ctp-subtext0">{busy ? 'Loading or saving adoption…' : notice}</p>
    {preview && <div className="space-y-2 my-3">
      <p className="font-medium">{preview.instructionLabel}</p><p className="text-xs text-ctp-subtext0">{preview.ambientContext} Wildcards remain literal.</p>
      <p className="text-xs text-ctp-overlay1">Saved composition revision {preview.compositionRevision}. CLI {preview.cliVersion} advertised the required flags. This does not check sign-in or skill loading.</p>
      <pre data-testid="adoption-delivery-preview" className="whitespace-pre-wrap break-words text-xs font-mono border border-surface-0 rounded-md p-3">{preview.instructions}</pre>
      <p className="text-xs text-ctp-subtext0">Effective selected skill names</p>
      {preview.skillNames.length ? <ul aria-label="Effective selected skill names" className="list-disc pl-5 text-xs">{preview.skillNames.map((name) => <li key={name}>{name}</li>)}</ul> : <p className="text-xs text-ctp-overlay1">No selected skills.</p>}
      <p className="text-xs text-ctp-subtext0">Skill references are not rewritten to these names. Review them before adopting.</p>
      <Button kind="primary" disabled={busy || hasDrafts} onClick={() => void action('adopt')}>Adopt snapshot for next fresh start</Button>
    </div>}
    <SectionHeading title="Retained receipts" />
    {!receipt ? <p className="text-xs text-ctp-subtext0">Receipts have not loaded.</p> : <>
      <p className="text-xs text-ctp-subtext0 mb-2">{receipt.desiredGenerationId ? 'A saved snapshot is selected for the next supported fresh start.' : 'No next-start snapshot is adopted.'} Retained files and history are not removed by unassignment.</p>
      {receipt.generations.map((generation) => <div key={generation.id} className="border-t border-surface-0 py-3 text-xs">
        <p className="font-medium mb-2">Saved composition revision {generation.compositionRevision}</p>
        <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-2">
          <dt className="text-ctp-overlay1">Desired</dt><dd>{receipt.desiredGenerationId === generation.id ? 'Selected for next fresh start' : 'Retained snapshot'}</dd>
          <dt className="text-ctp-overlay1">Prepared</dt><dd>Snapshot retained at {generation.preparedAt}</dd>
          <dt className="text-ctp-overlay1">Materialized</dt><dd>{generation.materializedAt ? `Private generation published at ${generation.materializedAt}` : 'No private generation publication recorded'}</dd>
          <dt className="text-ctp-overlay1">PTY observation</dt><dd>{generation.observations.length ? generation.observations.map((item) => <p key={item.attemptId} className="mb-1">{observationText(item)}</p>) : 'No start intent or process observation recorded'}</dd>
        </dl>
        <p className="text-ctp-subtext0 mt-2">Selected skill names: {generation.skillNames.length ? generation.skillNames.join(', ') : 'None'}</p>
      </div>)}
      {!!receipt.generations.length && <p className="text-xs text-ctp-overlay1">PTY creation observes a shell. Provider execution, instruction loading, skill visibility and sign-in are not established by these receipts.</p>}
    </>}
  </section>;
}
