import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  emptyComposition,
  findSharedDestinations,
  hasHardReference,
  listConsumers,
  planComposition,
  previewAssetImpact,
  templateTargetOf,
} from './planner';
import { instanceFromTemplate } from './structure';
import {
  ASSET_CATALOG_VERSION,
  type AgentComposition,
  type AssetProjection,
  type AssetRevisionRecord,
  type BaseAdoption,
  type BlockRef,
  type BundledBy,
  type CatalogEntry,
  type CatalogIndex,
  type CompositionInput,
  type ForeignDestination,
  type InstanceEntry,
  type SubagentRef,
  type TemplateOperationalDefaults,
} from '../../../shared/asset-catalog-types';

const ACCEPTED: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'accepted' } };
const LATEST: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'latest-if-clean' } };
const held = (revisions: Record<string, number>, structure: BaseAdoption['structure'] = { mode: 'accepted' }): BaseAdoption => ({ content: { mode: 'hold', revisions }, structure });

type Revision = AssetProjection | [AssetProjection, BundledBy];

function records(revisions: Revision[], salt: string): AssetRevisionRecord[] {
  return revisions.map((item, position) => {
    const [projection, bundledBy] = Array.isArray(item) ? item : [item, undefined];
    const revision = position + 1;
    return { revision, savedAt: 't', contentHash: canonicalHash([salt, projection, revision]), projection, ...(bundledBy && { bundledBy }) };
  });
}

function entry(id: string, revisions: Revision[], extra: Partial<CatalogEntry> = {}): CatalogEntry {
  const recorded = records(revisions, id);
  return {
    id,
    kind: recorded[0].projection.kind,
    name: id,
    owner: { kind: 'library' },
    source: { kind: 'user' },
    createdAt: 't',
    headRevision: recorded.length,
    revisions: recorded,
    ...extra,
  };
}

const BLOCK: AssetProjection = { kind: 'block', bytes: 10 };
const tagged = (templateId: string, templateRevision: number): Revision => [BLOCK, { templateId, templateRevision }];
const block = (id: string, revisions: Revision[] = [BLOCK], extra: Partial<CatalogEntry> = {}) => entry(id, revisions, extra);
const skill = (id: string, skillName = id): CatalogEntry => entry(id, [{ kind: 'skill', skillName, filePaths: ['SKILL.md'] }]);
const mcp = (id: string, serverKey = id, extra: Partial<Extract<AssetProjection, { kind: 'mcp' }>> = {}): CatalogEntry => entry(id, [{ kind: 'mcp', serverKey, transport: 'stdio', envVars: [], ...extra }]);

const ref = (entryId: string, blockId: string, blockRevision = 1): BlockRef => ({ entryId, blockId, blockRevision });
const subRef = (entryId: string, subagentId: string, subagentRevision = 1): SubagentRef => ({ entryId, subagentId, subagentRevision });

function tmpl(entries: BlockRef[], more: { subagents?: SubagentRef[]; skills?: string[]; mcps?: string[]; operationalDefaults?: TemplateOperationalDefaults } = {}): AssetProjection {
  return { kind: 'template', entries, subagents: more.subagents ?? [], skills: more.skills ?? [], mcps: more.mcps ?? [], ...(more.operationalDefaults && { operationalDefaults: more.operationalDefaults }) };
}

function subagent(agentName: string, more: Partial<Extract<AssetProjection, { kind: 'subagent' }>> = {}): AssetProjection {
  return { kind: 'subagent', agentName, blocks: [], skills: [], mcps: [], providers: ['claude'], reviewFields: [], toolFields: [], ...more };
}

function indexOf(assets: CatalogEntry[], compositions: AgentComposition[] = []): CatalogIndex {
  return {
    version: ASSET_CATALOG_VERSION,
    assets: Object.fromEntries(assets.map((asset) => [asset.id, asset])),
    compositions: Object.fromEntries(compositions.map((composition) => [composition.agentId, composition])),
    runs: {},
  };
}

/** An instance as a new agent would start: following everything at this revision. */
function instanceOf(index: CatalogIndex, templateId: string, revision = 1, over: Partial<CompositionInput> = {}): CompositionInput {
  const projection = index.assets[templateId].revisions.find((record) => record.revision === revision)?.projection;
  if (projection?.kind !== 'template') throw new Error('not a template revision');
  return { ...instanceFromTemplate(templateTargetOf(templateId, revision, projection)), ...over };
}

function stored(agentId: string, composition: CompositionInput): AgentComposition {
  return { ...composition, agentId, revision: 1, updatedAt: 't' };
}

function plan(index: CatalogIndex, composition: CompositionInput, adoption: BaseAdoption = ACCEPTED, foreign?: ForeignDestination[], agentId = 'agent-1', projectId?: string) {
  return planComposition(index, { agentId, ...(projectId && { projectId }), composition, compositionRevision: 0, adoption, foreign });
}

const blockerCodes = (result: ReturnType<typeof plan>) => result.blockers.map((issue) => issue.code);
const noticeCodes = (result: ReturnType<typeof plan>) => result.notices.map((issue) => issue.code);
const blockRevisions = (result: ReturnType<typeof plan>) => result.instructions?.blocks.map((item) => [item.entryKey, item.assetId, item.revision]);

const follow = (baseEntryId: string): InstanceEntry => ({ baseEntryId, source: { kind: 'follow' } });
const local = (localId: string, blockId: string): InstanceEntry => ({ localId, source: { kind: 'local', blockId } });
const owned = (agentId = 'agent-1') => ({ owner: { kind: 'agent' as const, agentId } });

/** Three entries, each with one revision. */
function library(extra: CatalogEntry[] = [], base: CatalogEntry | null = null): CatalogIndex {
  return indexOf([
    block('identity'),
    block('job'),
    block('handoff'),
    skill('review', 'code-review'),
    skill('notes', 'release-notes'),
    mcp('git'),
    mcp('workiq', 'workiq', { auth: 'external', envVars: ['WORKIQ_HOME'] }),
    base ?? entry('base', [tmpl(
      [ref('Identity', 'identity'), ref('Job', 'job'), ref('Handoff', 'handoff')],
      { skills: ['review'], mcps: ['git'], operationalDefaults: { orchestrate: true, control: 'ask-before-start' } },
    )]),
    ...extra,
  ]);
}

describe('resolving', () => {
  it('needs an adoption policy with both tracks: there is no default', () => {
    const request = { agentId: 'a', composition: emptyComposition(), compositionRevision: 0 };
    expect(() => planComposition(library(), request as never)).toThrow('adoption_policy_required');
    expect(() => planComposition(library(), { ...request, adoption: { content: { mode: 'takeable' } } } as never)).toThrow('adoption_policy_required');
    expect(() => planComposition(library(), { ...request, adoption: { mode: 'latest' } } as never)).toThrow('adoption_policy_required');
  });

  it('resolves a template to ordered blocks, skills and MCP, with sources', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base'));
    expect(result.blockers).toEqual([]);
    expect(blockRevisions(result)).toEqual([['base:Identity', 'identity', 1], ['base:Job', 'job', 1], ['base:Handoff', 'handoff', 1]]);
    expect(result.instructions?.blocks.every((item) => item.source === 'follow')).toBe(true);
    expect(result.skills.map((asset) => [asset.assetId, asset.destination.key])).toEqual([['review', 'skills/code-review']]);
    expect(result.mcpServers.map((asset) => [asset.assetId, asset.destination.key])).toEqual([['git', 'mcp/git']]);
  });

  it('every block projects onto one destination without tripping the collision rule', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base'));
    expect(result.instructions?.destination).toEqual({ kind: 'instruction-document', key: 'instructions/primary' });
    expect(result.blockers).toEqual([]);
    expect(result.activation?.instructions?.blocks).toHaveLength(3);
  });

  it('carries operational defaults with their source, and nothing about launch settings', () => {
    const index = library();
    expect(plan(index, instanceOf(index, 'base')).operationalDefaults).toEqual([
      { key: 'orchestrate', value: true, templateId: 'base', templateRevision: 1 },
      { key: 'control', value: 'ask-before-start', templateId: 'base', templateRevision: 1 },
    ]);
  });

  it('leaves unadopted surfaces alone: MCP alone needs no instructions', () => {
    const result = plan(library(), { ...emptyComposition(), additions: ['workiq'] });
    expect(result.blockers).toEqual([]);
    expect(result.instructions).toBeNull();
    expect(result.activation?.instructions).toBeNull();
    expect(result.activation?.assets.map((asset) => asset.assetId)).toEqual(['workiq']);
  });

  it('an empty composition plans to nothing', () => {
    expect(plan(library(), emptyComposition())).toMatchObject({ structure: null, instructions: null, skills: [], mcpServers: [], subagents: [], blockers: [], notices: [] });
  });

  it('one complete document as one block, and a local-only replace-all, are both expressible', () => {
    const single = indexOf([block('doc'), entry('whole', [tmpl([ref('Doc', 'doc')])])]);
    expect(blockRevisions(plan(single, instanceOf(single, 'whole')))).toEqual([['base:Doc', 'doc', 1]]);

    const index = library([block('imported', [BLOCK], owned())]);
    const replaceAll = instanceOf(index, 'base', 1, {
      entries: [local('Imported', 'imported')],
      excludedEntryIds: ['Identity', 'Job', 'Handoff'],
    });
    const result = plan(index, replaceAll);
    expect(result.blockers).toEqual([]);
    expect(blockRevisions(result)).toEqual([['local:Imported', 'imported', 1]]);
    expect(result.excluded.filter((item) => item.kind === 'block').map((item) => item.entryId).sort()).toEqual(['Handoff', 'Identity', 'Job']);
  });
});

