import type { DeleteAgentReviewTarget, DeleteAgentsReview as Review } from '../../../shared/delete-agents';

function Target({ target, remove }: { target: DeleteAgentReviewTarget; remove: boolean }) {
  const work = target.work;
  return <div className="text-xs text-ctp-subtext1 break-words">
    <p>{target.name} ({target.agentId}) in {target.project}</p>
    <p>{target.worktreePath ? `${remove ? 'Remove' : 'Keep'} ${target.worktreePath}.` : 'No own worktree.'} {target.branch ? remove && target.worktreePath ? `Remove branch ${target.branch} only if Clubhouse owns it and the existing branch safety checks allow it. Otherwise keep it.` : `Keep branch ${target.branch}.` : 'No recorded branch.'}</p>
    {work?.checkError && <p>Could not check its work. {work.checkError}</p>}
    {work && <p>{work.uncommittedFiles.length} uncommitted {work.uncommittedFiles.length === 1 ? 'file' : 'files'} and {work.unpushedCommits.length} unpushed {work.unpushedCommits.length === 1 ? 'commit' : 'commits'}{remove ? ' at risk when removed' : ' stay on disk'}.</p>}
    {work && (work.uncommittedFiles.length > 0 || work.unpushedCommits.length > 0) && <details>
      <summary className="cursor-pointer">Review work</summary>
      <ul className="pl-4 list-disc">
        {work.uncommittedFiles.map((file, index) => <li key={`file-${index}`}>{file.path} ({file.status})</li>)}
        {work.unpushedCommits.map((commit) => <li key={commit.hash}>{commit.shortHash} {commit.subject}</li>)}
      </ul>
    </details>}
  </div>;
}

export function DeleteAgentsReview({ review }: { review: Review }) {
  return <div className="flex flex-col gap-2" aria-label="Deletion batch review">
    <p className="text-ctp-subtext1">Allow approves all ready targets together. Refused targets stay. Running agents and quick agents in their worktrees are stopped. This approval expires after 24 hours and must be answered on this computer.</p>
    <ol className="flex flex-col gap-3 list-decimal pl-5">
      {review.items.map((item) => <li key={item.index} className="border-b border-surface-0 pb-2">
        <p className="text-ctp-text">{item.status === 'ready' ? 'Ready to delete' : 'Refused'} {item.target?.name ?? item.requestedAgent} in {item.requestedProject}</p>
        {item.reason && <p className="text-xs text-ctp-subtext1">{item.reason}</p>}
        {item.target && <Target target={item.target} remove={item.worktree === 'delete'} />}
        <p className="text-xs text-ctp-subtext1">{item.force ? 'Force is explicitly enabled for this target and its disposed helpers. Only the reviewed work may be lost.' : 'Uncommitted or unpushed work prevents removing files.'} {item.helpers === 'dispose' ? 'Dispose its helpers and their helpers.' : 'Keep helpers and release its direct helpers as ordinary agents.'}</p>
        {item.helperTargets.length > 0 && <ul className="mt-1 pl-4 list-disc">
          {item.helperTargets.map((helper) => <li key={`${helper.project}/${helper.agentId}`}><Target target={helper} remove={item.helpers === 'dispose'} /></li>)}
        </ul>}
      </li>)}
    </ol>
  </div>;
}
