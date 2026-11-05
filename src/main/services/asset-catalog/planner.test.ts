import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  emptyComposition,
  findSharedDestinations,
  hasHardReference,
  listConsumers,
  planComposition,
  previewAssetImpact,
} from './planner';
import {
  ASSET_CATALOG_VERSION,
  type AgentComposition,
  type AssetProjection,
  type AssetRevisionRecord,
  type AssetSource,
  type BaseAdoption,
  type CatalogEntry,
  type CatalogIndex,
  type CompositionInput,
  type ForeignDestination,
  type PresetOperationalDefaults,
} from '../../../shared/asset-catalog-types';

const LATEST: BaseAdoption = { mode: 'latest' };

function record(revision: number, projection: AssetProjection): AssetRevisionRecord {
  return { revision, savedAt: 't', contentHash: canonicalHash([projection, revision]), projection };
}

function entry(id: string, projections: AssetProjection[], extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    kind: projections[0].kind,
    name: `name of ${id}`,
    owner: { kind: 'library' },
    source: { kind: 'user' },
    createdAt: 't',
    headRevision: projections.length,
    revisions: projections.map((projection, position) => record(position + 1, projection)),
    ...extra,
  };
}

const mcp = (serverKey: string, extra: Partial<Extract<AssetProjection, { kind: 'mcp' }>> = {}): AssetProjection => ({ kind: 'mcp', serverKey, transport: 'stdio', envVars: [], ...extra });
const skill = (skillName: string): AssetProjection => ({ kind: 'skill', skillName, filePaths: ['SKILL.md'] });
const instruction = (): AssetProjection => ({ kind: 'instruction' });
const preset = (doc: string, skills: string[] = [], mcps: string[] = [], operationalDefaults?: PresetOperationalDefaults): AssetProjection => ({
  kind: 'preset',
  instruction: doc,
  skills,
  mcps,
  ...(operationalDefaults && { operationalDefaults }),
});

function indexOf(assets: CatalogEntry[], compositions: AgentComposition[] = []): CatalogIndex {
  return {
    version: ASSET_CATALOG_VERSION,
    assets: Object.fromEntries(assets.map((asset) => [asset.id, asset])),
    compositions: Object.fromEntries(compositions.map((composition) => [composition.agentId, composition])),
    runs: {},
  };
}

function composition(agentId: string, input: Partial<CompositionInput> = {}): AgentComposition {
  return { ...emptyComposition(), ...input, agentId, revision: 1, updatedAt: 't' };
}

function plan(index: CatalogIndex, input: Partial<CompositionInput> = {}, adoption: BaseAdoption = LATEST, foreign?: ForeignDestination[], agentId = 'agent-1') {
  return planComposition(index, { agentId, composition: { ...emptyComposition(), ...input }, compositionRevision: 0, adoption, foreign });
}

const blockerCodes = (result: ReturnType<typeof plan>) => result.blockers.map((issue) => issue.code);
const noticeCodes = (result: ReturnType<typeof plan>) => result.notices.map((issue) => issue.code);

/** The base for most cases: one preset, one instruction, a skill and an MCP definition. */
function library(extra: CatalogEntry[] = []): CatalogIndex {
  return indexOf([
    entry('doc', [instruction()]),
    entry('review', [skill('code-review')]),
    entry('notes', [skill('release-notes')]),
    entry('git', [mcp('git')]),
    entry('workiq', [mcp('workiq', { auth: 'external', envVars: ['WORKIQ_HOME'] })]),
    entry('base', [preset('doc', ['review'], ['git'], { orchestrate: true, control: 'ask-before-start' })]),
    ...extra,
  ]);
}

