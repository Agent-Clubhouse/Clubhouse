import type { InstanceEntry, PlannedOperationalDefault, StructureBinding } from './asset-catalog-types';

export interface BuilderBlock {
  key: string;
  entry: InstanceEntry;
  assetId: string;
  revision: number;
  name: string;
  content: string;
  source: string;
  editable: boolean;
}
export interface BuilderView {
  revision: number;
  templateId: string | null;
  templates: Array<{ id: string; name: string }>;
  blocks: BuilderBlock[];
  customOrder: boolean;
  text: string;
  templateBinding?: StructureBinding;
  operationalIncreases?: Array<Pick<PlannedOperationalDefault, 'key' | 'value'>>;
}
export type BuilderCommand =
  | { type: 'template'; templateId: string; confirm: boolean; binding?: StructureBinding; acknowledgeOperationalIncreases?: boolean }
  | { type: 'order'; keys: string[] }
  | { type: 'baseOrder' }
  | { type: 'append'; name: string; content: string }
  | { type: 'fork'; key: string }
  | { type: 'return'; key: string }
  | { type: 'edit'; key: string; content: string }
  | { type: 'remove'; key: string };
export type BuilderResult = { ok: true; view: BuilderView } | { ok: false; code: 'stale' | 'failed' };
