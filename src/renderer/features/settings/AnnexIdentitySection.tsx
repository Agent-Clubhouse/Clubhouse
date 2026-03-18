import { AGENT_COLORS } from '../../../shared/name-generator';
import type { AnnexSettings, AnnexStatus } from '../../../shared/types';

interface Props {
  settings: AnnexSettings;
  status: AnnexStatus;
  onSave: (settings: AnnexSettings) => void;
}

export function AnnexIdentitySection({ settings, status, onSave }: Props) {
  return (
    <div className="space-y-3">
      {/* Alias */}
      <div className="py-3 border-b border-surface-0">
        <div className="text-sm text-ctp-text font-medium mb-2">Alias</div>
        <input
          type="text"
          value={settings.alias}
          onChange={(e) => onSave({ ...settings, alias: e.target.value })}
          className="w-full px-3 py-1.5 text-sm rounded bg-surface-0 border border-surface-1
            text-ctp-text placeholder-ctp-subtext0 focus:outline-none focus:border-indigo-500"
          placeholder="My Mac"
        />
      </div>

      {/* Color picker */}
      <div className="py-3 border-b border-surface-0">
        <div className="text-sm text-ctp-text font-medium mb-2">Color</div>
        <div className="flex gap-2">
          {AGENT_COLORS.map((color) => (
            <button
              key={color.id}
              onClick={() => onSave({ ...settings, color: color.id })}
              className={`w-7 h-7 rounded-full transition-all cursor-pointer ${
                settings.color === color.id
                  ? 'ring-2 ring-offset-2 ring-offset-ctp-base scale-110'
                  : 'hover:scale-105'
              }`}
              style={{
                backgroundColor: color.hex,
                ...(settings.color === color.id ? { ringColor: color.hex } : {}),
              }}
              title={color.label}
            />
          ))}
        </div>
      </div>

      {/* Fingerprint */}
      {status.fingerprint && (
        <div className="py-3 border-b border-surface-0">
          <div className="text-sm text-ctp-text font-medium mb-1">Fingerprint</div>
          <div className="text-xs font-mono text-ctp-subtext0 select-all">
            {status.fingerprint}
          </div>
        </div>
      )}
    </div>
  );
}
