import * as fs from 'fs';
import { HANDOFF_TRANSFER_DEFAULTS } from '../../shared/handoff-manifest';
import { prepareHandoffBundle } from './handoff-git-bundle';
import { HandoffSnapshotError, openHandoffRepository, prepareHandoffSnapshot, type HandoffSnapshot, type PrepareHandoffSnapshot } from './handoff-snapshot';

/** A frozen manifest and fallback bundle are complete before any transfer can begin. */
export async function prepareHandoffTransfer(options: PrepareHandoffSnapshot & { mode: 'branch' | 'worktree' }): Promise<HandoffSnapshot> {
  const repository = await openHandoffRepository(options.worktreeRoot);
  const cleanBranch = async () => {
    const status = await repository.read(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    if (status === null) throw new HandoffSnapshotError('git_failed');
    if (status.byteLength) throw new HandoffSnapshotError('uncommitted_branch');
  };
  if (options.mode === 'branch') await cleanBranch();
  let snapshot: HandoffSnapshot | undefined;
  try {
    snapshot = await prepareHandoffSnapshot({ ...options,
      ...(options.mode === 'branch' && { include: { tracked_changes: false, untracked: false, ignored: [] }, exclude: [] }),
    });
    snapshot = await prepareHandoffBundle({ worktreeRoot: options.worktreeRoot, snapshot, bounds: options.bounds ?? HANDOFF_TRANSFER_DEFAULTS,
      handoffId: options.handoffId, secretPolicy: options.secretPolicy });
    if (options.mode === 'branch') await cleanBranch();
    await repository.assertCurrent(); options.secretPolicy?.assertCurrent();
    return snapshot;
  } catch (error) {
    if (snapshot) await fs.promises.rm(snapshot.root, { recursive: true, force: true });
    throw error;
  }
}
