import { useEffect, useMemo, useRef, useState } from 'react';
import { isMachineFingerprint } from '../../../../shared/agent-address';
import { activeAgentLinks, CONNECTION_SWITCHES, NEW_CONNECTION_DISABLED_TOOLS } from '../../../../shared/connection-grants';
import type { ConnectionDirection } from '../../../../shared/connection-grants';
import type { ConnectionPickerDirectory, ConnectionPickerTarget } from '../../../../shared/connection-picker';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { Toggle } from '../../../components/Toggle';

const starts = () => CONNECTION_SWITCHES.filter((item) => !NEW_CONNECTION_DISABLED_TOOLS.includes(item.tool)).map((item) => item.tool);
const keyOf = (target: ConnectionPickerTarget) => `${target.kind}:${target.id}@${target.machineId ?? ''}`;

export function validateTypedAddress(value: string, directory: ConnectionPickerDirectory): { target?: ConnectionPickerTarget; error?: string } {
  const text = value.trim();
  const at = text.lastIndexOf('@');
  if (at <= 0 || text.indexOf('@') !== at || !isMachineFingerprint(text.slice(at + 1))) return { error: 'Enter an address as agentId@machine, using the machine fingerprint.' };
  const agentId = text.slice(0, at);
  const machine = text.slice(at + 1).toLowerCase();
  if (machine === directory.selfMachineId) {
    const target = directory.targets.find((item) => !item.machineId && item.kind !== 'group-project' && item.id === agentId);
    return target ? { target } : { error: 'No available agent with that id is known on this computer.' };
  }
  const peer = directory.machines.find((item) => item.id === machine);
  if (!peer) return { error: 'That machine is not known to this computer.' };
  if (!peer.network) return { error: 'That machine is not a computer in this Annex Network.' };
  const target = directory.targets.find((item) => item.machineId === machine && item.id === agentId && item.kind !== 'group-project');
  return target ? { target } : { error: 'No agent with that id is known on that computer.' };
}

export function targetConnected(agentId: string, target: ConnectionPickerTarget, bindings: readonly McpBindingEntry[], grants: readonly ConnectionDirection[]): boolean {
  const other = target.machineId ? `${target.id}@${target.machineId}` : target.id;
  if (bindings.some((binding) => (binding.agentId === agentId && binding.targetId === other) || (binding.agentId === other && binding.targetId === agentId))) return true;
  if (target.kind === 'group-project') return false;
  return grants.some((d) => (!!d.link || !!d.cardLink || !!activeAgentLinks(d).length) && ((!d.from.machineId && d.from.agentId === agentId && d.to.agentId === target.id && d.to.machineId === target.machineId)
    || (!d.to.machineId && d.to.agentId === agentId && d.from.agentId === target.id && d.from.machineId === target.machineId)));
}

