import { useUIStore } from '../../stores/uiStore';
import { GitDiffViewer } from './GitDiffViewer';
import { GitLog } from './GitLog';

export function GitMainView() {
  const selectedGitFile = useUIStore((s) => s.selectedGitFile);
  return selectedGitFile ? <GitDiffViewer /> : <GitLog />;
}