describe('the instance decides the order', () => {
  const draggedIndex = () => library([block('rules', [BLOCK], owned())]);

  it('renders the stored order, with local blocks where they were put', () => {
    const index = draggedIndex();
    const result = plan(index, instanceOf(index, 'base', 1, { entries: [follow('Identity'), follow('Handoff'), follow('Job'), local('Rules', 'rules')] }));
    expect(result.blockers).toEqual([]);
    expect(result.instructions?.blocks.map((item) => item.entryKey)).toEqual(['base:Identity', 'base:Handoff', 'base:Job', 'local:Rules']);
    expect(result.activation?.instructions?.blocks.map((item) => [item.assetId, item.source])).toEqual([['identity', 'follow'], ['handoff', 'follow'], ['job', 'follow'], ['rules', 'local']]);
  });

  it('the fingerprint includes order', () => {
    const index = draggedIndex();
    const one = plan(index, instanceOf(index, 'base', 1, { entries: [follow('Identity'), follow('Job'), follow('Handoff')] }));
    const two = plan(index, instanceOf(index, 'base', 1, { entries: [follow('Identity'), follow('Handoff'), follow('Job')] }));
    expect(two.fingerprint).not.toBe(one.fingerprint);
  });

  it('custom order is derived: following isn\'t custom, and neither is a fork', () => {
    const index = library([block('rules', [BLOCK], owned()), block('my-job', [BLOCK], { ...owned(), source: { kind: 'copy', originAssetId: 'job', originRevision: 1 } })]);
    const custom = (over: Partial<CompositionInput>) => plan(index, instanceOf(index, 'base', 1, over)).structure?.customOrder;
    expect(custom({})).toBe(false);
    expect(custom({ entries: [follow('Identity'), { baseEntryId: 'Job', source: { kind: 'fork', blockId: 'my-job', forkedFrom: { assetId: 'job', revision: 1 } } }, follow('Handoff')] })).toBe(false);
    expect(custom({ entries: [follow('Identity'), follow('Handoff'), follow('Job')] })).toBe(true);
    expect(custom({ entries: [...instanceOf(index, 'base').entries, local('Rules', 'rules')] })).toBe(true);
    expect(custom({ entries: [follow('Identity'), follow('Job')], excludedEntryIds: ['Handoff'] })).toBe(true);
  });

  it('an entry the order leaves out blocks: nothing is dropped silently', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { entries: [follow('Identity'), follow('Job')] }));
    expect(result.blockers).toEqual([{ code: 'entry_missing_from_order', assetIds: ['handoff'], entries: ['base:Handoff'] }]);
    expect(result.activation).toBeNull();
  });

  it('an entry the template has never had blocks', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { entries: [...instanceOf(index, 'base').entries, follow('Invented')] }));
    expect(blockerCodes(result)).toEqual(['entry_not_in_template']);
  });

  it('an excluded entry can\'t also be there', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { excludedEntryIds: ['Job'] }));
    expect(blockerCodes(result)).toEqual(['excluded_entry_present']);
  });

  it('counterexample, duplicate source: the same block twice blocks', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, {
      entries: [...instanceOf(index, 'base').entries, { localId: 'Again', source: { kind: 'follow', blockId: 'job' } }],
      floors: { job: 1 },
    }));
    expect(result.blockers).toEqual([{ code: 'duplicate_source', assetIds: ['job'], entries: ['base:Job', 'local:Again'] }]);
  });

  it('identical text in different blocks is a notice only', () => {
    const shared = canonicalHash('same');
    const doc = (id: string) => ({ ...block(id), revisions: [{ revision: 1, savedAt: 't', contentHash: shared, projection: BLOCK }] });
    const index = indexOf([doc('a'), doc('b'), entry('t', [tmpl([ref('A', 'a'), ref('B', 'b')])])]);
    const result = plan(index, instanceOf(index, 't'));
    expect(result.blockers).toEqual([]);
    expect(result.notices).toEqual([{ code: 'identical_text', assetIds: ['a', 'b'] }]);
  });

  it('blocks when the blocks would come to more than can be composed', () => {
    const big: AssetProjection = { kind: 'block', bytes: 1024 * 1024 };
    const index = indexOf([block('a', [big]), block('b', [big]), block('c', [big]), entry('t', [tmpl([ref('A', 'a'), ref('B', 'b'), ref('C', 'c')])])]);
    expect(blockerCodes(plan(index, instanceOf(index, 't')))).toEqual(['instructions_too_large']);
  });

  it('a block\'s name or role decides nothing about policy or access', () => {
    const index = library();
    const plain = plan(index, instanceOf(index, 'base'));
    const renamed = library();
    renamed.assets.job = { ...renamed.assets.job, name: 'Orchestrator with bypass access' };
    const result = plan(renamed, instanceOf(renamed, 'base'));
    expect(result.operationalDefaults).toEqual(plain.operationalDefaults);
    expect(result.fingerprint).toBe(plain.fingerprint);
    expect(result.activation?.instructions).toEqual(plain.activation?.instructions);
    expect(result.instructions?.blocks[1].name).toBe('Orchestrator with bypass access');
  });

  it('each block carries its source, revision, hash and size, and that\'s all it has to say about text', () => {
    const index = library();
    expect(Object.keys(plan(index, instanceOf(index, 'base')).activation?.instructions?.blocks[0] ?? {}).sort()).toEqual(['assetId', 'contentHash', 'entryKey', 'revision', 'source']);
    expect(plan(index, instanceOf(index, 'base')).instructions?.blocks[0].bytes).toBe(10);
  });
});

describe('the bundled safety rule move', () => {
  // T1 is [Identity, Job r5]. Publishing T2 moves rules from Job into new Safety: [Identity, Safety r1, Job r6].
  const moved = (more: { jobAfter?: Revision[]; identityAfter?: Revision[] } = {}) => indexOf([
    block('identity', [BLOCK, BLOCK, ...(more.identityAfter ?? [])]),
    block('job', [BLOCK, BLOCK, BLOCK, BLOCK, BLOCK, tagged('t', 2), ...(more.jobAfter ?? [])]),
    block('safety', [tagged('t', 2)]),
    block('rules', [BLOCK], owned()),
    entry('t', [
      tmpl([ref('Identity', 'identity', 2), ref('Job', 'job', 5)]),
      tmpl([ref('Identity', 'identity', 2), ref('Safety', 'safety', 1), ref('Job', 'job', 6)]),
    ]),
  ]);
  /** Rules sits in the gap Safety would go in, so T2 needs a choice here. */
  const custom = (index: CatalogIndex): CompositionInput => instanceOf(index, 't', 1, { entries: [follow('Identity'), local('Rules', 'rules'), follow('Job')] });

  it('a follower on latest-if-clean takes T2 whole: rules present before and after', () => {
    const index = moved();
    const result = plan(index, instanceOf(index, 't'), LATEST);
    expect(result.blockers).toEqual([]);
    expect(blockRevisions(result)).toEqual([['base:Identity', 'identity', 2], ['base:Safety', 'safety', 1], ['base:Job', 'job', 6]]);
    expect(result.structure).toMatchObject({ acceptedRevision: 1, resolvedRevision: 2, latestRevision: 2 });
  });

  it('a follower on accepted stays whole on T1, and says T2 is available', () => {
    const index = moved();
    const result = plan(index, instanceOf(index, 't'));
    expect(blockRevisions(result)).toEqual([['base:Identity', 'identity', 2], ['base:Job', 'job', 5]]);
    expect(result.structure).toMatchObject({ acceptedRevision: 1, resolvedRevision: 1, latestRevision: 2, update: { status: 'clean', targetRevision: 2 } });
  });

  it('an instance whose T2 needs a choice stays on Job r5, without Safety: rules never disappear', () => {
    const index = moved();
    const result = plan(index, custom(index), LATEST);
    expect(result.blockers).toEqual([]);
    expect(blockRevisions(result)).toEqual([['base:Identity', 'identity', 2], ['local:Rules', 'rules', 1], ['base:Job', 'job', 5]]);
    expect(result.structure).toMatchObject({ acceptedRevision: 1, resolvedRevision: 1, latestRevision: 2, update: { status: 'needs-choice', targetRevision: 2 } });
    expect(noticeCodes(result)).toContain('structure_update_waiting');
  });

  it('says what the update is held with, and that accepting the template brings it', () => {
    const index = moved();
    const job = plan(index, custom(index), LATEST).instructions?.blocks.find((item) => item.assetId === 'job');
    expect(job).toMatchObject({ revision: 5, floor: 5, takeableRevision: 5, headRevision: 6 });
    expect(job?.update).toEqual({
      range: { from: 5, to: 6 },
      heldBy: { templateId: 't', templateRevision: 2 },
      resolution: 'accept-template',
      missingCompanions: ['safety'],
      kept: false,
    });
  });

  it('then an independent Identity r3 flows, held by nothing', () => {
    const index = moved({ identityAfter: [BLOCK] });
    const result = plan(index, custom(index), LATEST);
    expect(result.instructions?.blocks.find((item) => item.assetId === 'identity')).toMatchObject({ revision: 3, update: null });
  });

  it('then an independent Job r7 built on r6 waits with T2, by the chain rule', () => {
    const index = moved({ jobAfter: [BLOCK] });
    const job = plan(index, custom(index), LATEST).instructions?.blocks.find((item) => item.assetId === 'job');
    expect(job).toMatchObject({ revision: 5, takeableRevision: 5, headRevision: 7, update: { heldBy: { templateId: 't', templateRevision: 2 } } });
  });

  it('accepting T2 moves the floor past the tag, and r7 flows', () => {
    const index = moved({ jobAfter: [BLOCK] });
    const job = plan(index, instanceOf(index, 't', 2)).instructions?.blocks.find((item) => item.assetId === 'job');
    expect(job).toMatchObject({ revision: 7, floor: 6, update: null });
  });

  it('never claims the whole base adopted while structure waits', () => {
    const index = moved();
    const result = plan(index, custom(index), LATEST);
    expect(result.activation?.structure).toEqual({ templateId: 't', acceptedRevision: 1, resolvedRevision: 1, latestRevision: 2, updateWaiting: true });
  });

  it('an unresolved structure question never stops a start', () => {
    const index = moved();
    expect(plan(index, custom(index), LATEST).activation).not.toBeNull();
    expect(plan(index, custom(index), ACCEPTED).activation).not.toBeNull();
  });

  it('skipping T2 for T3 absorbs its tags directly', () => {
    const index = indexOf([
      block('job', [BLOCK, tagged('t', 2), tagged('t', 3), BLOCK]),
      entry('t', [tmpl([ref('Job', 'job', 1)]), tmpl([ref('Job', 'job', 2)]), tmpl([ref('Job', 'job', 3)])]),
    ]);
    const result = plan(index, instanceOf(index, 't'), LATEST);
    expect(result.structure).toMatchObject({ acceptedRevision: 1, resolvedRevision: 3, latestRevision: 3 });
    expect(result.instructions?.blocks[0]).toMatchObject({ revision: 4, floor: 3, update: null });
  });

  it('republishing a ref adds no tag, so nothing is held', () => {
    const index = indexOf([
      block('job', [BLOCK, BLOCK]),
      entry('t', [tmpl([ref('Job', 'job', 1)]), tmpl([ref('Job', 'job', 2)])]),
    ]);
    expect(plan(index, instanceOf(index, 't')).instructions?.blocks[0]).toMatchObject({ revision: 2, floor: 1, update: null });
  });
});