export function ConnectionPicker({ agentId, agentName, bindings, grants, onClose, onCreated }: {
  agentId: string;
  agentName: string;
  bindings: readonly McpBindingEntry[];
  grants: readonly ConnectionDirection[];
  onClose: () => void;
  onCreated: (target: ConnectionPickerTarget) => void;
}) {
  const [directory, setDirectory] = useState<ConnectionPickerDirectory | null>(null);
  const [query, setQuery] = useState('');
  const [address, setAddress] = useState('');
  const [selected, setSelected] = useState<ConnectionPickerTarget | null>(null);
  const [twoWay, setTwoWay] = useState(true);
  const [allow, setAllow] = useState(starts);
  const [allowBack, setAllowBack] = useState(starts);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    window.clubhouse.mcpBinding.listCardTargets(agentId).then((value) => { if (live) setDirectory(value); }, (cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : 'Could not load targets.'); });
    return () => { live = false; };
  }, [agentId]);
  const sections = useMemo(() => {
    const targets = (directory?.targets ?? []).filter((target) => `${target.name} ${target.project ?? ''} ${target.machineName ?? ''} ${target.id}`.toLowerCase().includes(query.trim().toLowerCase()));
    return [
      { title: 'This computer', targets: targets.filter((t) => t.kind === 'agent' && !t.machineId) },
      { title: 'Other computers', targets: targets.filter((t) => t.kind === 'agent' && !!t.machineId) },
      { title: 'Dispatchers', targets: targets.filter((t) => t.kind === 'dispatcher') },
      { title: 'Group projects', targets: targets.filter((t) => t.kind === 'group-project') },
    ].map((section) => ({ ...section, targets: section.targets.sort((a, b) => `${a.machineName ?? ''} ${a.project ?? ''} ${a.name}`.localeCompare(`${b.machineName ?? ''} ${b.project ?? ''} ${b.name}`)) }));
  }, [directory, query]);
  const groupedTargets = (section: { title: string; targets: ConnectionPickerTarget[] }) => {
    const groups = new Map<string, ConnectionPickerTarget[]>();
    for (const target of section.targets) {
      const label = section.title === 'This computer' ? target.project ?? 'Other agents'
        : section.title === 'Other computers' ? [target.machineName ?? 'Other computer', target.project ?? 'Other agents'].join('\u0000')
          : '';
      groups.set(label, [...(groups.get(label) ?? []), target]);
    }
    return [...groups.entries()];
  };
  const chooseAddress = () => {
    if (!directory) return;
    const result = validateTypedAddress(address, directory);
    if (!result.target) { setError(result.error ?? 'That address is invalid.'); return; }
    if (targetConnected(agentId, result.target, bindings, grants)) { setError('That target is already connected.'); return; }
    setSelected(result.target);
    setError('');
  };
  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await window.clubhouse.mcpBinding.addCardConnection({ agentId, targetId: selected.id, targetKind: selected.kind, ...(selected.machineId && { machineId: selected.machineId }), twoWay, allow, allowBack });
      onCreated(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the connection.');
      setBusy(false);
    }
  };
  const switches = (label: string, selectedTools: string[], setTools: (value: string[]) => void) => (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs font-medium text-ctp-text mb-1">{label}</legend>
      {CONNECTION_SWITCHES.map((item) => <label key={item.tool} className="flex items-center justify-between gap-3 text-xs text-ctp-subtext1">
        <span>{item.label}</span><Toggle aria-label={`${item.label} ${label}`} checked={selectedTools.includes(item.tool)} onChange={(on) => setTools(on ? [...selectedTools, item.tool] : selectedTools.filter((tool) => tool !== item.tool))} />
      </label>)}
    </fieldset>
  );
  return <Modal open onClose={onClose} busy={busy} title="Add connection" width="w-[620px]" testId="connection-picker" initialFocusRef={searchRef}
    footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" disabled={!selected || busy} onClick={() => void save()}>Add connection</Button></>}>
    <label className="flex flex-col gap-1 text-xs text-ctp-subtext1">Search targets
      <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 rounded border border-surface-1 bg-ctp-base px-2 text-ctp-text" />
    </label>
    {!directory && !error && <p className="text-xs text-ctp-subtext1 mt-3">Loading targets...</p>}
    <div className="grid grid-cols-2 gap-4 mt-3">
      <div className="flex flex-col gap-3">
        {sections.map((section) => <section key={section.title} aria-label={section.title}>
          <h3 className="text-xs font-medium text-ctp-text mb-1">{section.title}</h3>
          {section.targets.length === 0 ? <p className="text-xs text-ctp-overlay1">None found</p> : groupedTargets(section).map(([group, targets], index, groups) => <div key={group}>
            {section.title === 'Other computers' ? <>
              {(index === 0 || groups[index - 1][0].split('\u0000')[0] !== group.split('\u0000')[0]) && <h4 className="text-xs text-ctp-subtext1 mt-2 mb-1">{group.split('\u0000')[0]}</h4>}
              <h5 className="text-xs text-ctp-overlay1 ml-2 mb-1">{group.split('\u0000')[1]}</h5>
            </> : group && <h4 className="text-xs text-ctp-subtext1 mt-2 mb-1">{group}</h4>}
            {targets.map((target) => {
            const connected = targetConnected(agentId, target, bindings, grants);
            const detail = [target.machineName, target.project, target.online === false ? 'Offline' : ''].filter(Boolean).join(' / ');
            return <button key={keyOf(target)} type="button" disabled={connected} aria-pressed={selected && keyOf(selected) === keyOf(target) || false} onClick={() => { setSelected(target); setError(''); }}
              className={`w-full text-left rounded px-2 py-1 text-xs text-ctp-text hover:bg-surface-0 disabled:opacity-50 ${target.online === false ? 'opacity-60' : ''}`} data-testid="connection-picker-target">
              <span>{target.name}</span>{detail && <span className="text-ctp-overlay1"> {detail}</span>}{connected && <span className="text-ctp-overlay1"> Connected</span>}
            </button>;
          })}</div>)}
        </section>)}
        <section aria-label="Typed address">
          <h3 className="text-xs font-medium text-ctp-text mb-1">Typed address</h3>
          <label className="flex flex-col gap-1 text-xs text-ctp-subtext1">Agent address
            <input value={address} onChange={(event) => setAddress(event.target.value)} className="h-8 rounded border border-surface-1 bg-ctp-base px-2 text-ctp-text" />
          </label>
          <Button className="mt-1" disabled={!address.trim() || !directory} onClick={chooseAddress}>Use address</Button>
        </section>
      </div>
      <div>
        {!selected ? <p className="text-xs text-ctp-overlay1">Choose a target to set up the connection.</p> : <>
          <p className="text-xs text-ctp-text mb-3">{selected.name}{selected.machineName ? ` on ${selected.machineName}` : ''}</p>
          {selected.kind === 'group-project' ? <p className="text-xs text-ctp-subtext1">{agentName} will join this group project.</p> : <>
            <fieldset className="flex gap-3 text-xs text-ctp-subtext1 mb-3"><legend className="sr-only">Direction</legend>
              <label><input type="radio" name="connection-direction" checked={!twoWay} onChange={() => setTwoWay(false)} /> One way</label>
              <label><input type="radio" name="connection-direction" checked={twoWay} onChange={() => setTwoWay(true)} /> Two way</label>
            </fieldset>
            <div className="flex flex-col gap-4">{switches(`${agentName} to ${selected.name}`, allow, setAllow)}{twoWay && switches(`${selected.name} to ${agentName}`, allowBack, setAllowBack)}</div>
          </>}
        </>}
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-ctp-error mt-3">{error}</p>}
  </Modal>;
}
