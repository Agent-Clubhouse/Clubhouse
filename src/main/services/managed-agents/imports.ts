import { canonicalHash } from '../asset-catalog/planner';
import { nameIssues } from '../asset-catalog/validation';
import { redactSecretValues } from '../../telemetry/diag-redaction';
import type { ManagedPartContent, ManagedPartSummary } from '../../../shared/managed-agents-types';
import type { ManagedAgentsService } from './service';
import { ManagedError } from './service';
import { readDiscoveredManagedAsset, type NativeAssetSource } from './discovery';

export interface ManagedAssetImportRequest {
  candidateId: string;
  mode: 'copy' | 'reuse';
  /** Required for shared reuse; never chosen automatically from matching definitions. */
  partId?: string;
  /** A copy's library name. */
  name?: string;
}

function contentHash(content: ManagedPartContent): string {
  return canonicalHash(content.kind === 'skill' ? { ...content, files: [...content.files].sort((a, b) => a.path.localeCompare(b.path)) } : content);
}

/** Main-only plan. Expose preview, never content or source paths, to tool callers. */
export async function prepareManagedAssetImport(service: ManagedAgentsService, source: NativeAssetSource, request: ManagedAssetImportRequest, projectId: string) {
  if (request.mode !== 'copy' && request.mode !== 'reuse') throw new ManagedError('invalid', 'mode must be copy or reuse.');
  if (request.mode === 'reuse' && (!request.partId || request.name !== undefined)) throw new ManagedError('invalid', 'Shared reuse requires partId and no copy name.');
  if (request.mode === 'copy' && (request.partId !== undefined || !request.name?.trim())) throw new ManagedError('invalid', 'An independent copy requires name and no partId.');
  if (request.name !== undefined && (nameIssues(request.name.trim()).length > 0 || redactSecretValues(request.name) !== request.name)) {
    throw new ManagedError('invalid', 'The copy needs a valid, non-secret library name.');
  }
  const native = await readDiscoveredManagedAsset(source, request.candidateId);
  const hash = contentHash(native.content);
  const matches: ManagedPartSummary[] = [];
  const library = await service.liveEntries();
  for (const entry of Object.values(library)) {
    if (entry.kind !== native.content.kind) continue;
    const part = await service.getPart(entry.id);
    if (!part.retired && contentHash(part.content) === hash) {
      const { content: _content, ...summary } = part;
      matches.push(summary);
    }
  }
  const sourceAfterLibrary = await readDiscoveredManagedAsset(source, request.candidateId);
  if (sourceAfterLibrary.fingerprint !== native.fingerprint) throw new ManagedError('stale', 'The source changed while its library snapshot was read. Preview again; nothing was imported.');
  const shared = request.mode === 'reuse' ? matches.find((p) => p.id === request.partId) : undefined;
  if (request.mode === 'reuse' && !shared) throw new ManagedError('stale', 'The selected library part does not exactly match the discovered asset. Preview again, or import an independent copy.');
  const preview = {
    candidate: native.candidate,
    mode: request.mode,
    name: request.name?.trim(),
    matches: matches.map((p) => ({ id: p.id, name: redactSecretValues(p.name), revision: p.revision, consumers: p.usedBy.length, templates: p.templates.length })),
    ...(shared && { shared: { id: shared.id, revision: shared.revision, consumers: shared.usedBy.length, templates: shared.templates.length } }),
    ...(native.content.kind === 'skill' ? { files: native.content.files.map((f) => ({ path: f.path, encoding: f.encoding ?? 'utf8', executable: !!f.executable })) }
      : { serverKey: native.content.serverKey, transport: native.content.transport, envVars: native.content.envVars ?? [] }),
    droppedEnvValues: native.droppedEnvValues,
    dependencies: 'not_confirmed',
    providerCompatibility: 'not_confirmed',
    providerLoaded: 'not_confirmed',
    note: 'Review supporting files and external dependencies before confirming. Nothing was run. Import does not assign, convert or restart an agent. Reuse follows future shared edits; a copy is independent. Literal environment values are not copied; set them in the external environment.',
  };
  const fingerprint = canonicalHash({ source: native.fingerprint, projectId, request, preview, library, matches });
  return {
    preview,
    fingerprint,
    async commit(actor: string, prepareAuthorization?: () => Promise<() => void>): Promise<ManagedPartSummary> {
      const beforeCommit = async () => {
        // Resolve async targets first; check live grants synchronously after the final source/library read.
        const authorize = await prepareAuthorization?.();
        const current = await prepareManagedAssetImport(service, source, request, projectId);
        if (current.fingerprint !== fingerprint) throw new ManagedError('stale', 'The source or library changed before import committed. Preview again; nothing was imported.');
        authorize?.();
      };
      if (shared) { await beforeCommit(); return shared; }
      return service.createPart({
        name: request.name!.trim(), content: native.content, actor,
        source: { kind: 'import', from: native.content.kind === 'skill' ? 'project-skill' : 'native-mcp', projectId, nativeName: native.candidate.nativeName },
      }, beforeCommit);
    },
  };
}