describe('consumers of a bundled block who aren\'t on that template', () => {
  const bundled = () => indexOf([
    block('job', [BLOCK, tagged('t', 2), BLOCK]),
    block('safety', [tagged('t', 2)]),
    entry('t', [tmpl([ref('Job', 'job', 1)]), tmpl([ref('Safety', 'safety', 1), ref('Job', 'job', 2)])]),
    entry('other', [tmpl([ref('Job', 'job', 1)])]),
  ]);

  it('another template\'s follower sees it waiting, with the companions it would miss', () => {
    const index = bundled();
    const job = plan(index, instanceOf(index, 'other')).instructions?.blocks[0];
    expect(job).toMatchObject({ revision: 1, floor: 1, takeableRevision: 1, headRevision: 3 });
    expect(job?.update).toEqual({
      range: { from: 1, to: 3 },
      heldBy: { templateId: 't', templateRevision: 2 },
      resolution: 'explicit',
      missingCompanions: ['safety'],
      kept: false,
    });
    expect(noticeCodes(plan(index, instanceOf(index, 'other')))).toContain('content_update_waiting');
  });

  it('is never stuck: an explicit Apply sets the floor and moves on', () => {
    const index = bundled();
    const result = plan(index, instanceOf(index, 'other', 1, { floors: { job: 2 } }));
    expect(result.blockers).toEqual([]);
    expect(result.instructions?.blocks[0]).toMatchObject({ revision: 3, floor: 2, update: null });
  });

  it('Keep goes quiet, and speaks again when something newer exists', () => {
    const index = bundled();
    const kept = plan(index, instanceOf(index, 'other', 1, { keepMarkers: { job: 3 } }));
    expect(kept.instructions?.blocks[0]).toMatchObject({ revision: 1, update: { kept: true } });
    expect(noticeCodes(kept)).not.toContain('content_update_waiting');

    const later = indexOf([...Object.values(bundled().assets).filter((asset) => asset.id !== 'job'), block('job', [BLOCK, tagged('t', 2), BLOCK, BLOCK])]);
    const woken = plan(later, instanceOf(later, 'other', 1, { keepMarkers: { job: 3 } }));
    expect(woken.instructions?.blocks[0].update?.kept).toBe(false);
    expect(noticeCodes(woken)).toContain('content_update_waiting');
  });

  it('Keep changes nothing but the noise', () => {
    const index = bundled();
    const kept = plan(index, instanceOf(index, 'other', 1, { keepMarkers: { job: 3 } }));
    expect(blockRevisions(kept)).toEqual(blockRevisions(plan(index, instanceOf(index, 'other'))));
  });

  it('a direct consumer is the same, once it has a floor', () => {
    const index = bundled();
    const direct = { ...emptyComposition(), entries: [{ localId: 'Mine', source: { kind: 'follow' as const, blockId: 'job' } }], floors: { job: 1 } };
    const result = plan(index, direct);
    expect(result.blockers).toEqual([]);
    expect(result.instructions?.blocks[0]).toMatchObject({ source: 'follow', revision: 1, update: { resolution: 'explicit', heldBy: { templateId: 't' } } });
  });

  it('a direct consumer with no floor blocks rather than guessing where it started', () => {
    const index = bundled();
    const direct = { ...emptyComposition(), entries: [{ localId: 'Mine', source: { kind: 'follow' as const, blockId: 'job' } }] };
    expect(blockerCodes(plan(index, direct))).toEqual(['missing_floor']);
  });

  it('an Apply can\'t jump this instance\'s own template: that takes accepting it', () => {
    const index = bundled();
    const result = plan(index, instanceOf(index, 't', 1, { floors: { job: 2 } }));
    expect(blockerCodes(result)).toEqual(['floor_bypasses_template']);
  });

  it('a floor below the template\'s reference doesn\'t lower it', () => {
    const index = indexOf([block('job', [BLOCK, BLOCK, BLOCK, tagged('u', 1)]), entry('t', [tmpl([ref('Job', 'job', 3)])])]);
    expect(plan(index, instanceOf(index, 't', 1, { floors: { job: 1 } })).instructions?.blocks[0]).toMatchObject({ floor: 3, revision: 3 });
  });
});

describe('forks and local blocks', () => {
  const copyOf = (originRevision: number, agentId = 'agent-1') => ({ owner: { kind: 'agent' as const, agentId }, source: { kind: 'copy' as const, originAssetId: 'job', originRevision } });
  const forked = (forkedRevision = 1): InstanceEntry => ({ baseEntryId: 'Job', source: { kind: 'fork', blockId: 'my-job', forkedFrom: { assetId: 'job', revision: forkedRevision } } });

  it('a fork keeps its slot and its base entry id, and others stay linked', () => {
    const index = library([block('my-job', [BLOCK], copyOf(1))]);
    const result = plan(index, instanceOf(index, 'base', 1, { entries: [follow('Identity'), forked(), follow('Handoff')] }));
    expect(result.blockers).toEqual([]);
    expect(blockRevisions(result)).toEqual([['base:Identity', 'identity', 1], ['base:Job', 'my-job', 1], ['base:Handoff', 'handoff', 1]]);
    expect(result.instructions?.blocks[1]).toMatchObject({ source: 'fork', forkedFrom: { assetId: 'job', revision: 1 } });
    expect(result.instructions?.blocks.map((item) => item.source)).toEqual(['follow', 'fork', 'follow']);
  });

  it('a fork follows its own latest, and reports a newer origin without changing', () => {
    const index = indexOf([
      block('identity'),
      block('job', [BLOCK, BLOCK]),
      block('handoff'),
      block('my-job', [BLOCK, BLOCK], copyOf(1)),
      entry('base', [tmpl([ref('Identity', 'identity'), ref('Job', 'job'), ref('Handoff', 'handoff')])]),
    ]);
    const before = JSON.stringify(index);
    const result = plan(index, instanceOf(index, 'base', 1, { entries: [follow('Identity'), forked(), follow('Handoff')] }));
    expect(result.instructions?.blocks[1]).toMatchObject({
      assetId: 'my-job',
      revision: 2,
      origin: { originAssetId: 'job', originRevision: 1, originHeadRevision: 2, newerRevisionAvailable: true, originDeleted: false },
    });
    expect(result.notices).toEqual([{ code: 'origin_newer_revision', assetIds: ['my-job'] }]);
    expect(JSON.stringify(index)).toBe(before);
  });

  it('Keep on the origin quiets that too', () => {
    const index = indexOf([block('job', [BLOCK, BLOCK]), block('my-job', [BLOCK], copyOf(1)), entry('base', [tmpl([ref('Job', 'job')])])]);
    const result = plan(index, instanceOf(index, 'base', 1, { entries: [forked()], keepMarkers: { job: 2 } }));
    expect(noticeCodes(result)).toEqual([]);
  });

  it('says nothing when the origin has not moved, and keeps working when it\'s deleted', () => {
    const still = indexOf([block('job'), block('my-job', [BLOCK], copyOf(1)), entry('base', [tmpl([ref('Job', 'job')])])]);
    expect(plan(still, instanceOf(still, 'base', 1, { entries: [forked()] })).notices).toEqual([]);

    const gone = indexOf([block('job', [BLOCK], { deletedAt: 't' }), block('my-job', [BLOCK], copyOf(1))]);
    const result = plan(gone, { ...emptyComposition(), entries: [{ localId: 'Mine', source: { kind: 'fork', blockId: 'my-job', forkedFrom: { assetId: 'job', revision: 1 } } }] });
    expect(result.blockers).toEqual([]);
    expect(result.notices).toEqual([{ code: 'origin_deleted', assetIds: ['my-job'] }]);
  });

  it('blocks a fork that doesn\'t match what it claims to come from', () => {
    const index = library([block('my-job', [BLOCK], copyOf(1))]);
    const result = plan(index, instanceOf(index, 'base', 1, { entries: [follow('Identity'), forked(9), follow('Handoff')] }));
    expect(blockerCodes(result)).toEqual(['fork_origin_mismatch']);
  });

  it('blocks another agent\'s fork or local block', () => {
    const index = library([block('theirs', [BLOCK], owned('agent-2'))]);
    const result = plan(index, { ...emptyComposition(), entries: [local('Theirs', 'theirs')] });
    expect(blockerCodes(result)).toEqual(['owner_mismatch']);
    expect(plan(index, { ...emptyComposition(), entries: [local('Theirs', 'theirs')] }, ACCEPTED, undefined, 'agent-2').blockers).toEqual([]);
  });

  it('a local entry can\'t be a shared block: that\'s a follow', () => {
    const index = library();
    expect(blockerCodes(plan(index, { ...emptyComposition(), entries: [local('Oops', 'job')] }))).toEqual(['owner_mismatch']);
  });

  it('a project-owned block is representable, and which project an agent is under is a parameter', () => {
    const index = library([block('project-rules', [BLOCK], { owner: { kind: 'project', projectId: 'p1' } })]);
    const composition = { ...emptyComposition(), entries: [local('Rules', 'project-rules')] };
    expect(plan(index, composition, ACCEPTED, undefined, 'agent-1', 'p1').blockers).toEqual([]);
    expect(blockerCodes(plan(index, composition, ACCEPTED, undefined, 'agent-1', 'p2'))).toEqual(['owner_mismatch']);
    expect(blockerCodes(plan(index, composition))).toEqual(['owner_mismatch']);
  });
});

describe('content adoption', () => {
  const moved = () => indexOf([
    block('doc', [BLOCK, BLOCK, BLOCK, tagged('t', 2)]),
    skill('review'),
    entry('t', [tmpl([ref('Doc', 'doc', 1)], { skills: ['review'] }), tmpl([ref('Doc', 'doc', 4)], { skills: ['review'] })]),
  ]);

  it('takeable resolves the highest it can reach', () => {
    const index = moved();
    expect(plan(index, instanceOf(index, 't')).instructions?.blocks[0].revision).toBe(3);
  });

  it('hold resolves exactly what was held, and reports what\'s newer', () => {
    const index = moved();
    const result = plan(index, instanceOf(index, 't'), held({ doc: 2, review: 1 }));
    expect(result.adoption).toEqual({ content: 'hold', structure: 'accepted' });
    expect(result.instructions?.blocks[0]).toMatchObject({ revision: 2, floor: 1, takeableRevision: 3, update: { range: { from: 1, to: 4 } } });
    expect(result.blockers).toEqual([]);
  });

  it('a hold that leaves something out blocks rather than guessing', () => {
    const index = moved();
    expect(blockerCodes(plan(index, instanceOf(index, 't'), held({ review: 1 })))).toEqual(['hold_incomplete']);
    expect(blockerCodes(plan(index, instanceOf(index, 't'), held({ doc: 2 })))).toEqual(['hold_incomplete']);
  });

  it('a hold below a floor blocks: it would bring back what a template moved out', () => {
    const index = moved();
    expect(blockerCodes(plan(index, instanceOf(index, 't', 2), held({ doc: 3, review: 1 })))).toEqual(['hold_below_floor']);
  });

  it('a hold past a bundle blocks: no intermediate adoption', () => {
    const index = moved();
    expect(blockerCodes(plan(index, instanceOf(index, 't'), held({ doc: 4, review: 1 })))).toEqual(['hold_past_bundle']);
  });

  it('a hold on a revision no longer kept blocks', () => {
    const index = indexOf([block('doc', [BLOCK, BLOCK]), skill('review'), entry('t', [tmpl([ref('Doc', 'doc', 1)], { skills: ['review'] })])]);
    index.assets.review = { ...index.assets.review, headRevision: 3 };
    expect(blockerCodes(plan(index, instanceOf(index, 't'), held({ doc: 1, review: 3 })))).toEqual(['revision_unavailable']);
  });
});

