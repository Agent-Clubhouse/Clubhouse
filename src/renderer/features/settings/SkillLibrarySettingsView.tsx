import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillBundleDocument, SkillBundleEditorBridge, SkillBundleSummary } from '../../../shared/skill-bundle-editor-types';
import { useProjectStore } from '../../stores/projectStore';
import { showConfirmDialog } from '../../plugins/PluginDialog';
import { Button } from '../../components/Button';
import { CatalogSkillBundleEditor } from '../skills/CatalogSkillBundleEditor';
import { SettingsBlock, SettingsField, SettingsPage, SettingsSection, settingsError, settingsHelp, settingsInput } from './SettingsLayout';

/** Mounted across ordinary Settings navigation; memory-only drafts, never recovery authority. */
export function SkillLibrarySettingsView({ visible, bridge = window.clubhouse.catalogSkillBundles }: {
  visible: boolean; bridge?: SkillBundleEditorBridge;
}) {
  const projects = useProjectStore((state) => state.projects);
  const [projectId, setProjectId] = useState('');
  const project = projects.find((item) => item.id === projectId);
  const contextKey = project ? JSON.stringify([project.id, project.path]) : '';
  const [items, setItems] = useState<SkillBundleSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [listTarget, setListTarget] = useState('');
  const [verifiedScope, setVerifiedScope] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listSequence = useRef(0), navigationSequence = useRef(0);
  const dirtyRef = useRef(false), busyRef = useRef(false), loadingRef = useRef(false);
  const editorOperation = useRef(0);
  const selectedRevision = useRef(0);
  const currentContext = useRef(contextKey); currentContext.current = contextKey;
  const scope = JSON.stringify([contextKey, visible]);
  const currentScope = useRef(scope);
  const scopeGeneration = useRef(0);
  if (currentScope.current !== scope) { currentScope.current = scope; scopeGeneration.current++; }
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const itemsRef = useRef(items); itemsRef.current = items;
  const editorKey = JSON.stringify([contextKey, selected, editorEpoch]);
  const currentEditor = useRef(editorKey); currentEditor.current = editorKey;

  useEffect(() => {
    setItems([]); setSelected(null); setListTarget(''); setVerifiedScope(''); setStale(false);
    dirtyRef.current = false; busyRef.current = false; editorOperation.current = 0;
    setDirty(false); setEditorBusy(false);
    if (projectId && !project) setError('The registered project is unavailable. Choose a project again.');
    else setError(null);
    return () => { navigationSequence.current++; listSequence.current++; };
  }, [contextKey]);

  useEffect(() => {
    if (!contextKey) { loadingRef.current = false; setLoading(false); return; }
    const sequence = ++listSequence.current;
    loadingRef.current = true; setLoading(true); setVerifiedScope('');
    const valid = () => listSequence.current === sequence && currentContext.current === contextKey && currentScope.current === scope;
    void (async () => {
      try {
        const result = await bridge.list({ projectId });
        if (!valid()) return;
        if (result.ok === false) { setError('Could not read this catalog scope. Refresh or choose a registered project.'); setStale(true); return; }
        const checkedSelection = listTarget === contextKey ? selected : null;
        const entry = result.value.find((item) => item.assetId === checkedSelection);
        if (checkedSelection && (!entry || entry.revision !== selectedRevision.current)) {
          setStale(true); setError('The selected catalog skill changed or was removed. Refresh the list before editing again.');
        }
        setItems(result.value); setListTarget(contextKey); setVerifiedScope(scope);
      } catch {
        // telemetry-exempt: catalog content and raw IPC errors stay out of logs.
        if (valid()) { setError('Could not read this catalog scope. Try refreshing.'); setStale(true); }
      } finally { if (valid()) { loadingRef.current = false; setLoading(false); } }
    })();
    return () => { listSequence.current++; };
  }, [contextKey, scope, refreshTick, bridge]);

  useEffect(() => {
    const focus = () => { setVerifiedScope(''); setRefreshTick((value) => value + 1); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);

  const discardThen = async (run: () => void) => {
    if (!visibleRef.current || currentContext.current !== contextKey || busyRef.current || loadingRef.current) return;
    const generation = scopeGeneration.current;
    const navigation = ++navigationSequence.current;
    const captured = currentContext.current;
    if (dirtyRef.current) {
      const { promise } = showConfirmDialog('Discard unsaved skill bundle changes?');
      if (!(await promise)) return;
    }
    if (generation !== scopeGeneration.current || !visibleRef.current || navigation !== navigationSequence.current || captured !== currentContext.current || busyRef.current || loadingRef.current) return;
    dirtyRef.current = false; setDirty(false); setStale(false); setError(null);
    run();
  };
  const onDirtyChange = useCallback((value: boolean) => {
    if (currentEditor.current !== editorKey) return;
    dirtyRef.current = value; setDirty(value);
  }, [editorKey]);
  const onBusyChange = useCallback((value: boolean, operation: number) => {
    if (currentEditor.current !== editorKey || operation < editorOperation.current) return;
    if (!value && operation !== editorOperation.current) return;
    editorOperation.current = operation; busyRef.current = value; setEditorBusy(value);
  }, [editorKey]);
  const onSaved = useCallback((document: SkillBundleDocument, operation: number) => {
    if (currentEditor.current !== editorKey || operation !== editorOperation.current || document.assetId !== selected) return;
    listSequence.current++; // An older same-target list must not replace the committed revision.
    loadingRef.current = false; setLoading(false);
    selectedRevision.current = Math.max(selectedRevision.current, document.revision);
    setItems((previous) => previous.map((item) => item.assetId === document.assetId && item.revision <= document.revision ? document : item));
    setVerifiedScope(''); setRefreshTick((value) => value + 1);
  }, [editorKey, selected]);
  const selectAsset = (assetId: string) => {
    if (selected === assetId || busyRef.current || loadingRef.current || listTarget !== contextKey) return;
    void discardThen(() => {
      const item = itemsRef.current.find((entry) => entry.assetId === assetId);
      if (!item) return;
      selectedRevision.current = item.revision; editorOperation.current = 0;
      setSelected(assetId); setEditorEpoch((value) => value + 1);
    });
  };
  const blocked = loading || editorBusy;
  return <SettingsPage title="Skill library" testId="skill-library-settings"
    description="Catalog bundles stored by Clubhouse. Saving here does not assign, enable or run a skill.">
    <SettingsSection title="Catalog scope">
      <SettingsField label="Registered project" htmlFor="skill-library-project" help="Shows library bundles and bundles owned by this project.">
        <select id="skill-library-project" className={settingsInput} value={project ? projectId : ''} disabled={blocked}
          onChange={(event) => {
            const id = event.target.value;
            if (id === projectId || busyRef.current || loadingRef.current) return;
            const target = projects.find((item) => item.id === id);
            void discardThen(() => {
              if (id && !useProjectStore.getState().projects.some((item) => item.id === id && item.path === target?.path)) return;
              setProjectId(id);
            });
          }}>
          <option value="">Choose a project</option>
          {projects.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.name}</option>)}
        </select>
      </SettingsField>
      <SettingsBlock><p className={settingsHelp}>Drafts stay in this page during ordinary navigation. App close or remount discards them.</p></SettingsBlock>
    </SettingsSection>
    {error && <p role="alert" className={settingsError}>{error}</p>}
    {contextKey && <SettingsSection title="Saved bundles" actions={<Button disabled={blocked} onClick={() => {
      void discardThen(() => { setSelected(null); setEditorEpoch((value) => value + 1); setRefreshTick((value) => value + 1); });
    }}>Refresh list{dirty ? ' and discard edits' : ''}</Button>}>
      <SettingsBlock>
        {loading && <p role="status" className={settingsHelp}>Reading catalog...</p>}
        {!loading && listTarget === contextKey && items.length === 0 && <p className={settingsHelp}>No catalog skill bundles in this scope. On-disk skills are separate from this catalog view.</p>}
        <ul aria-label="Catalog skill bundles" className="space-y-1">
          {listTarget === contextKey && items.map((item) => <li key={item.assetId}>
            <button type="button" className="w-full rounded-md border border-surface-1 p-2 text-left text-xs text-ctp-text disabled:opacity-50 hover:bg-surface-0"
              aria-pressed={selected === item.assetId} disabled={blocked} onClick={() => selectAsset(item.assetId)}>
              <span className="block font-medium">{item.name}</span>
              <span className="block text-ctp-subtext0">Source: {item.source.kind}. Owner: {item.owner.kind}. Revision {item.revision}.{item.readOnly ? ' Read-only.' : ''}</span>
            </button>
          </li>)}
        </ul>
      </SettingsBlock>
    </SettingsSection>}
    {contextKey && listTarget === contextKey && selected && <SettingsSection title="Bundle editor">
      <SettingsBlock><CatalogSkillBundleEditor key={editorKey} context={{ projectId }} assetId={selected} bridge={bridge}
        suspended={!visible || verifiedScope !== scope || stale || loading} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} onSaved={onSaved} /></SettingsBlock>
    </SettingsSection>}
  </SettingsPage>;
}
