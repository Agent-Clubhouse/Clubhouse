import React from 'react';
import { usePluginStore } from './plugin-store';
import type { PluginSettingDeclaration } from '../../shared/plugin-types';

interface Props {
  pluginId: string;
  settings: PluginSettingDeclaration[];
  scope: string; // 'app' or projectId
}

export function PluginSettingsRenderer({ pluginId, settings, scope }: Props) {
  const pluginSettings = usePluginStore((s) => s.pluginSettings);
  const setPluginSetting = usePluginStore((s) => s.setPluginSetting);

  const settingsKey = `${scope}:${pluginId}`;
  const currentValues = pluginSettings[settingsKey] || {};

  const getValue = (setting: PluginSettingDeclaration): unknown => {
    return currentValues[setting.key] ?? setting.default;
  };

  const handleChange = async (key: string, value: unknown) => {
    setPluginSetting(scope, pluginId, key, value);
    // Persist
    try {
      const updatedValues = { ...currentValues, [key]: value };
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: `settings-${scope}-${pluginId}`,
        value: updatedValues,
      });
    } catch {
      // Storage write failed
    }
  };

  return (
    <div className="space-y-4">
      {settings.map((setting) => {
        const value = getValue(setting);

        if (setting.type === 'boolean') {
          return (
            <div key={setting.key} className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
              <div>
                <div className="text-sm text-ctp-text">{setting.label}</div>
                {setting.description && (
                  <div className="text-xs text-ctp-subtext0 mt-0.5">{setting.description}</div>
                )}
              </div>
              <button
                onClick={() => handleChange(setting.key, !value)}
                className="toggle-track"
                data-on={String(!!value)}
              >
                <span className="toggle-knob" />
              </button>
            </div>
          );
        }

        if (setting.type === 'select' && setting.options) {
          return (
            <div key={setting.key} className="py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
              <div className="text-sm text-ctp-text mb-1">{setting.label}</div>
              {setting.description && (
                <div className="text-xs text-ctp-subtext0 mb-2">{setting.description}</div>
              )}
              <select
                value={String(value ?? '')}
                onChange={(e) => handleChange(setting.key, e.target.value)}
                className="w-full bg-surface-0 text-ctp-text text-sm px-2 py-1.5 rounded border border-surface-2 outline-none focus:border-ctp-accent"
              >
                {setting.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          );
        }

        if (setting.type === 'number') {
          return (
            <div key={setting.key} className="py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
              <div className="text-sm text-ctp-text mb-1">{setting.label}</div>
              {setting.description && (
                <div className="text-xs text-ctp-subtext0 mb-2">{setting.description}</div>
              )}
              <input
                type="number"
                value={String(value ?? '')}
                onChange={(e) => handleChange(setting.key, Number(e.target.value))}
                className="w-full bg-surface-0 text-ctp-text text-sm px-2 py-1.5 rounded border border-surface-2 outline-none focus:border-ctp-accent"
              />
            </div>
          );
        }

        if (setting.type === 'directory') {
          return (
            <div key={setting.key} className="py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
              <div className="text-sm text-ctp-text mb-1">{setting.label}</div>
              {setting.description && (
                <div className="text-xs text-ctp-subtext0 mb-2">{setting.description}</div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={String(value ?? '')}
                  onChange={(e) => handleChange(setting.key, e.target.value)}
                  placeholder="/path/to/directory"
                  className="flex-1 bg-surface-0 text-ctp-text text-sm px-2 py-1.5 rounded border border-surface-2 outline-none focus:border-ctp-accent"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const picked = await window.clubhouse.project.pickDirectory();
                    if (picked != null) {
                      handleChange(setting.key, picked);
                    }
                  }}
                  className="px-3 py-1.5 text-sm bg-surface-0 text-ctp-text rounded border border-surface-2 hover:bg-surface-1 whitespace-nowrap"
                >
                  Browse...
                </button>
              </div>
            </div>
          );
        }

        // Default: string input
        return (
          <div key={setting.key} className="py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
            <div className="text-sm text-ctp-text mb-1">{setting.label}</div>
            {setting.description && (
              <div className="text-xs text-ctp-subtext0 mb-2">{setting.description}</div>
            )}
            <input
              type="text"
              value={String(value ?? '')}
              onChange={(e) => handleChange(setting.key, e.target.value)}
              className="w-full bg-surface-0 text-ctp-text text-sm px-2 py-1.5 rounded border border-surface-2 outline-none focus:border-ctp-accent"
            />
          </div>
        );
      })}
    </div>
  );
}
