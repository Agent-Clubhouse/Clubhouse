import * as path from 'path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { fileSeconds, partitionByWeight } from './unit-shards.mjs';

/** A spec's path relative to the repo, with forward slashes, as test/unit-shards.mjs keys it. */
export function specKey(root: string, moduleId: string): string {
  return path.relative(root, moduleId).split(path.sep).join('/');
}

/**
 * `--shard=i/n` by measured time rather than by file count (test/unit-shards.mjs),
 * and heaviest first within the shard. A run without `--shard` keeps vitest's order.
 */
export class UnitShardSequencer extends BaseSequencer {
  private keyOf(spec: TestSpecification): string {
    return specKey(this.ctx.config.root, spec.moduleId);
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    // A file in two projects is two specs with one key; both go wherever the key goes.
    const mine = new Set(partitionByWeight(files.map((spec) => this.keyOf(spec)), count)[index - 1]);
    return files.filter((spec) => mine.has(this.keyOf(spec)));
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    if (!this.ctx.config.shard) return sorted;
    // CI has no vitest cache, so vitest's own order is by file size. groupOrder still
    // comes first; Array#sort is stable, so equal weights keep vitest's order.
    const groupOrder = (spec: TestSpecification) => spec.project.config.sequence.groupOrder;
    return sorted.sort((a, b) => groupOrder(a) - groupOrder(b) || fileSeconds(this.keyOf(b)) - fileSeconds(this.keyOf(a)));
  }
}