describe('resolving', () => {
  it('needs an adoption policy: there is no default', () => {
    const request = { agentId: 'a', composition: emptyComposition(), compositionRevision: 0 };
    expect(() => planComposition(library(), request as never)).toThrow('adoption_policy_required');
  });

  it('resolves every kind through a preset, with destinations and provenance', () => {
    const result = plan(library(), { basePresetId: 'base' });
    expect(result.blockers).toEqual([]);
    expect(result.base).toMatchObject({ presetId: 'base', revision: 1, headRevision: 1, updates: [] });
    expect(result.instruction).toMatchObject({
      assetId: 'doc',
      revision: 1,
      destination: { kind: 'instruction-document', key: 'instructions/primary' },
      provenance: [{ via: 'base', presetId: 'base', presetRevision: 1 }],
    });
    expect(result.skills.map((asset) => [asset.assetId, asset.destination.key])).toEqual([['review', 'skills/code-review']]);
    expect(result.mcpServers.map((asset) => [asset.assetId, asset.destination.key])).toEqual([['git', 'mcp/git']]);
  });

  it('carries operational defaults with their source, and nothing about launch settings', () => {
    const result = plan(library(), { basePresetId: 'base' });
    expect(result.operationalDefaults).toEqual([
      { key: 'orchestrate', value: true, presetId: 'base', presetRevision: 1 },
      { key: 'control', value: 'ask-before-start', presetId: 'base', presetRevision: 1 },
    ]);
  });

  it('follows the latest approved revision for additions', () => {
    const index = library([entry('versioned', [skill('v'), skill('v')])]);
    expect(plan(index, { additions: ['versioned'] }).skills[0]).toMatchObject({ revision: 2, headRevision: 2 });
  });

  it('leaves unadopted surfaces alone: MCP alone needs no instruction', () => {
    const result = plan(library(), { additions: ['workiq'] });
    expect(result.blockers).toEqual([]);
    expect(result.instruction).toBeNull();
    expect(result.activation?.assets.map((asset) => asset.assetId)).toEqual(['workiq']);
  });

  it('an empty composition plans to nothing', () => {
    const result = plan(library());
    expect(result).toMatchObject({ base: null, instruction: null, skills: [], mcpServers: [], blockers: [], notices: [] });
    expect(result.activation?.assets).toEqual([]);
  });
});

describe('deliberate overrides', () => {
  it('adds on top of a base', () => {
    const result = plan(library(), { basePresetId: 'base', additions: ['notes', 'workiq'] });
    expect(result.skills.map((asset) => asset.assetId)).toEqual(['review', 'notes']);
    expect(result.mcpServers.map((asset) => asset.assetId)).toEqual(['git', 'workiq']);
    expect(result.mcpServers[1].provenance).toEqual([{ via: 'addition' }]);
  });

  it('replaces the instruction whole, and says which one it replaced', () => {
    const index = library([entry('fork', [instruction()], { owner: { kind: 'agent', agentId: 'agent-1' } })]);
    const result = plan(index, { basePresetId: 'base', instructionAssetId: 'fork' });
    expect(result.instruction).toMatchObject({ assetId: 'fork', provenance: [{ via: 'instruction-replacement' }] });
    expect(result.replacedInstruction).toEqual({ assetId: 'doc', revision: 1 });
    expect(result.activation?.assets.filter((asset) => asset.kind === 'instruction').map((asset) => asset.assetId)).toEqual(['fork']);
    expect(result.blockers).toEqual([]);
  });

  it('a replacement stands in without needing the base document to be usable', () => {
    const index = library([
      entry('gone', [instruction()], { deletedAt: 't' }),
      entry('old-base', [preset('gone')]),
      entry('mine', [instruction()]),
    ]);
    expect(plan(index, { basePresetId: 'old-base' }).blockers).toEqual([{ code: 'asset_deleted', assetIds: ['gone'] }]);
    expect(plan(index, { basePresetId: 'old-base', instructionAssetId: 'mine' }).blockers).toEqual([]);
  });

  it('removes what the base carries and shows the exclusion', () => {
    const result = plan(library(), { basePresetId: 'base', removals: ['review', 'git'] });
    expect(result.skills).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.excluded).toEqual([
      { assetId: 'git', kind: 'mcp', presetId: 'base' },
      { assetId: 'review', kind: 'skill', presetId: 'base' },
    ]);
  });

  it('a removal that names nothing in the base is reported, not silently dropped', () => {
    const result = plan(library(), { basePresetId: 'base', removals: ['notes'] });
    expect(result.blockers).toEqual([]);
    expect(result.notices).toEqual([{ code: 'inert_removal', assetIds: ['notes'] }]);
  });

  it('adding and removing one asset is a contradiction, not last-write-wins', () => {
    const result = plan(library(), { basePresetId: 'base', additions: ['review'], removals: ['review'] });
    expect(blockerCodes(result)).toContain('contradictory_override');
    expect(result.activation).toBeNull();
  });

  it('rejects kinds that make no sense as an override', () => {
    expect(blockerCodes(plan(library(), { additions: ['doc'] }))).toEqual(['invalid_addition_kind']);
    expect(blockerCodes(plan(library(), { additions: ['base'] }))).toEqual(['invalid_addition_kind']);
    expect(blockerCodes(plan(library(), { removals: ['doc'] }))).toEqual(['invalid_removal_kind']);
    expect(blockerCodes(plan(library(), { instructionAssetId: 'review' }))).toEqual(['wrong_kind']);
    expect(blockerCodes(plan(library(), { basePresetId: 'doc' }))).toEqual(['wrong_kind']);
  });
});