describe('a hold is honoured for everything planned', () => {
  const sub = () => entry('s', [subagent('s', { blocks: [ref('Role', 'role')], skills: ['review'], mcps: ['git'] })]);
  const all = () => indexOf([
    block('a'), block('role'), skill('review', 'code-review'), mcp('git'), skill('notes', 'release-notes'),
    block('mine', [BLOCK, BLOCK], owned()),
    sub(),
    entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('S', 's')] })]),
  ]);
  const composition = (index: CatalogIndex) => instanceOf(index, 't', 1, { additions: ['notes'], entries: [follow('A'), local('Mine', 'mine')] });
  const complete = { a: 1, role: 1, review: 1, git: 1, notes: 1, mine: 1, s: 1 };

  it('resolves additions, subagent refs and own blocks exactly as held', () => {
    const index = all();
    index.assets.notes = { ...entry('notes', [{ kind: 'skill', skillName: 'release-notes', filePaths: [] }, { kind: 'skill', skillName: 'release-notes', filePaths: [] }]) };
    index.assets.review = { ...entry('review', [{ kind: 'skill', skillName: 'code-review', filePaths: [] }, { kind: 'skill', skillName: 'code-review', filePaths: [] }]) };
    const result = plan(index, composition(index), held(complete));
    expect(result.blockers).toEqual([]);
    expect(result.skills[0]).toMatchObject({ assetId: 'notes', revision: 1 });
    expect(result.subagents[0].skills).toEqual([expect.objectContaining({ assetId: 'review', revision: 1 })]);
    expect(result.instructions?.blocks[1]).toMatchObject({ assetId: 'mine', revision: 1 });
  });

  it.each(Object.keys(complete))('leaving out %s blocks', (assetId) => {
    const index = all();
    const { [assetId as keyof typeof complete]: _left, ...rest } = complete;
    expect(blockerCodes(plan(index, composition(index), held(rest)))).toContain('hold_incomplete');
  });

  it('a held revision that isn\'t there blocks', () => {
    const index = all();
    expect(blockerCodes(plan(index, composition(index), held({ ...complete, notes: 9 })))).toContain('revision_unavailable');
  });
});

describe('floors and keep markers name revisions that exist', () => {
  it('a floor or keep past the head blocks: it would skip to, or go quiet about, what comes later', () => {
    const index = library();
    expect(blockerCodes(plan(index, instanceOf(index, 'base', 1, { floors: { job: 9 } })))).toContain('revision_unavailable');
    expect(blockerCodes(plan(index, instanceOf(index, 'base', 1, { keepMarkers: { job: 9 } })))).toEqual(['revision_unavailable']);
    expect(plan(index, instanceOf(index, 'base', 1, { keepMarkers: { job: 1 } })).blockers).toEqual([]);
  });
});

describe('structure adoption', () => {
  const twoRevisions = () => indexOf([
    block('a'), block('b'), block('new'), block('rules', [BLOCK], owned()),
    entry('t', [tmpl([ref('A', 'a'), ref('B', 'b')]), tmpl([ref('A', 'a'), ref('New', 'new'), ref('B', 'b')])]),
  ]);

  it('accepted stays, even when the update is clean, and says so', () => {
    const index = twoRevisions();
    const result = plan(index, instanceOf(index, 't'));
    expect(result.structure).toMatchObject({ resolvedRevision: 1, update: { status: 'clean', targetRevision: 2 } });
    expect(result.activation?.structure?.updateWaiting).toBe(true);
    expect(noticeCodes(result)).toContain('structure_update_waiting');
  });

  it('latest-if-clean resolves it for this plan, and stores nothing', () => {
    const index = twoRevisions();
    const composition = instanceOf(index, 't');
    const before = JSON.stringify(composition);
    const result = plan(index, composition, LATEST);
    expect(result.instructions?.blocks.map((item) => item.assetId)).toEqual(['a', 'new', 'b']);
    expect(result.structure).toMatchObject({ acceptedRevision: 1, resolvedRevision: 2 });
    expect(result.activation?.structure?.updateWaiting).toBe(false);
    expect(JSON.stringify(composition)).toBe(before);
  });

  it('is current when nothing newer exists', () => {
    const index = twoRevisions();
    expect(plan(index, instanceOf(index, 't', 2)).structure?.update).toEqual({ status: 'current', targetRevision: 2, reasons: [], subagentReasons: [], operationalIncreases: [], blockers: [] });
  });

  it('a new revision whose skill would collide isn\'t clean, and doesn\'t stop this start', () => {
    const index = indexOf([
      block('a'), skill('one', 'same'), skill('two', 'same'),
      entry('t', [tmpl([ref('A', 'a')], { skills: ['one'] }), tmpl([ref('A', 'a')], { skills: ['one', 'two'] })]),
    ]);
    const result = plan(index, instanceOf(index, 't'), LATEST);
    expect(result.blockers).toEqual([]);
    expect(result.structure).toMatchObject({ resolvedRevision: 1, update: { status: 'needs-choice' } });
    expect(result.structure?.update.blockers.map((issue) => issue.code)).toEqual(['destination_collision']);
    expect(result.activation).not.toBeNull();
  });

  describe('a revision raising operational authority', () => {
    const raising = (from: TemplateOperationalDefaults, to: TemplateOperationalDefaults) => indexOf([
      block('a'),
      entry('t', [tmpl([ref('A', 'a')], { operationalDefaults: from }), tmpl([ref('A', 'a')], { operationalDefaults: to })]),
    ]);

    it('is never clean: it stays on what was accepted, and says what it would raise', () => {
      const index = raising({ agentAccess: 'standard' }, { agentAccess: 'bypass', orchestrate: true });
      const result = plan(index, instanceOf(index, 't'), LATEST);
      expect(result.structure).toMatchObject({
        acceptedRevision: 1,
        resolvedRevision: 1,
        update: { status: 'needs-choice', targetRevision: 2, operationalIncreases: ['agentAccess', 'orchestrate'], reasons: [] },
      });
      expect(result.operationalDefaults.map((item) => [item.key, item.value])).toEqual([['agentAccess', 'standard']]);
      expect(result.blockers).toEqual([]);
      expect(noticeCodes(result)).toContain('structure_update_waiting');
      expect(result.activation?.structure?.updateWaiting).toBe(true);
    });

    it('a decrease stays clean', () => {
      const index = raising({ agentAccess: 'bypass', orchestrate: true }, { agentAccess: 'standard' });
      const result = plan(index, instanceOf(index, 't'), LATEST);
      expect(result.structure).toMatchObject({ resolvedRevision: 2, update: { status: 'clean', operationalIncreases: [] } });
      expect(result.operationalDefaults.map((item) => [item.key, item.value])).toEqual([['agentAccess', 'standard']]);
    });
  });

  it('counterexample, re-add of an excluded id: stays excluded, with a notice', () => {
    const index = indexOf([
      block('identity'), block('job'), block('handoff'),
      entry('t', [
        tmpl([ref('Identity', 'identity'), ref('Job', 'job')]),
        tmpl([ref('Identity', 'identity'), ref('Job', 'job'), ref('Handoff', 'handoff')]),
      ]),
    ]);
    const result = plan(index, instanceOf(index, 't', 1, { excludedEntryIds: ['Handoff'] }), LATEST);
    expect(result.blockers).toEqual([]);
    expect(result.instructions?.blocks.map((item) => item.assetId)).toEqual(['identity', 'job']);
    expect(result.notices).toContainEqual({ code: 'excluded_entry_readded', assetIds: ['handoff'], entries: ['base:Handoff'] });
  });

  it('counterexample, fork keeps slot through a clean update', () => {
    const index = indexOf([
      block('identity'), block('job'), block('safety'),
      block('my-job', [BLOCK], { ...owned(), source: { kind: 'copy', originAssetId: 'job', originRevision: 1 } }),
      entry('t', [
        tmpl([ref('Identity', 'identity'), ref('Job', 'job')]),
        tmpl([ref('Identity', 'identity'), ref('Safety', 'safety'), ref('Job', 'job')]),
      ]),
    ]);
    const composition = instanceOf(index, 't', 1, { entries: [follow('Identity'), { baseEntryId: 'Job', source: { kind: 'fork', blockId: 'my-job', forkedFrom: { assetId: 'job', revision: 1 } } }] });
    const result = plan(index, composition, LATEST);
    expect(blockRevisions(result)).toEqual([['base:Identity', 'identity', 1], ['base:Safety', 'safety', 1], ['base:Job', 'my-job', 1]]);
  });

  it('counterexample, one clean plus one conflict: all of it waits', () => {
    const index = indexOf([
      block('a'), block('b'), block('clean'), block('late'), block('rules', [BLOCK], owned()),
      entry('t', [
        tmpl([ref('A', 'a'), ref('B', 'b')]),
        tmpl([ref('A', 'a'), ref('Clean', 'clean'), ref('B', 'b'), ref('Late', 'late')]),
      ]),
    ]);
    const result = plan(index, instanceOf(index, 't', 1, { entries: [follow('A'), follow('B'), local('Rules', 'rules')] }), LATEST);
    expect(result.instructions?.blocks.map((item) => item.assetId)).toEqual(['a', 'b', 'rules']);
    expect(result.structure).toMatchObject({ resolvedRevision: 1, update: { status: 'needs-choice' } });
  });
});

