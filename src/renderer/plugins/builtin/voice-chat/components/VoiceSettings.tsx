import React, { useEffect, useState, useCallback } from 'react';
import type { PluginAPI, VoiceDownloadProgress } from '../../../../../shared/plugin-types';
import { voiceState } from '../state';

export function VoiceSettings({ api }: { api: PluginAPI }) {
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<VoiceDownloadProgress | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const models = await api.voice.checkModels();
      const ready = models.every((m) => m.ready);
      setModelsReady(ready);
    } catch {
      setModelsReady(false);
    }
  }, [api]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.voice.deleteModels();
      voiceState.setModelsReady(false);
      setModelsReady(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [api]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);

    const progressSub = api.voice.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      await api.voice.downloadModels();
      voiceState.setModelsReady(true);
      setModelsReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      progressSub.dispose();
      setDownloading(false);
      setDownloadProgress(null);
    }
  }, [api]);

  const statusText = modelsReady === null ? 'Checking...' : modelsReady ? 'Ready' : 'Not downloaded';
  const statusColor = modelsReady ? 'var(--ctp-green, #a6e3a1)' : 'var(--ctp-subtext0, #a6adc8)';

  return React.createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px' },
  },
    React.createElement('div', null,
      React.createElement('span', {
        style: { fontSize: '12px', color: 'var(--ctp-subtext1, #bac2de)' },
      }, 'Voice model status: '),
      React.createElement('span', {
        style: { fontSize: '12px', fontWeight: 500, color: statusColor },
      }, statusText),
    ),

    downloading
      ? React.createElement('div', { style: { maxWidth: '240px' } },
          React.createElement('div', {
            style: { fontSize: '11px', color: 'var(--ctp-subtext0, #a6adc8)', marginBottom: '4px' },
          },
            downloadProgress
              ? `Downloading ${downloadProgress.model}... ${downloadProgress.percent}%`
              : 'Starting download...',
          ),
          React.createElement('div', {
            style: {
              width: '100%', height: '6px',
              backgroundColor: 'var(--ctp-surface0, #313244)',
              borderRadius: '3px', overflow: 'hidden',
            },
          },
            React.createElement('div', {
              style: {
                height: '100%',
                backgroundColor: 'var(--ctp-blue, #89b4fa)',
                width: `${downloadProgress?.percent || 0}%`,
                transition: 'width 0.3s',
              },
            }),
          ),
        )
      : React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          React.createElement('button', {
            style: {
              padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: 'none',
              cursor: deleting ? 'not-allowed' : 'pointer',
              backgroundColor: modelsReady ? 'var(--ctp-red, #f38ba8)' : 'var(--ctp-surface1, #45475a)',
              color: modelsReady ? 'var(--ctp-base, #1e1e2e)' : 'var(--ctp-subtext0, #a6adc8)',
              opacity: !modelsReady || deleting ? 0.5 : 1,
            },
            disabled: !modelsReady || deleting,
            onClick: handleDelete,
          }, deleting ? 'Deleting...' : 'Delete Models'),

          React.createElement('button', {
            style: {
              padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: 'none',
              cursor: modelsReady ? 'not-allowed' : 'pointer',
              backgroundColor: !modelsReady ? 'var(--ctp-blue, #89b4fa)' : 'var(--ctp-surface1, #45475a)',
              color: !modelsReady ? 'var(--ctp-base, #1e1e2e)' : 'var(--ctp-subtext0, #a6adc8)',
              opacity: modelsReady ? 0.5 : 1,
            },
            disabled: modelsReady === true,
            onClick: handleDownload,
          }, 'Download Models'),
        ),

    error && React.createElement('div', {
      style: { fontSize: '11px', color: 'var(--ctp-red, #f38ba8)' },
    }, `${error} — check logs for details`),
  );
}