describe('collisions', () => {
  it('distinct owners on one server key block, naming both', () => {
    const index = library([entry('git-2', [mcp('git')])]);
    const result = plan(index, { basePresetId: 'base', additions: ['git-2'] });
    expect(result.blockers).toEqual([{ code: 'destination_collision', assetIds: ['git', 'git-2'], destination: 'mcp/git' }]);
    expect(result.activation).toBeNull();
  });

  it('distinct owners on one skill directory block, including by case', () => {
    const index = library([entry('review-2', [skill('Code-Review')])]);
    const result = plan(index, { basePresetId: 'base', additions: ['review-2'] });
    expect(result.blockers).toEqual([{ code: 'destination_collision', assetIds: ['review', 'review-2'], destination: 'skills/code-review' }]);
  });

  it('a copy beside its origin collides too: the user removes one', () => {
    const copy = entry('review-copy', [skill('code-review')], {
      owner: { kind: 'agent', agentId: 'agent-1' },
      source: { kind: 'copy', originAssetId: 'review', originRevision: 1 },
    });
    const index = library([copy]);
    expect(blockerCodes(plan(index, { basePresetId: 'base', additions: ['review-copy'] }))).toEqual(['destination_collision']);
    expect(plan(index, { basePresetId: 'base', additions: ['review-copy'], removals: ['review'] }).blockers).toEqual([]);
  });

  it('identical references deduplicate and keep every provenance', () => {
    const result = plan(library(), { basePresetId: 'base', additions: ['review'], instructionAssetId: 'doc' });
    expect(result.blockers).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].provenance).toEqual([{ via: 'addition' }, { via: 'base', presetId: 'base', presetRevision: 1 }]);
    expect(result.instruction?.provenance).toEqual([{ via: 'base', presetId: 'base', presetRevision: 1 }, { via: 'instruction-replacement' }]);
    expect(result.replacedInstruction).toBeNull();
    expect(result.activation?.assets.map((asset) => asset.assetId)).toEqual(['doc', 'review', 'git']);
  });

  it('a destination held by a native file or plugin blocks, without touching it', () => {
    const result = plan(library(), { basePresetId: 'base' }, LATEST, [{ key: 'MCP/git', owner: 'native' }, { key: 'skills/other', owner: 'plugin' }]);
    expect(result.blockers).toEqual([{ code: 'foreign_destination_collision', assetIds: ['git'], destination: 'mcp/git', foreignOwner: 'native' }]);
  });
});