describe('skills and MCP', () => {
  it('adds on top of a base, with provenance', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { additions: ['notes', 'workiq'] }));
    expect(result.skills.map((asset) => asset.assetId)).toEqual(['review', 'notes']);
    expect(result.mcpServers.map((asset) => asset.assetId)).toEqual(['git', 'workiq']);
    expect(result.mcpServers[1].provenance).toEqual([{ via: 'addition' }]);
  });

  it('follows the latest approved revision', () => {
    const versioned = entry('versioned', [{ kind: 'skill', skillName: 'v', filePaths: [] }, { kind: 'skill', skillName: 'v', filePaths: [] }]);
    expect(plan(library([versioned]), { ...emptyComposition(), additions: ['versioned'] }).skills[0]).toMatchObject({ revision: 2, headRevision: 2 });
  });

  it('removes what the base carries and shows the exclusion', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { removals: ['review', 'git'] }));
    expect(result.skills).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.excluded.filter((item) => item.kind !== 'block')).toEqual([{ kind: 'mcp', assetId: 'git' }, { kind: 'skill', assetId: 'review' }]);
  });

  it('a removal that names nothing in the base is reported, not silently dropped', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { removals: ['notes'] }));
    expect(result.blockers).toEqual([]);
    expect(result.notices).toEqual([{ code: 'inert_removal', assetIds: ['notes'] }]);
  });

  it('adding and removing one asset is a contradiction, not last-write-wins', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { additions: ['review'], removals: ['review'] }));
    expect(blockerCodes(result)).toContain('contradictory_override');
    expect(result.activation).toBeNull();
  });

  it('rejects kinds that make no sense as an override', () => {
    expect(blockerCodes(plan(library(), { ...emptyComposition(), additions: ['job'] }))).toEqual(['invalid_addition_kind']);
    expect(blockerCodes(plan(library(), { ...emptyComposition(), additions: ['base'] }))).toEqual(['invalid_addition_kind']);
    expect(blockerCodes(plan(library(), { ...emptyComposition(), removals: ['job'] }))).toEqual(['invalid_removal_kind']);
  });

  it('distinct owners on one destination block, naming both, by case too', () => {
    const index = library([mcp('git-2', 'GIT')]);
    expect(plan(index, instanceOf(index, 'base', 1, { additions: ['git-2'] })).blockers).toEqual([
      { code: 'destination_collision', assetIds: ['git', 'git-2'], destination: 'mcp/git' },
    ]);
  });

  it('a copy beside its origin collides too: the user removes one', () => {
    const copy = { ...skill('review-copy', 'code-review'), ...owned(), source: { kind: 'copy' as const, originAssetId: 'review', originRevision: 1 } };
    const index = library([copy]);
    expect(blockerCodes(plan(index, instanceOf(index, 'base', 1, { additions: ['review-copy'] })))).toEqual(['destination_collision']);
    expect(plan(index, instanceOf(index, 'base', 1, { additions: ['review-copy'], removals: ['review'] })).blockers).toEqual([]);
  });

  it('identical references deduplicate and keep every provenance', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { additions: ['review'] }));
    expect(result.blockers).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].provenance).toEqual([{ via: 'addition' }, { via: 'base', templateId: 'base', templateRevision: 1 }]);
  });

  it('a destination held by a native file or plugin blocks, without touching it', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base'), ACCEPTED, [{ key: 'MCP/git', owner: 'native' }, { key: 'skills/other', owner: 'plugin' }]);
    expect(result.blockers).toEqual([{ code: 'foreign_destination_collision', assetIds: ['git'], destination: 'mcp/git', foreignOwner: 'native' }]);
  });

  it('upstream versions stay separate from catalog revisions', () => {
    const projection: AssetProjection = { kind: 'mcp', serverKey: 'workiq', transport: 'stdio', envVars: [], upstream: { package: '@microsoft/workiq', floating: true } };
    const result = plan(indexOf([entry('w', [projection])]), { ...emptyComposition(), additions: ['w'] });
    expect(result.mcpServers[0].revision).toBe(1);
    expect(result.mcpServers[0].projection).toMatchObject({ upstream: { package: '@microsoft/workiq', floating: true } });
  });
});

describe('invalid references', () => {
  it.each([
    ['a missing template', { template: { templateId: 'nope', acceptedRevision: 1 } }, 'asset_missing'],
    ['a template that isn\'t one', { template: { templateId: 'job', acceptedRevision: 1 } }, 'wrong_kind'],
    ['a missing addition', { additions: ['nope'] }, 'asset_missing'],
    ['an object-key trap', { additions: ['constructor'] }, 'asset_missing'],
  ])('blocks %s', (_label, over, code) => {
    expect(blockerCodes(plan(library(), { ...emptyComposition(), ...over }))).toContain(code);
  });

  it('blocks a revision that isn\'t there', () => {
    const index = library();
    expect(blockerCodes(plan(index, { ...emptyComposition(), template: { templateId: 'base', acceptedRevision: 9 } }))).toEqual(['revision_unavailable']);
  });

  it('a block missing anyway blocks at next start with a reason, and drops nothing silently', () => {
    const index = indexOf([block('kept'), entry('t', [tmpl([ref('Gone', 'gone'), ref('Kept', 'kept')])])]);
    const result = plan(index, instanceOf(index, 't'));
    expect(result.blockers).toEqual([{ code: 'asset_missing', assetIds: ['gone'] }]);
    expect(result.activation).toBeNull();
  });

  it('blocks a deleted block and leaves nothing partial', () => {
    const index = indexOf([block('gone', [BLOCK], { deletedAt: 't' }), block('kept'), entry('t', [tmpl([ref('Gone', 'gone'), ref('Kept', 'kept')])])]);
    const result = plan(index, instanceOf(index, 't'));
    expect(blockerCodes(result)).toEqual(['asset_deleted']);
    expect(result.activation).toBeNull();
  });
});

