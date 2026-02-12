import { PaneNode } from '../../stores/hubStore';
import { HubPane } from './HubPane';

interface Props {
  node: PaneNode;
  onCloseConfirm: (paneId: string, agentId: string) => void;
}

export function PaneContainer({ node, onCloseConfirm }: Props) {
  if (node.type === 'leaf') {
    return <HubPane paneId={node.id} agentId={node.agentId} onCloseConfirm={onCloseConfirm} />;
  }

  const isHorizontal = node.direction === 'horizontal';

  return (
    <div className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} h-full w-full overflow-hidden`}>
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <PaneContainer node={node.children[0]} onCloseConfirm={onCloseConfirm} />
      </div>
      <div className={`flex-shrink-0 ${isHorizontal ? 'w-px' : 'h-px'} bg-surface-0`} />
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <PaneContainer node={node.children[1]} onCloseConfirm={onCloseConfirm} />
      </div>
    </div>
  );
}
