import type { ImportedAgentReview, ImportPlan } from '../../../shared/project-import';

export function ImportReview({ plan }: { plan: ImportPlan }) {
  return <div className="rounded bg-ctp-mantle p-2 text-xs flex flex-col gap-1 break-words" data-testid="import-review">
    <strong>Import this exact repository into a NEW directory</strong>
    <p>Repository: {plan.url}</p>
    <p>Destination: {plan.destination}</p>
    <p>Existing parent: {plan.parent} (identity {plan.parentIdentity})</p>
    <p>Default branch: {plan.defaultBranch}</p>
    <p>Selected branch: {plan.branch}</p>
    <p>Selected commit: {plan.commit}</p>
    <p>Default tip: {plan.headCommit}</p>
    <p>Review expires: {new Date(plan.expiresAt).toLocaleString()}</p>
    {plan.effects.map((effect) => <p key={effect}>{effect}</p>)}
    <p>Only this caller and immutable plan are approved. Changed metadata, placement, access or choices require renewed review.</p>
  </div>;
}

export function ImportAgentReview({ review }: { review: ImportedAgentReview }) {
  const settings = review.settings;
  return <div className="rounded bg-ctp-mantle p-2 text-xs flex flex-col gap-1 break-words" data-testid="import-agent-review">
    <strong>Create {review.name}, asleep</strong>
    <p>Project: {review.projectPath}</p>
    <p>Template: {review.templateName ?? review.templateId ?? 'From scratch'}</p>
    <p>CLI: {settings.orchestrator}; model: {settings.model}; effort: {settings.effort ?? 'CLI default'}</p>
    <p>Access: {settings.access}; Free Agent Mode: {settings.freeAgentMode ? 'On' : 'Off'}</p>
    <p>Orchestration: {settings.orchestration?.orchestrate ? 'On' : 'Off'}; cross-project helpers: {settings.orchestration?.crossProjectHelpers ? 'On' : 'Off'}</p>
    <p>Connect to Dispatcher: {review.connectToDispatcher ? 'Yes, separately authorized bootstrap' : 'No'}</p>
    {review.effects.map((effect) => <p key={effect}>{effect}</p>)}
    <p>Decline to choose different template/settings with the Dispatcher. Creation is not start approval.</p>
  </div>;
}