describe('native subagents', () => {
  const definitions = (more: Partial<Extract<AssetProjection, { kind: 'subagent' }>> = {}, id = 'tester', name = 'test-runner') => (
    entry(id, [subagent(name, { blocks: [ref('Role', 'role', 1)], skills: ['review'], mcps: ['git'], ...more })])
  );
  const withSubagent = (sub: CatalogEntry = definitions(), extra: CatalogEntry[] = []) => indexOf([
    block('role'),
    block('identity'),
    skill('review', 'code-review'),
    mcp('git'),
    sub,
    entry('t', [tmpl([ref('Identity', 'identity')], { subagents: [subRef('Tester', sub.id)] })]),
    ...extra,
  ]);

  it('plans the set with its own blocks and refs, at a destination of its own', () => {
    const index = withSubagent();
    const result = plan(index, instanceOf(index, 't'));
    expect(result.blockers).toEqual([]);
    expect(result.subagents[0]).toMatchObject({
      entryKey: 'base:Tester',
      source: 'follow',
      assetId: 'tester',
      agentName: 'test-runner',
      revision: 1,
      destination: { kind: 'native-subagent', key: 'subagents/test-runner' },
      providers: ['claude'],
      reviewFields: [],
    });
    expect(result.subagents[0].blocks.map((item) => [item.entryId, item.assetId, item.revision])).toEqual([['Role', 'role', 1]]);
    expect(result.subagents[0].skills.map((item) => item.assetId)).toEqual(['review']);
    expect(result.activation?.subagents[0]).toMatchObject({ assetId: 'tester', blocks: [{ assetId: 'role', revision: 1 }] });
  });

  it('holds no Clubhouse identity and adds nothing to the instance\'s own skills or MCP', () => {
    const index = withSubagent();
    const result = plan(index, instanceOf(index, 't'));
    expect(result.skills).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(JSON.stringify(result.subagents)).not.toMatch(/agentId|sessionId|wire|helper/);
  });

  it('a subagent\'s own block follows the same two tracks', () => {
    const index = withSubagent(definitions(), []);
    index.assets.role = block('role', [BLOCK, BLOCK, tagged('t', 9), BLOCK]);
    const nested = plan(index, instanceOf(index, 't')).subagents[0].blocks[0];
    expect(nested).toMatchObject({ revision: 2, update: { heldBy: { templateId: 't', templateRevision: 9 }, range: { from: 1, to: 4 } } });
  });

  it('a bundled revision of the definition itself waits the same way', () => {
    const index = withSubagent();
    index.assets.tester = entry('tester', [subagent('test-runner'), [subagent('test-runner'), { templateId: 't', templateRevision: 2 }]]);
    const planned = plan(index, instanceOf(index, 't')).subagents[0];
    expect(planned).toMatchObject({ revision: 1, floor: 1, takeableRevision: 1, headRevision: 2, update: { resolution: 'accept-template' } });
  });

  it('a clean update brings a new definition, and takes away a followed one, in the same revision', () => {
    const index = indexOf([
      block('a'),
      entry('old', [subagent('old-name')]),
      entry('new', [subagent('new-name')]),
      entry('t', [
        tmpl([ref('A', 'a')], { subagents: [subRef('Old', 'old')] }),
        tmpl([ref('A', 'a')], { subagents: [subRef('New', 'new')] }),
      ]),
    ]);
    const result = plan(index, instanceOf(index, 't'), LATEST);
    expect(result.structure).toMatchObject({ resolvedRevision: 2, update: { status: 'clean' } });
    expect(result.subagents.map((item) => item.assetId)).toEqual(['new']);
  });

  it('upstream removing a forked definition waits for a choice, and keeps the fork meanwhile', () => {
    const fork = entry('my-old', [subagent('old-name')], { ...owned(), source: { kind: 'copy', originAssetId: 'old', originRevision: 1 } });
    const index = indexOf([
      block('a'), fork,
      entry('old', [subagent('old-name')]),
      entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('Old', 'old')] }), tmpl([ref('A', 'a')])]),
    ]);
    const result = plan(index, instanceOf(index, 't', 1, {
      subagents: [{ baseEntryId: 'Old', source: { kind: 'fork', subagentId: 'my-old', forkedFrom: { assetId: 'old', revision: 1 } } }],
    }), LATEST);
    expect(result.structure).toMatchObject({ resolvedRevision: 1, update: { status: 'needs-choice', subagentReasons: [{ code: 'removed_forked', entries: ['base:Old'] }] } });
    expect(result.subagents.map((item) => item.assetId)).toEqual(['my-old']);
  });

  it('an update onto a foreign definition\'s name waits, and this start goes on', () => {
    const index = indexOf([
      block('a'),
      entry('sub', [subagent('taken')]),
      entry('t', [tmpl([ref('A', 'a')]), tmpl([ref('A', 'a')], { subagents: [subRef('Sub', 'sub')] })]),
    ]);
    const result = plan(index, instanceOf(index, 't'), LATEST, [{ key: 'subagents/taken', owner: 'native' }]);
    expect(result.blockers).toEqual([]);
    expect(result.structure?.update.subagentReasons).toEqual([{ code: 'foreign_name_collision', entries: ['base:Sub'] }]);
    expect(result.activation).not.toBeNull();
  });

  it('exclude keeps it out, and it shows', () => {
    const index = withSubagent();
    const result = plan(index, instanceOf(index, 't', 1, { subagents: [], excludedSubagentEntryIds: ['Tester'] }));
    expect(result.subagents).toEqual([]);
    expect(result.excluded).toContainEqual({ kind: 'subagent', assetId: 'tester', entryId: 'Tester' });
    expect(result.blockers).toEqual([]);
  });

  it('leaving one out without excluding it blocks', () => {
    const index = withSubagent();
    expect(blockerCodes(plan(index, instanceOf(index, 't', 1, { subagents: [] })))).toEqual(['entry_missing_from_order']);
  });

  it('a fork is the agent\'s own, and reports its origin', () => {
    const fork = entry('my-tester', [subagent('test-runner')], { ...owned(), source: { kind: 'copy', originAssetId: 'tester', originRevision: 1 } });
    const index = withSubagent(definitions(), [fork]);
    const result = plan(index, instanceOf(index, 't', 1, {
      subagents: [{ baseEntryId: 'Tester', source: { kind: 'fork', subagentId: 'my-tester', forkedFrom: { assetId: 'tester', revision: 1 } } }],
    }));
    expect(result.blockers).toEqual([]);
    expect(result.subagents[0]).toMatchObject({ source: 'fork', assetId: 'my-tester', origin: { originAssetId: 'tester' } });
  });

  it('two definitions with one name collide', () => {
    const local2 = entry('other', [subagent('Test-Runner')], owned());
    const index = withSubagent(definitions(), [local2]);
    const result = plan(index, instanceOf(index, 't', 1, {
      subagents: [{ baseEntryId: 'Tester', source: { kind: 'follow' } }, { localId: 'Mine', source: { kind: 'local', subagentId: 'other' } }],
    }));
    expect(result.blockers).toEqual([{ code: 'destination_collision', assetIds: ['other', 'tester'], destination: 'subagents/Test-Runner' }]);
  });

  it('a foreign definition with the name blocks, and is never overwritten', () => {
    const index = withSubagent();
    const result = plan(index, instanceOf(index, 't'), ACCEPTED, [{ key: 'subagents/test-runner', owner: 'native' }]);
    expect(result.blockers[0]).toMatchObject({ code: 'foreign_destination_collision', foreignOwner: 'native' });
  });

  describe('the chain rule through a definition\'s own references', () => {
    // On T r1 with S r1 using Job r1. T r2 bundles Job r2 and Safety, then an independent S r2 points at Job r2.
    const crossing = (more: Revision[] = []) => indexOf([
      block('job', [BLOCK, tagged('t', 2)]),
      block('safety', [tagged('t', 2)]),
      entry('s', [subagent('s', { blocks: [ref('Role', 'job', 1)] }), subagent('s', { blocks: [ref('Role', 'job', 2)] }), ...more]),
      entry('t', [
        tmpl([ref('Job', 'job', 1)], { subagents: [subRef('S', 's', 1)] }),
        tmpl([ref('Safety', 'safety', 1), ref('Job', 'job', 2)], { subagents: [subRef('S', 's', 1)] }),
      ]),
    ]);

    it('an independent revision can\'t pull a tagged block past the floor', () => {
      const index = crossing();
      const result = plan(index, instanceOf(index, 't'));
      expect(result.blockers).toEqual([]);
      expect(result.subagents[0]).toMatchObject({ revision: 1, floor: 1, takeableRevision: 1, headRevision: 2 });
      expect(result.subagents[0].blocks[0]).toMatchObject({ assetId: 'job', revision: 1 });
      expect(blockRevisions(result)).toEqual([['base:Job', 'job', 1]]);
    });

    it('says what it\'s held with, and what accepting would bring', () => {
      const index = crossing();
      expect(plan(index, instanceOf(index, 't')).subagents[0].update).toEqual({
        range: { from: 1, to: 2 },
        heldBy: { templateId: 't', templateRevision: 2 },
        resolution: 'accept-template',
        missingCompanions: ['safety'],
        kept: false,
      });
    });

    it('a later independent revision built on that one waits too', () => {
      const index = crossing([subagent('s', { blocks: [ref('Role', 'job', 1)] })]);
      expect(plan(index, instanceOf(index, 't')).subagents[0]).toMatchObject({ revision: 1, takeableRevision: 1, headRevision: 3 });
    });

    it('accepting T r2 moves the floor past the tag, and it flows', () => {
      const index = crossing();
      const result = plan(index, instanceOf(index, 't', 2));
      expect(result.blockers).toEqual([]);
      expect(result.subagents[0]).toMatchObject({ revision: 2, floor: 1 });
      expect(result.subagents[0].blocks[0]).toMatchObject({ assetId: 'job', revision: 2 });
    });

    it('a hold can\'t reach past it, and an Apply can\'t jump this instance\'s own template', () => {
      const index = crossing();
      expect(blockerCodes(plan(index, instanceOf(index, 't'), held({ job: 1, s: 2 })))).toContain('hold_past_bundle');
      expect(blockerCodes(plan(index, instanceOf(index, 't', 1, { floors: { s: 2 } })))).toContain('floor_bypasses_template');
    });

    it('a definition\'s reference to a tagged block it\'s never had is held too', () => {
      const index = indexOf([
        block('a'),
        block('other', [tagged('u', 1)]),
        entry('s', [subagent('s', { blocks: [ref('A', 'a', 1)] }), subagent('s', { blocks: [ref('Other', 'other', 1)] })]),
        entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('S', 's', 1)] })]),
      ]);
      expect(plan(index, instanceOf(index, 't')).subagents[0]).toMatchObject({ revision: 1, update: { heldBy: { templateId: 'u', templateRevision: 1 }, resolution: 'explicit' } });
    });

    it('another template\'s consumer can Apply it, and an untagged reference flows as ever', () => {
      const index = indexOf([
        block('a'),
        block('job', [BLOCK, tagged('u', 2)]),
        entry('s', [subagent('s', { blocks: [ref('Role', 'job', 1)] }), subagent('s', { blocks: [ref('Role', 'job', 2)] })]),
        entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('S', 's', 1)] })]),
      ]);
      const applied = plan(index, instanceOf(index, 't', 1, { floors: { s: 2 } }));
      expect(applied.blockers).toEqual([]);
      expect(applied.subagents[0]).toMatchObject({ revision: 2 });

      const plain = indexOf([
        block('a'),
        block('job', [BLOCK, BLOCK]),
        entry('s', [subagent('s', { blocks: [ref('Role', 'job', 1)] }), subagent('s', { blocks: [ref('Role', 'job', 2)] })]),
        entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('S', 's', 1)] })]),
      ]);
      expect(plan(plain, instanceOf(plain, 't')).subagents[0]).toMatchObject({ revision: 2, update: null });
    });
  });

  describe('tool lists', () => {
    const toolField = {
      path: 'claude.tools',
      list: 'allow' as const,
      names: ['Read', 'Agent', 'mcp__clubhouse__send_message'],
      delegation: ['Agent'],
      clubhouseMcp: ['mcp__clubhouse__send_message'],
      hasUnlisted: false,
    };

    it('don\'t block, and the plan shows them for a person to see', () => {
      const index = withSubagent(definitions({ toolFields: [toolField] }));
      const result = plan(index, instanceOf(index, 't'));
      expect(result.blockers).toEqual([]);
      expect(result.activation).not.toBeNull();
      expect(result.subagents[0].toolFields).toEqual([toolField]);
    });

    it('don\'t make a revision wait', () => {
      const index = indexOf([
        block('a'),
        entry('sub', [subagent('tester', { toolFields: [toolField] })]),
        entry('t', [tmpl([ref('A', 'a')]), tmpl([ref('A', 'a')], { subagents: [subRef('Sub', 'sub')] })]),
      ]);
      expect(plan(index, instanceOf(index, 't'), LATEST).structure).toMatchObject({ resolvedRevision: 2, update: { status: 'clean', subagentReasons: [] } });
    });

    it('none declared stays empty, and the plan claims nothing about isolation', () => {
      const index = withSubagent();
      const result = plan(index, instanceOf(index, 't'));
      expect(result.subagents[0].toolFields).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/isolat|sandbox|restricted|confined/i);
      const declared = withSubagent(definitions({ toolFields: [toolField] }));
      expect(JSON.stringify(plan(declared, instanceOf(declared, 't')))).not.toMatch(/isolat|sandbox|restricted|confined/i);
    });
  });

  describe('authority', () => {
    const review = [{ path: 'claude.hooks', reason: 'authority' as const }, { path: 'claude.permissionMode', reason: 'authority' as const }];
    const risky = () => withSubagent(definitions({ reviewFields: review }));
    const approvalOf = (index: CatalogIndex, revision = 1) => ({ revision, contentHash: index.assets.tester.revisions[revision - 1].contentHash });

    it('a field that can raise authority blocks for a person, naming where it sits and never its value', () => {
      const index = risky();
      const result = plan(index, instanceOf(index, 't'));
      expect(result.blockers).toEqual([{ code: 'subagent_review_fields', assetIds: ['tester'], fields: ['claude.hooks', 'claude.permissionMode'] }]);
      expect(result.activation).toBeNull();
    });

    it('a person\'s resolution counts for exactly that revision', () => {
      const index = risky();
      expect(plan(index, instanceOf(index, 't', 1, { authorityApprovals: { tester: approvalOf(index) } })).blockers).toEqual([]);
    });

    it('an approval can\'t be given ahead of time: a revision that doesn\'t exist yet binds to nothing', () => {
      const index = risky();
      const ahead = { revision: 2, contentHash: canonicalHash('anything') };
      expect(blockerCodes(plan(index, instanceOf(index, 't', 1, { authorityApprovals: { tester: ahead } })))).toEqual(['approval_unbound', 'subagent_review_fields']);
    });

    it('an approval binds to content: the right number with another hash counts for nothing', () => {
      const index = risky();
      const wrong = { revision: 1, contentHash: canonicalHash('other content') };
      expect(blockerCodes(plan(index, instanceOf(index, 't', 1, { authorityApprovals: { tester: wrong } })))).toEqual(['approval_unbound', 'subagent_review_fields']);
    });

    it('an approval of an earlier revision doesn\'t reach a later one', () => {
      const index = risky();
      index.assets.tester = entry('tester', [subagent('test-runner', { reviewFields: review }), subagent('test-runner-2', { reviewFields: review })]);
      const earlier = approvalOf(index, 1);
      expect(blockerCodes(plan(index, instanceOf(index, 't', 1, { authorityApprovals: { tester: earlier } })))).toEqual(['subagent_review_fields']);
      expect(plan(index, instanceOf(index, 't', 1, { authorityApprovals: { tester: approvalOf(index, 2) } })).blockers).toEqual([]);
    });

    it('excluding the definition resolves it too', () => {
      const index = risky();
      expect(plan(index, instanceOf(index, 't', 1, { subagents: [], excludedSubagentEntryIds: ['Tester'] })).blockers).toEqual([]);
    });

    it('a new revision bringing one makes the structure update wait, whatever else is clean', () => {
      const index = indexOf([
        block('a'),
        entry('safe', [subagent('safe')]),
        entry('danger', [subagent('danger', { reviewFields: [{ path: 'claude.hooks', reason: 'authority' }] })]),
        entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('Safe', 'safe')] }), tmpl([ref('A', 'a')], { subagents: [subRef('Safe', 'safe'), subRef('Danger', 'danger')] })]),
      ]);
      const result = plan(index, instanceOf(index, 't'), LATEST);
      expect(result.blockers).toEqual([]);
      expect(result.structure).toMatchObject({ resolvedRevision: 1, update: { status: 'needs-choice' } });
      expect(result.structure?.update.subagentReasons).toEqual([{ code: 'review_fields', entries: ['base:Danger'] }]);
    });
  });
});

