import type { AssetImpact, AssetOwner, AssetSource, SkillAssetPayload } from './asset-catalog-types';

/** Installation catalog only. No filesystem destinations or delivery policy cross this bridge. */
export interface SkillBundleContext { projectId: string; agentId?: string }
export interface SkillBundleSummary {
  assetId: string;
  name: string;
  revision: number;
  owner: AssetOwner;
  source: AssetSource;
  readOnly: boolean;
}
export interface SkillBundleDocument extends SkillBundleSummary { payload: SkillAssetPayload }
export interface SkillBundleEditRequest {
  context: SkillBundleContext;
  assetId: string;
  expectedRevision: number;
  payload: SkillAssetPayload;
}
export interface SkillBundleEditPreview {
  token: string;
  impact: AssetImpact;
  /** This boundary blocks shared edits until complete consumer context can be reviewed. */
  blocked: boolean;
}
export type SkillBundleErrorCode = 'local_user_only' | 'invalid_request' | 'target_changed'
  | 'not_found' | 'read_only' | 'stale_revision' | 'stale_preview' | 'shared_edit_blocked'
  | 'invalid_payload' | 'save_failed';
export type SkillBundleResult<T> = { ok: true; value: T } | { ok: false; code: SkillBundleErrorCode };
export interface SkillBundleEditorBridge {
  /** Creates a complete, unassigned bundle; main resolves the owner from this scope. */
  create(request: { context: SkillBundleContext; name: string; scope: 'library' | 'project' | 'agent'; payload: SkillAssetPayload }): Promise<SkillBundleResult<SkillBundleDocument>>;
  /** Copies an exact complete revision, unassigned, owned by the context agent. */
  copy(request: { context: SkillBundleContext; assetId: string; expectedRevision: number }): Promise<SkillBundleResult<SkillBundleDocument>>;
  list(context: SkillBundleContext): Promise<SkillBundleResult<SkillBundleSummary[]>>;
  read(context: SkillBundleContext, assetId: string): Promise<SkillBundleResult<SkillBundleDocument>>;
  preview(request: SkillBundleEditRequest): Promise<SkillBundleResult<SkillBundleEditPreview>>;
  /** Saves exactly the complete payload held by preview, never a renderer-supplied patch. */
  save(request: { context: SkillBundleContext; assetId: string; expectedRevision: number; token: string }): Promise<SkillBundleResult<SkillBundleDocument>>;
}