describe('invalid references', () => {
  it.each([
    ['a missing base', { basePresetId: 'nope' }, 'asset_missing'],
    ['a missing addition', { additions: ['nope'] }, 'asset_missing'],
    ['a missing instruction', { instructionAssetId: 'nope' }, 'asset_missing'],
    ['an object-key trap', { additions: ['constructor'] }, 'asset_missing'],
  ])('blocks %s', (_label, input, code) => {
    expect(blockerCodes(plan(library(), input))).toEqual([code]);
  });

  it('blocks a deleted asset and leaves nothing partial', () => {
    const index = library([entry('old', [skill('old')], { deletedAt: 't' })]);
    const result = plan(index, { additions: ['old', 'notes'] });
    expect(blockerCodes(result)).toEqual(['asset_deleted']);
    expect(result.activation).toBeNull();
  });

  it("blocks another agent's own copy", () => {
    const index = library([entry('fork', [instruction()], { owner: { kind: 'agent', agentId: 'agent-2' } })]);
    expect(blockerCodes(plan(index, { instructionAssetId: 'fork' }))).toEqual(['owner_mismatch']);
    expect(plan(index, { instructionAssetId: 'fork' }, LATEST, undefined, 'agent-2').blockers).toEqual([]);
  });
});

describe('base adoption stays a parameter', () => {
  const v1 = preset('doc', ['review'], ['git']);
  const v2 = preset('doc', ['review', 'notes'], ['git']);
  const moved = () => indexOf([
    entry('doc', [instruction(), instruction()]),
    entry('review', [skill('code-review')]),
    entry('notes', [skill('release-notes')]),
    entry('git', [mcp('git')]),
    entry('base', [v1, v2]),
  ]);
  const held: BaseAdoption = { mode: 'hold', revisions: { base: 1, doc: 1, review: 1, git: 1 } };

  it('latest resolves head and reports nothing further', () => {
    const result = plan(moved(), { basePresetId: 'base' });
    expect(result.adoptionMode).toBe('latest');
    expect(result.base).toMatchObject({ revision: 2, updates: [] });
    expect(result.skills.map((asset) => asset.assetId)).toEqual(['review', 'notes']);
    expect(result.instruction?.revision).toBe(2);
  });

  it('hold resolves exactly what was held and reports what is available, applying none of it', () => {
    const result = plan(moved(), { basePresetId: 'base' }, held);
    expect(result.adoptionMode).toBe('hold');
    expect(result.base).toMatchObject({ revision: 1, headRevision: 2 });
    expect(result.base?.updates).toEqual([
      { assetId: 'base', kind: 'preset', resolvedRevision: 1, headRevision: 2 },
      { assetId: 'doc', kind: 'instruction', resolvedRevision: 1, headRevision: 2 },
    ]);
    expect(result.instruction?.revision).toBe(1);
    expect(result.skills.map((asset) => asset.assetId)).toEqual(['review']);
    expect(noticeCodes(result)).toEqual(['base_revision_available', 'base_revision_available']);
    expect(result.blockers).toEqual([]);
  });

  it('a hold that leaves something out, or names a revision gone, blocks rather than guessing', () => {
    expect(blockerCodes(plan(moved(), { basePresetId: 'base' }, { mode: 'hold', revisions: { base: 1, doc: 1, git: 1 } }))).toEqual(['hold_incomplete']);
    expect(blockerCodes(plan(moved(), { basePresetId: 'base' }, { mode: 'hold', revisions: { ...held.revisions, doc: 9 } }))).toEqual(['revision_unavailable']);
  });

  it('additions follow latest even under a hold, and a disagreement over one asset blocks', () => {
    const index = moved();
    expect(plan(index, { additions: ['doc'] }, held).blockers).toEqual([{ code: 'invalid_addition_kind', assetIds: ['doc'] }]);
    const result = plan(index, { basePresetId: 'base', instructionAssetId: 'doc' }, held);
    expect(blockerCodes(result)).toEqual(['conflicting_revisions']);
  });
});