describe('determinism', () => {
  it('is the same plan whatever order the catalog came in', () => {
    const index = library();
    const composition = instanceOf(index, 'base', 1, { additions: ['notes', 'workiq'], removals: ['git', 'nope'] });
    const one = plan(index, composition);
    const two = plan(indexOf(Object.values(index.assets).reverse()), { ...composition, additions: ['workiq', 'notes'], removals: ['nope', 'git'] });
    expect(two.fingerprint).toBe(one.fingerprint);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('the fingerprint moves with anything that changes the outcome', () => {
    const index = library();
    const base = plan(index, instanceOf(index, 'base')).fingerprint;
    expect(plan(index, instanceOf(index, 'base', 1, { additions: ['notes'] })).fingerprint).not.toBe(base);
    expect(plan(index, instanceOf(index, 'base'), ACCEPTED, [{ key: 'mcp/other', owner: 'native' }]).fingerprint).not.toBe(base);
    expect(plan(index, instanceOf(index, 'base'), ACCEPTED, undefined, 'agent-2').fingerprint).not.toBe(base);
    expect(plan(index, instanceOf(index, 'base'), LATEST).fingerprint).not.toBe(base);
    const moved = library();
    moved.assets.job = block('job', [BLOCK, BLOCK]);
    expect(plan(moved, instanceOf(moved, 'base')).fingerprint).not.toBe(base);
  });
});

describe('what a subagent refers to', () => {
  const nested = (skillRevisions: number) => {
    const skillProjection: AssetProjection = { kind: 'skill', skillName: 'nested', filePaths: [] };
    return indexOf([
      block('a'), block('role'),
      entry('nested', Array.from({ length: skillRevisions }, () => skillProjection)),
      entry('sub', [subagent('tester', { blocks: [ref('Role', 'role')], skills: ['nested'] })]),
      entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('Sub', 'sub')] })]),
    ]);
  };

  it('moves the fingerprint when it moves', () => {
    const before = nested(1);
    const after = nested(2);
    const one = plan(before, instanceOf(before, 't'));
    const two = plan(after, instanceOf(after, 't'));
    expect(two.activation?.subagents[0].skills[0].revision).toBe(2);
    expect(two.fingerprint).not.toBe(one.fingerprint);
  });

  it('shows in impact preview as a change where it\'s delivered', () => {
    const index = nested(1);
    const withAgent = indexOf(Object.values(index.assets), [stored('agent', instanceOf(index, 't'))]);
    const projection: AssetProjection = { kind: 'skill', skillName: 'nested', filePaths: [] };
    const impact = previewAssetImpact(withAgent, 'nested', { revision: 2, savedAt: 't', contentHash: 'next', projection });
    expect(impact.agents[0].changes).toEqual([{ assetId: 'nested', fromRevision: 1, toRevision: 2, destination: 'subagents/tester' }]);
  });
});

describe('the activation plan', () => {
  it('is provider-neutral and whole', () => {
    const index = library();
    const result = plan(index, instanceOf(index, 'base', 1, { additions: ['workiq'] }));
    expect(result.activation).toMatchObject({ agentId: 'agent-1', fingerprint: result.fingerprint, structure: { templateId: 'base', resolvedRevision: 1 } });
    expect(result.activation?.assets.find((asset) => asset.assetId === 'workiq')?.requires).toEqual({ envVars: ['WORKIQ_HOME'], auth: 'external' });
    const text = JSON.stringify(result.activation);
    for (const nativeWord of ['.claude', '.codex', '.github', '.mcp.json', 'CLAUDE.md', 'AGENTS.md', 'copilot', 'worktree', 'sessionId']) {
      expect(text).not.toContain(nativeWord);
    }
  });

  it('is withheld entirely while anything blocks', () => {
    const index = library([mcp('git-2', 'git')]);
    const result = plan(index, instanceOf(index, 'base', 1, { additions: ['git-2', 'notes'] }));
    expect(result.activation).toBeNull();
    expect(result.skills.length).toBeGreaterThan(0);
  });
});

describe('consumers', () => {
  const index = () => {
    const assets = [
      ...Object.values(library().assets),
      block('other-doc'),
      block('fork', [BLOCK], { ...owned('forker'), source: { kind: 'copy', originAssetId: 'job', originRevision: 1 } }),
    ];
    const start = indexOf(assets);
    return indexOf(assets, [
      stored('linked', instanceOf(start, 'base')),
      stored('excluder', instanceOf(start, 'base', 1, { entries: [follow('Identity'), follow('Handoff')], excludedEntryIds: ['Job'], removals: ['review'] })),
      stored('forker', instanceOf(start, 'base', 1, { entries: [follow('Identity'), { baseEntryId: 'Job', source: { kind: 'fork', blockId: 'fork', forkedFrom: { assetId: 'job', revision: 1 } } }, follow('Handoff')] })),
      stored('adder', { ...emptyComposition(), additions: ['review'] }),
      stored('other', emptyComposition()),
    ]);
  };

  it('lists every relation to a block, exclusions and overrides included', () => {
    const consumers = listConsumers(index(), 'job');
    expect(consumers.templates).toEqual([{ templateId: 'base', role: 'block' }]);
    expect(consumers.agents).toEqual([
      { agentId: 'excluder', relations: ['excluded'], effective: false },
      { agentId: 'forker', relations: ['overridden'], effective: false },
      { agentId: 'linked', relations: ['via-base'], effective: true },
    ]);
    expect(consumers.copies).toEqual([{ assetId: 'fork', owner: { kind: 'agent', agentId: 'forker' }, originRevision: 1 }]);
    expect(hasHardReference(consumers)).toBe(true);
  });

  it('lists every relation to a skill', () => {
    expect(listConsumers(index(), 'review').agents).toEqual([
      { agentId: 'adder', relations: ['addition'], effective: true },
      { agentId: 'excluder', relations: ['excluded'], effective: false },
      { agentId: 'forker', relations: ['via-base'], effective: true },
      { agentId: 'linked', relations: ['via-base'], effective: true },
    ]);
  });

  it('a fork is its owner\'s own entry', () => {
    expect(listConsumers(index(), 'fork').agents).toEqual([{ agentId: 'forker', relations: ['own-entry'], effective: true }]);
  });

  it('lists the agents linked to a template', () => {
    expect(listConsumers(index(), 'base').agents.map((agent) => [agent.agentId, agent.relations])).toEqual([
      ['excluder', ['base-template']],
      ['forker', ['base-template']],
      ['linked', ['base-template']],
    ]);
  });

  it('counts what an instance accepted, not only the latest: an old revision still uses it', () => {
    const assets = [
      block('old'), block('new'),
      entry('t', [tmpl([ref('Old', 'old')]), tmpl([ref('New', 'new')])]),
    ];
    const start = indexOf(assets);
    const consumers = listConsumers(indexOf(assets, [stored('behind', instanceOf(start, 't', 1))]), 'old');
    expect(consumers.templates).toEqual([]);
    expect(consumers.agents).toEqual([{ agentId: 'behind', relations: ['via-base'], effective: true }]);
    expect(hasHardReference(consumers)).toBe(true);
  });

  it('a subagent using a block or skill counts, directly and through an instance', () => {
    const assets = [
      block('role'), block('a'), skill('review'),
      entry('sub', [subagent('tester', { blocks: [ref('Role', 'role')], skills: ['review'] })]),
      entry('t', [tmpl([ref('A', 'a')], { subagents: [subRef('Sub', 'sub')] })]),
    ];
    const start = indexOf(assets);
    const withAgent = indexOf(assets, [stored('agent', instanceOf(start, 't'))]);
    expect(listConsumers(withAgent, 'role')).toMatchObject({ subagents: ['sub'], agents: [{ agentId: 'agent', relations: ['via-subagent'] }] });
    expect(listConsumers(withAgent, 'review').subagents).toEqual(['sub']);
    expect(listConsumers(withAgent, 'sub').templates).toEqual([{ templateId: 't', role: 'subagent' }]);
  });

  it('a subagent revision an instance accepted counts, though a later revision has moved on', () => {
    const assets = [
      block('job'), block('other'),
      entry('s', [subagent('s', { blocks: [ref('Role', 'job')] }), subagent('s', { blocks: [ref('Role', 'other')] })]),
      entry('t', [tmpl([ref('Other', 'other')], { subagents: [subRef('S', 's', 1)] })]),
    ];
    const start = indexOf(assets);
    const consumers = listConsumers(indexOf(assets, [stored('agent', instanceOf(start, 't'))]), 'job');
    expect(consumers.subagents).toEqual([]);
    expect(consumers.agents).toEqual([{ agentId: 'agent', relations: ['via-subagent'], effective: true }]);
    expect(hasHardReference(consumers)).toBe(true);
  });

  it('a subagent followed directly goes from its floor: the revision it\'s on counts, though a bundle has moved on', () => {
    const assets = [
      block('job'), block('other'),
      entry('s', [
        subagent('s', { blocks: [ref('Role', 'job')] }),
        [subagent('s', { blocks: [ref('Role', 'other')] }), { templateId: 'u', templateRevision: 1 }],
      ]),
    ];
    const agent = stored('agent', { ...emptyComposition(), subagents: [{ localId: 'S', source: { kind: 'follow', subagentId: 's' } }], floors: { s: 1 } });
    const consumers = listConsumers(indexOf(assets, [agent]), 'job');
    expect(consumers.agents).toEqual([{ agentId: 'agent', relations: ['via-subagent'], effective: true }]);
    expect(hasHardReference(consumers)).toBe(true);
  });

  it('an agent\'s own fork of a definition goes from its latest', () => {
    const assets = [
      block('job'), block('other'),
      entry('mine', [subagent('s', { blocks: [ref('Role', 'job')] }), subagent('s', { blocks: [ref('Role', 'other')] })], { ...owned('agent'), source: { kind: 'copy', originAssetId: 's', originRevision: 1 } }),
    ];
    const agent = stored('agent', { ...emptyComposition(), subagents: [{ localId: 'S', source: { kind: 'fork', subagentId: 'mine', forkedFrom: { assetId: 's', revision: 1 } } }] });
    expect(listConsumers(indexOf(assets, [agent]), 'job').agents).toEqual([]);
    expect(listConsumers(indexOf(assets, [agent]), 'other').agents).toEqual([{ agentId: 'agent', relations: ['via-subagent'], effective: true }]);
  });

  it('an exclusion alone is no reason to refuse deletion', () => {
    const only = indexOf([skill('loner')], [stored('a', { ...emptyComposition(), removals: ['loner'] })]);
    const consumers = listConsumers(only, 'loner');
    expect(consumers.agents).toEqual([{ agentId: 'a', relations: ['excluded'], effective: false }]);
    expect(hasHardReference(consumers)).toBe(false);
  });

  it('nothing refers to an unassigned asset', () => {
    const consumers = listConsumers(index(), 'notes');
    expect(consumers).toEqual({ assetId: 'notes', templates: [], subagents: [], agents: [], copies: [] });
    expect(hasHardReference(consumers)).toBe(false);
  });
});

