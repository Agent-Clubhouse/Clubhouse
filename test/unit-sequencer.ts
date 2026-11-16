import * as path from 'path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { partitionByWeight } from './unit-shards.mjs';

/** A spec's path relative to the repo, with forward slashes, as test/unit-shards.mjs keys it. */
export function specKey(root: string, moduleId: string): string {
  return path.relative(root, moduleId).split(path.sep).join('/');
}

/**
 * `--shard=i/n` by measured time rather than by file count (test/unit-shards.mjs).
 * Ordering within a shard is vitest's own.
 */
export class UnitShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const { index, count } = config.shard!;
    // A file in two projects is two specs with one key; both go wherever the key goes.
    const keyOf = (spec: TestSpecification) => specKey(config.root, spec.moduleId);
    const mine = new Set(partitionByWeight(files.map(keyOf), count)[index - 1]);
    return files.filter((spec) => mine.has(keyOf(spec)));
  }
}