describe('copies report their origin', () => {
  const copy = (originRevision: number): CatalogEntry => entry('fork', [instruction()], {
    owner: { kind: 'agent', agentId: 'agent-1' },
    source: { kind: 'copy', originAssetId: 'doc', originRevision },
  });

  it('reports a newer origin revision and changes nothing', () => {
    const index = indexOf([entry('doc', [instruction(), instruction()]), copy(1)]);
    const before = JSON.stringify(index);
    const result = plan(index, { instructionAssetId: 'fork' });
    expect(result.instruction).toMatchObject({
      assetId: 'fork',
      revision: 1,
      origin: { originAssetId: 'doc', originRevision: 1, originHeadRevision: 2, newerRevisionAvailable: true, originDeleted: false },
    });
    expect(result.notices).toEqual([{ code: 'origin_newer_revision', assetIds: ['fork'] }]);
    expect(result.blockers).toEqual([]);
    expect(JSON.stringify(index)).toBe(before);
  });

  it('says nothing when the origin has not moved', () => {
    const index = indexOf([entry('doc', [instruction()]), copy(1)]);
    const result = plan(index, { instructionAssetId: 'fork' });
    expect(result.notices).toEqual([]);
    expect(result.instruction?.origin?.newerRevisionAvailable).toBe(false);
  });

  it('keeps working when the origin is deleted', () => {
    const index = indexOf([entry('doc', [instruction()], { deletedAt: 't' }), copy(1)]);
    const result = plan(index, { instructionAssetId: 'fork' });
    expect(result.blockers).toEqual([]);
    expect(result.notices).toEqual([{ code: 'origin_deleted', assetIds: ['fork'] }]);
    expect(result.instruction?.origin).toMatchObject({ originHeadRevision: null, originDeleted: true });
  });
});

