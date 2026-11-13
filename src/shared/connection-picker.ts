/** A target offered by the Connections card. Machine ids are Annex fingerprints. */
export interface ConnectionPickerTarget {
  id: string;
  name: string;
  kind: 'agent' | 'dispatcher' | 'group-project';
  project?: string;
  machineId?: string;
  machineName?: string;
  online?: boolean;
}

export interface ConnectionPickerDirectory {
  targets: ConnectionPickerTarget[];
  machines: Array<{ id: string; name: string; network: boolean }>;
  selfMachineId?: string;
}

export interface AddCardConnection {
  agentId: string;
  targetId: string;
  targetKind: ConnectionPickerTarget['kind'];
  machineId?: string;
  twoWay: boolean;
  allow: string[];
  allowBack: string[];
}