describe('impact of a central edit', () => {
  const index = () => {
    const assets = [
      ...Object.values(library().assets),
      entry('fork', [{ kind: 'skill', skillName: 'fork', filePaths: [] }], { ...owned('owner'), source: { kind: 'copy', originAssetId: 'review', originRevision: 1 } }),
      skill('rival'),
    ];
    const start = indexOf(assets);
    return indexOf(assets, [
      stored('linked', instanceOf(start, 'base')),
      stored('excluder', instanceOf(start, 'base', 1, { removals: ['review'] })),
      stored('adder', { ...emptyComposition(), additions: ['review', 'rival'] }),
    ]);
  };
  const candidate = (projection: AssetProjection, revision = 2): AssetRevisionRecord => ({ revision, savedAt: 'later', contentHash: 'next-hash', projection });
  const skillNamed = (skillName: string): AssetProjection => ({ kind: 'skill', skillName, filePaths: [] });

  it('previews every consumer with what moves for each, leaving the index alone', () => {
    const current = index();
    const before = JSON.stringify(current);
    const impact = previewAssetImpact(current, 'review', candidate(skillNamed('code-review')));
    expect(JSON.stringify(current)).toBe(before);
    expect(impact).toMatchObject({ assetId: 'review', fromRevision: 1, toRevision: 2, blocked: false });
    expect(impact.templates).toEqual([{ templateId: 'base', role: 'skill' }]);
    expect(impact.copies).toEqual([{ assetId: 'fork', owner: { kind: 'agent', agentId: 'owner' }, originRevision: 1 }]);
    const byAgent = Object.fromEntries(impact.agents.map((agent) => [agent.agentId, agent]));
    expect(Object.keys(byAgent)).toEqual(['adder', 'excluder', 'linked']);
    expect(byAgent.linked.changes).toEqual([{ assetId: 'review', fromRevision: 1, toRevision: 2, destination: 'skills/code-review' }]);
    expect(byAgent.excluder).toMatchObject({ effective: false, changes: [], relations: ['excluded'] });
  });

  it('an independent block edit reaches followers as a new revision at the one destination', () => {
    const impact = previewAssetImpact(index(), 'job', candidate(BLOCK));
    const linked = impact.agents.find((agent) => agent.agentId === 'linked')!;
    expect(linked.changes).toEqual([{ assetId: 'job', fromRevision: 1, toRevision: 2, destination: 'instructions/primary' }]);
    expect(impact.blocked).toBe(false);
  });

  it('shows a destination move as a change', () => {
    const linked = previewAssetImpact(index(), 'review', candidate(skillNamed('renamed-skill'))).agents.find((agent) => agent.agentId === 'linked')!;
    expect(linked.changes).toEqual([{ assetId: 'review', fromRevision: 1, toRevision: 2, destination: 'skills/renamed-skill' }]);
    expect(linked.destinations).toContain('skills/renamed-skill');
    expect(linked.destinations).not.toContain('skills/code-review');
  });

  it('an edit that would collide for one consumer blocks and names it', () => {
    const impact = previewAssetImpact(index(), 'review', candidate(skillNamed('rival')));
    expect(impact.blocked).toBe(true);
    expect(impact.agents.find((agent) => agent.agentId === 'adder')!.newBlockers).toEqual([{ code: 'destination_collision', assetIds: ['review', 'rival'], destination: 'skills/rival' }]);
    expect(impact.agents.find((agent) => agent.agentId === 'linked')!.newBlockers).toEqual([]);
  });

  it('a blocker that was already there is not blamed on this edit', () => {
    const stuck = indexOf(
      [skill('one', 'same'), skill('two', 'same'), mcp('lone')],
      [stored('a', { ...emptyComposition(), additions: ['one', 'two', 'lone'] })],
    );
    const impact = previewAssetImpact(stuck, 'lone', candidate({ kind: 'mcp', serverKey: 'lone', transport: 'stdio', envVars: [] }));
    expect(impact.blocked).toBe(false);
    expect(impact.agents[0].newBlockers).toEqual([]);
  });

  it('a template edit changes nothing yet for its linked agents, and says where each stands', () => {
    const impact = previewAssetImpact(index(), 'base', candidate(tmpl([ref('Identity', 'identity'), ref('Job', 'job'), ref('Handoff', 'handoff')], { skills: ['review', 'notes'], mcps: ['git'], operationalDefaults: { orchestrate: true, control: 'ask-before-start' } })));
    const linked = impact.agents.find((agent) => agent.agentId === 'linked')!;
    expect(linked.relations).toEqual(['base-template']);
    expect(linked.changes).toEqual([]);
    expect(linked.structure).toMatchObject({ status: 'clean', targetRevision: 2 });
    expect(impact.blocked).toBe(false);
  });

  it('reports agents sharing a workspace, and blocks when an edit would make them diverge', () => {
    const shared = indexOf(
      [skill('shared-skill', 'same'), skill('private', 'private')],
      [
        stored('a', { ...emptyComposition(), additions: ['shared-skill'] }),
        stored('b', { ...emptyComposition(), additions: ['shared-skill'] }),
        stored('c', { ...emptyComposition(), additions: ['private'] }),
      ],
    );
    const context = { workspaceByAgent: { a: 'w1', b: 'w1', c: 'w1' } };
    const agree = previewAssetImpact(shared, 'shared-skill', candidate(skillNamed('same')), context);
    expect(agree.blocked).toBe(false);
    expect(agree.sharedDestinations).toEqual([{
      workspaceKey: 'w1',
      destination: 'skills/same',
      agents: [{ agentId: 'a', assetId: 'shared-skill', revision: 2 }, { agentId: 'b', assetId: 'shared-skill', revision: 2 }],
      divergent: false,
    }]);

    const diverge = previewAssetImpact(shared, 'private', candidate(skillNamed('same')), context);
    expect(diverge.blocked).toBe(true);
    expect(diverge.sharedDestinations[0].divergent).toBe(true);
  });

  it('agents sharing a workspace diverge on instructions by order alone', () => {
    const assets = [block('a'), block('b'), entry('t', [tmpl([ref('A', 'a'), ref('B', 'b')])])];
    const start = indexOf(assets);
    const reordered = (agent: string) => plan(start, instanceOf(start, 't', 1, { entries: [follow('B'), follow('A')] }), ACCEPTED, undefined, agent);
    const same = (agent: string) => plan(start, instanceOf(start, 't'), ACCEPTED, undefined, agent);
    const workspace = { one: 'w', two: 'w' };
    expect(findSharedDestinations([same('one'), same('two')], workspace).every((group) => !group.divergent)).toBe(true);
    expect(findSharedDestinations([same('one'), reordered('two')], workspace).some((group) => group.divergent && group.destination === 'instructions/primary')).toBe(true);
  });

  it('separate workspaces, or none known, do not share', () => {
    const shared = indexOf(
      [skill('one', 'same'), skill('two', 'same')],
      [stored('a', { ...emptyComposition(), additions: ['one'] }), stored('b', { ...emptyComposition(), additions: ['two'] })],
    );
    expect(previewAssetImpact(shared, 'one', candidate(skillNamed('same'))).sharedDestinations).toEqual([]);
    expect(previewAssetImpact(shared, 'one', candidate(skillNamed('same')), { workspaceByAgent: { a: 'w1', b: 'w2' } }).sharedDestinations).toEqual([]);
    expect(previewAssetImpact(shared, 'one', candidate(skillNamed('same')), { workspaceByAgent: { a: 'w1' } }).sharedDestinations).toEqual([]);
  });

  it('considers what each agent already has natively', () => {
    const impact = previewAssetImpact(index(), 'review', candidate(skillNamed('taken')), { foreignByAgent: { linked: [{ key: 'skills/taken', owner: 'native' }] } });
    expect(impact.blocked).toBe(true);
    expect(impact.agents.find((agent) => agent.agentId === 'linked')?.newBlockers[0]).toMatchObject({ code: 'foreign_destination_collision', foreignOwner: 'native' });
  });

  it('the fingerprint moves with the content and the consumers, not with a new copy', () => {
    const base = previewAssetImpact(index(), 'review', candidate(skillNamed('code-review'))).fingerprint;
    expect(previewAssetImpact(index(), 'review', { ...candidate(skillNamed('code-review')), contentHash: 'other' }).fingerprint).not.toBe(base);
    const moreConsumers = index();
    moreConsumers.compositions.another = stored('another', { ...emptyComposition(), additions: ['review'] });
    expect(previewAssetImpact(moreConsumers, 'review', candidate(skillNamed('code-review'))).fingerprint).not.toBe(base);
    const moreCopies = index();
    moreCopies.assets['fork-2'] = entry('fork-2', [skillNamed('fork-2')], { ...owned('x'), source: { kind: 'copy', originAssetId: 'review', originRevision: 1 } });
    expect(previewAssetImpact(moreCopies, 'review', candidate(skillNamed('code-review'))).fingerprint).toBe(base);
  });
});
