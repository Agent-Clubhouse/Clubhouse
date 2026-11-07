import type { InstanceEntry, PlannedAsset, PlannedOperationalDefault, SkillAssetPayload, StructureBinding } from './asset-catalog-types';

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
export interface BuilderSkill extends PlannedAsset { payload: SkillAssetPayload }
export interface BuilderView {
  skills?: BuilderSkill[];
  excludedSkills?: Array<{ assetId: string; name: string }>;
  /** Desired composition only; never runtime-load evidence. */
  skillFingerprint?: string;
  unsupported?: string[];
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
  | { type: 'skill'; assetId: string; expectedRevision: number; confirm: boolean; fingerprint?: string }
  | { type: 'removeSkill'; assetId: string; confirm: boolean; fingerprint?: string }
  | { type: 'template'; templateId: string; confirm: boolean; binding?: StructureBinding; acknowledgeOperationalIncreases?: boolean }
  | { type: 'order'; keys: string[] }
  | { type: 'baseOrder' }
  | { type: 'append'; name: string; content: string }
  | { type: 'fork'; key: string }
  | { type: 'return'; key: string }
  | { type: 'edit'; key: string; content: string }
  | { type: 'remove'; key: string };
export type BuilderResult = { ok: true; view: BuilderView } | { ok: false; code: 'stale' | 'failed' };
