interface PopoutHubViewProps {
  projectId?: string;
}

export function PopoutHubView({ projectId }: PopoutHubViewProps) {
  return (
    <div className="w-full h-full flex items-center justify-center bg-ctp-base">
      <div className="text-center">
        <div className="text-ctp-subtext0 text-sm mb-2">
          Hub — Pop-out View
        </div>
        {projectId && (
          <div className="text-ctp-overlay0 text-xs">
            Project: {projectId}
          </div>
        )}
        <div className="text-ctp-overlay0 text-xs mt-4">
          Hub pane tree will render here with independent state.
        </div>
      </div>
    </div>
  );
}
