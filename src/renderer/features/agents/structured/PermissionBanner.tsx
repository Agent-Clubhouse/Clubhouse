import { useState, useEffect, useRef } from 'react';
import type { PermissionRequest } from '../../../../shared/structured-events';

const TIMEOUT_SECONDS = 120;

interface Props {
  request: PermissionRequest;
  onRespond: (requestId: string, approved: boolean) => void;
}

/**
 * Renders a permission_request event with native approve/deny buttons
 * and a countdown timer matching the CLI's 120s timeout.
 */
export function PermissionBanner({ request, onRespond }: Props) {
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);
  const respondedRef = useRef(false);

  useEffect(() => {
    const tick = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(tick);
          // Auto-deny on timeout
          if (!respondedRef.current) {
            respondedRef.current = true;
            onRespond(request.id, false);
          }
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [request.id, onRespond]);

  const handleRespond = (approved: boolean) => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    onRespond(request.id, approved);
  };

  const primaryInput = getPrimaryPermissionInput(request);

  return (
    <div
      className="border border-yellow-500/40 bg-yellow-500/5 rounded-lg overflow-hidden"
      data-testid="permission-banner"
      data-request-id={request.id}
    >
      <div className="px-4 py-3">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <svg className="w-4 h-4 text-yellow-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1L1 14h14L8 1z" />
            <line x1="8" y1="6" x2="8" y2="9" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
          </svg>
          <span className="text-sm font-medium text-yellow-400">Permission Required</span>
          <span className="ml-auto text-xs text-ctp-subtext0 tabular-nums">{remaining}s</span>
        </div>

        {/* Tool info */}
        <div className="space-y-1 mb-3">
          <div className="text-xs text-ctp-subtext0">
            <span className="text-ctp-subtext1">Tool: </span>
            <span className="font-mono text-ctp-text">{request.toolName}</span>
          </div>
          {primaryInput && (
            <pre className="text-xs text-ctp-subtext1 font-mono bg-ctp-mantle rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-words">
              {primaryInput}
            </pre>
          )}
          {request.description && (
            <p className="text-xs text-ctp-subtext0">{request.description}</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center justify-end gap-2">
          <button
            className="px-3 py-1 text-xs rounded border border-surface-1 text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text transition-colors cursor-pointer"
            onClick={() => handleRespond(false)}
            data-testid="permission-deny"
          >
            Deny
          </button>
          <button
            className="px-3 py-1 text-xs rounded bg-indigo-500 text-white hover:bg-indigo-600 transition-colors cursor-pointer"
            onClick={() => handleRespond(true)}
            data-testid="permission-approve"
          >
            Approve
          </button>
        </div>
      </div>

      {/* Countdown bar */}
      <div className="h-0.5 bg-surface-0">
        <div
          className="h-full bg-yellow-500/60 transition-all duration-1000 ease-linear"
          style={{ width: `${(remaining / TIMEOUT_SECONDS) * 100}%` }}
        />
      </div>
    </div>
  );
}

function getPrimaryPermissionInput(req: PermissionRequest): string | null {
  const { toolInput } = req;
  if (typeof toolInput.command === 'string') return toolInput.command;
  if (typeof toolInput.file_path === 'string') return toolInput.file_path;
  if (Object.keys(toolInput).length > 0) return JSON.stringify(toolInput, null, 2);
  return null;
}
