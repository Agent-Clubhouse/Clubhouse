import { useState, useEffect } from 'react';
import { SUPPORTED_API_VERSIONS } from '../../plugins/manifest-validator';

interface ArchInfo {
  arch: string;
  platform: string;
  rosetta: boolean;
}

function formatArch(info: ArchInfo): string {
  if (info.rosetta) return `${info.arch} (Rosetta)`;
  return info.arch;
}

export function AboutSettingsView() {
  const [appVersion, setAppVersion] = useState('');
  const [archInfo, setArchInfo] = useState<ArchInfo | null>(null);

  useEffect(() => {
    window.clubhouse.app.getVersion().then(setAppVersion);
    window.clubhouse.app.getArchInfo().then(setArchInfo);
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">About</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">App version and compatibility information.</p>

        <div className="space-y-4">
          <div>
            <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2">Application</h3>
            <p className="text-sm text-ctp-text">Clubhouse v{appVersion}</p>
          </div>

          {archInfo && (
            <>
              <div className="border-t border-surface-0" />
              <div>
                <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2">Architecture</h3>
                <p className="text-sm text-ctp-text">{formatArch(archInfo)}</p>
                {archInfo.rosetta && (
                  <p className="text-xs text-ctp-peach mt-1">
                    This app is running under Rosetta translation. An arm64 build is available for better performance on Apple Silicon.
                  </p>
                )}
              </div>
            </>
          )}

          <div className="border-t border-surface-0" />

          <div>
            <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2">Supported Plugin API Versions</h3>
            <p className="text-sm text-ctp-text">{SUPPORTED_API_VERSIONS.join(', ')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