describe('determinism', () => {
  it('is the same plan whatever order the inputs came in', () => {
    const assets = [
      entry('doc', [instruction()]),
      entry('review', [skill('code-review')]),
      entry('notes', [skill('release-notes')]),
      entry('git', [mcp('git')]),
      entry('workiq', [mcp('workiq')]),
      entry('base', [preset('doc', ['review'], ['git'])]),
    ];
    const one = plan(indexOf(assets), { basePresetId: 'base', additions: ['notes', 'workiq'], removals: ['git', 'nope'] });
    const two = plan(indexOf([...assets].reverse()), { basePresetId: 'base', additions: ['workiq', 'notes'], removals: ['nope', 'git'] });
    expect(two.fingerprint).toBe(one.fingerprint);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('the fingerprint moves with anything that changes the outcome', () => {
    const base = plan(library(), { basePresetId: 'base' }).fingerprint;
    expect(plan(library(), { basePresetId: 'base', additions: ['notes'] }).fingerprint).not.toBe(base);
    expect(plan(library(), { basePresetId: 'base' }, LATEST, [{ key: 'mcp/other', owner: 'native' }]).fingerprint).not.toBe(base);
    expect(plan(library([]), { basePresetId: 'base' }, LATEST, undefined, 'agent-2').fingerprint).not.toBe(base);
    const moved = library();
    moved.assets.review = entry('review', [skill('code-review'), skill('code-review')]);
    expect(plan(moved, { basePresetId: 'base' }).fingerprint).not.toBe(base);
  });

  it('a rename does not move the fingerprint: nothing projected changed', () => {
    const renamed = library();
    renamed.assets.review = { ...renamed.assets.review, name: 'Another name' };
    const result = plan(renamed, { basePresetId: 'base' });
    expect(result.fingerprint).toBe(plan(library(), { basePresetId: 'base' }).fingerprint);
    expect(result.skills[0].name).toBe('Another name');
    expect(result.skills[0].assetId).toBe('review');
  });

  it('upstream versions stay separate from catalog revisions', () => {
    const projection = mcp('workiq', { upstream: { package: '@microsoft/workiq', floating: true } });
    const result = plan(indexOf([entry('w', [projection])]), { additions: ['w'] });
    expect(result.mcpServers[0].revision).toBe(1);
    expect(result.mcpServers[0].projection).toMatchObject({ upstream: { package: '@microsoft/workiq', floating: true } });
  });
});

describe('the activation plan', () => {
  it('is provider-neutral and whole', () => {
    const result = plan(library(), { basePresetId: 'base', additions: ['workiq'] });
    expect(result.activation).toMatchObject({ agentId: 'agent-1', fingerprint: result.fingerprint, base: { presetId: 'base', revision: 1 } });
    expect(result.activation?.assets.find((asset) => asset.assetId === 'workiq')?.requires).toEqual({ envVars: ['WORKIQ_HOME'], auth: 'external' });
    const text = JSON.stringify(result.activation);
    for (const nativeWord of ['.claude', '.codex', '.github', '.mcp.json', 'CLAUDE.md', 'AGENTS.md', 'copilot', 'provider', 'worktree', 'sessionId']) {
      expect(text).not.toContain(nativeWord);
    }
  });

  it('is withheld entirely while anything blocks', () => {
    const index = library([entry('git-2', [mcp('git')])]);
    const result = plan(index, { basePresetId: 'base', additions: ['git-2', 'notes'] });
    expect(result.activation).toBeNull();
    expect(result.skills.length).toBeGreaterThan(0);
  });
});

describe('consumers', () => {
  const index = () => indexOf(
    [
      ...Object.values(library().assets),
      entry('other-doc', [instruction()]),
      entry('fork', [instruction()], { owner: { kind: 'agent', agentId: 'forker' }, source: { kind: 'copy', originAssetId: 'doc', originRevision: 1 } }),
    ],
    [
      composition('linked', { basePresetId: 'base' }),
      composition('excluder', { basePresetId: 'base', removals: ['review'] }),
      composition('forker', { basePresetId: 'base', instructionAssetId: 'fork' }),
      composition('adder', { additions: ['review'] }),
      composition('other'),
    ],
  );

  it('lists every relation to a skill, exclusions included', () => {
    const consumers = listConsumers(index(), 'review');
    expect(consumers.presets).toEqual([{ presetId: 'base', role: 'skill' }]);
    expect(consumers.agents).toEqual([
      { agentId: 'adder', relations: ['addition'], effective: true },
      { agentId: 'excluder', relations: ['excluded'], effective: false },
      { agentId: 'forker', relations: ['via-base'], effective: true },
      { agentId: 'linked', relations: ['via-base'], effective: true },
    ]);
    expect(hasHardReference(consumers)).toBe(true);
  });

  it('lists overrides and copies of an instruction', () => {
    const consumers = listConsumers(index(), 'doc');
    expect(consumers.presets).toEqual([{ presetId: 'base', role: 'instruction' }]);
    expect(consumers.agents.find((agent) => agent.agentId === 'forker')).toEqual({ agentId: 'forker', relations: ['overridden'], effective: false });
    expect(consumers.copies).toEqual([{ assetId: 'fork', agentId: 'forker', originRevision: 1 }]);
  });

  it('lists the agents linked to a preset', () => {
    expect(listConsumers(index(), 'base').agents.map((agent) => [agent.agentId, agent.relations])).toEqual([
      ['excluder', ['base-preset']],
      ['forker', ['base-preset']],
      ['linked', ['base-preset']],
    ]);
  });

  it('an exclusion alone is no reason to refuse deletion', () => {
    const only = indexOf(
      [entry('loner', [skill('loner')])],
      [composition('a', { removals: ['loner'] })],
    );
    const consumers = listConsumers(only, 'loner');
    expect(consumers.agents).toEqual([{ agentId: 'a', relations: ['excluded'], effective: false }]);
    expect(hasHardReference(consumers)).toBe(false);
  });

  it('nothing refers to an unassigned asset', () => {
    const consumers = listConsumers(index(), 'notes');
    expect(consumers).toEqual({ assetId: 'notes', presets: [], agents: [], copies: [] });
    expect(hasHardReference(consumers)).toBe(false);
  });
});

describe('impact of a central edit', () => {
  const index = () => indexOf(
    [
      ...Object.values(library().assets),
      entry('fork', [skill('fork')], { owner: { kind: 'agent', agentId: 'owner' }, source: { kind: 'copy', originAssetId: 'review', originRevision: 1 } }),
      entry('rival', [skill('rival')]),
    ],
    [
      composition('linked', { basePresetId: 'base' }),
      composition('excluder', { basePresetId: 'base', removals: ['review'] }),
      composition('adder', { additions: ['review', 'rival'] }),
    ],
  );
  const candidate = (projection: AssetProjection, revision = 2): AssetRevisionRecord => ({ revision, savedAt: 'later', contentHash: 'next-hash', projection });

  it('previews every consumer with what moves for each, leaving the index alone', () => {
    const current = index();
    const before = JSON.stringify(current);
    const impact = previewAssetImpact(current, 'review', candidate(skill('code-review')));
    expect(JSON.stringify(current)).toBe(before);
    expect(impact).toMatchObject({ assetId: 'review', fromRevision: 1, toRevision: 2, blocked: false });
    expect(impact.presets).toEqual([{ presetId: 'base', role: 'skill' }]);
    expect(impact.copies).toEqual([{ assetId: 'fork', agentId: 'owner', originRevision: 1 }]);
    const byAgent = Object.fromEntries(impact.agents.map((agent) => [agent.agentId, agent]));
    expect(Object.keys(byAgent)).toEqual(['adder', 'excluder', 'linked']);
    expect(byAgent.linked.changes).toEqual([{ assetId: 'review', fromRevision: 1, toRevision: 2, destination: 'skills/code-review' }]);
    expect(byAgent.excluder).toMatchObject({ effective: false, changes: [], relations: ['excluded'] });
  });

  it('shows a destination move as a change', () => {
    const impact = previewAssetImpact(index(), 'review', candidate(skill('renamed-skill')));
    const linked = impact.agents.find((agent) => agent.agentId === 'linked')!;
    expect(linked.changes).toEqual([{ assetId: 'review', fromRevision: 1, toRevision: 2, destination: 'skills/renamed-skill' }]);
    expect(linked.destinations).toContain('skills/renamed-skill');
    expect(linked.destinations).not.toContain('skills/code-review');
  });

  it('an edit that would collide for one consumer blocks and names it', () => {
    const impact = previewAssetImpact(index(), 'review', candidate(skill('rival')));
    expect(impact.blocked).toBe(true);
    const adder = impact.agents.find((agent) => agent.agentId === 'adder')!;
    expect(adder.newBlockers).toEqual([{ code: 'destination_collision', assetIds: ['review', 'rival'], destination: 'skills/rival' }]);
    expect(impact.agents.find((agent) => agent.agentId === 'linked')!.newBlockers).toEqual([]);
  });

  it('a blocker that was already there is not blamed on this edit', () => {
    const stuck = indexOf(
      [entry('one', [skill('same')]), entry('two', [skill('same')]), entry('lone', [mcp('lone')])],
      [composition('a', { additions: ['one', 'two', 'lone'] })],
    );
    const impact = previewAssetImpact(stuck, 'lone', candidate(mcp('lone')));
    expect(impact.blocked).toBe(false);
    expect(impact.agents[0].newBlockers).toEqual([]);
  });

  it('a preset edit reaches its linked agents', () => {
    const impact = previewAssetImpact(index(), 'base', candidate(preset('doc', ['review', 'notes'], ['git'])));
    const linked = impact.agents.find((agent) => agent.agentId === 'linked')!;
    expect(linked.relations).toEqual(['base-preset']);
    expect(linked.changes).toEqual([{ assetId: 'notes', fromRevision: null, toRevision: 1, destination: 'skills/release-notes' }]);
  });

  it('reports agents sharing a workspace, and blocks when an edit would make them diverge', () => {
    const shared = indexOf(
      [entry('shared-skill', [skill('same')]), entry('private', [skill('private')])],
      [composition('a', { additions: ['shared-skill'] }), composition('b', { additions: ['shared-skill'] }), composition('c', { additions: ['private'] })],
    );
    const context = { workspaceByAgent: { a: 'w1', b: 'w1', c: 'w1' } };
    const agree = previewAssetImpact(shared, 'shared-skill', candidate(skill('same')), context);
    expect(agree.blocked).toBe(false);
    expect(agree.sharedDestinations).toEqual([{
      workspaceKey: 'w1',
      destination: 'skills/same',
      agents: [{ agentId: 'a', assetId: 'shared-skill', revision: 2 }, { agentId: 'b', assetId: 'shared-skill', revision: 2 }],
      divergent: false,
    }]);

    const diverge = previewAssetImpact(shared, 'private', candidate(skill('same')), context);
    expect(diverge.blocked).toBe(true);
    expect(diverge.sharedDestinations[0].divergent).toBe(true);
  });

  it('separate workspaces, or none known, do not share', () => {
    const shared = indexOf(
      [entry('one', [skill('same')]), entry('two', [skill('same')])],
      [composition('a', { additions: ['one'] }), composition('b', { additions: ['two'] })],
    );
    expect(previewAssetImpact(shared, 'one', candidate(skill('same'))).sharedDestinations).toEqual([]);
    expect(previewAssetImpact(shared, 'one', candidate(skill('same')), { workspaceByAgent: { a: 'w1', b: 'w2' } }).sharedDestinations).toEqual([]);
    expect(previewAssetImpact(shared, 'one', candidate(skill('same')), { workspaceByAgent: { a: 'w1' } }).sharedDestinations).toEqual([]);
  });

  it('considers what each agent already has natively', () => {
    const impact = previewAssetImpact(index(), 'review', candidate(skill('taken')), { foreignByAgent: { linked: [{ key: 'skills/taken', owner: 'native' }] } });
    expect(impact.blocked).toBe(true);
    expect(impact.agents.find((agent) => agent.agentId === 'linked')?.newBlockers[0]).toMatchObject({ code: 'foreign_destination_collision', foreignOwner: 'native' });
  });

  it('the fingerprint moves with the content and the consumers, not with a new copy', () => {
    const base = previewAssetImpact(index(), 'review', candidate(skill('code-review'))).fingerprint;
    expect(previewAssetImpact(index(), 'review', { ...candidate(skill('code-review')), contentHash: 'other' }).fingerprint).not.toBe(base);
    const moreConsumers = index();
    moreConsumers.compositions.another = composition('another', { additions: ['review'] });
    expect(previewAssetImpact(moreConsumers, 'review', candidate(skill('code-review'))).fingerprint).not.toBe(base);
    const moreCopies = index();
    moreCopies.assets['fork-2'] = entry('fork-2', [skill('fork-2')], { owner: { kind: 'agent', agentId: 'x' }, source: { kind: 'copy', originAssetId: 'review', originRevision: 1 } as AssetSource });
    expect(previewAssetImpact(moreCopies, 'review', candidate(skill('code-review'))).fingerprint).toBe(base);
  });
});

describe('findSharedDestinations', () => {
  it('compares destinations case-insensitively', () => {
    const index = indexOf([entry('one', [skill('Same')]), entry('two', [skill('same')])]);
    const plans = [plan(index, { additions: ['one'] }, LATEST, undefined, 'a'), plan(index, { additions: ['two'] }, LATEST, undefined, 'b')];
    expect(findSharedDestinations(plans, { a: 'w', b: 'w' })).toEqual([{
      workspaceKey: 'w',
      destination: 'skills/Same',
      agents: [{ agentId: 'a', assetId: 'one', revision: 1 }, { agentId: 'b', assetId: 'two', revision: 1 }],
      divergent: true,
    }]);
  });
});
