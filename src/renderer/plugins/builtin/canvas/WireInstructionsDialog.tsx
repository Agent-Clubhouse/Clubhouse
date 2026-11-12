import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { ConnectionEditorDialog } from '../../../features/agents/helpers/ConnectionEditorDialog';

export function WireInstructionsDialog({ binding, onClose }: { binding: McpBindingEntry; onClose: () => void }) {
  return <ConnectionEditorDialog binding={binding} onClose={onClose} />;
}
