import { PaneNode } from '../../stores/hubStore';
import { HubPane } from './HubPane';

interface Props {
  node: PaneNode;
}

export function PaneContainer({ node }: Props) {
  if (node.type === 'leaf') {
    return <HubPane paneId={node.id} agentId={node.agentId} />;
  }

  const isHorizontal = node.direction === 'horizontal';

  return (
    <div className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} h-full w-full overflow-hidden`}>
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <PaneContainer node={node.children[0]} />
      </div>
      <div className={`flex-shrink-0 ${isHorizontal ? 'w-px' : 'h-px'} bg-surface-0`} />
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <PaneContainer node={node.children[1]} />
      </div>
    </div>
  );
}
