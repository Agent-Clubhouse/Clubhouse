import { useState } from 'react';
import { PermissionsConfig } from '../../../shared/types';

interface Props {
  value: PermissionsConfig;
  onChange: (value: PermissionsConfig) => void;
  readOnly?: boolean;
}

export function PermissionsEditor({ value, onChange, readOnly }: Props) {
  const [newAllow, setNewAllow] = useState('');
  const [newDeny, setNewDeny] = useState('');

  const allowRules = value.allow || [];
  const denyRules = value.deny || [];

  const addAllow = () => {
    const rule = newAllow.trim();
    if (!rule || allowRules.includes(rule)) return;
    onChange({ ...value, allow: [...allowRules, rule] });
    setNewAllow('');
  };

  const removeAllow = (index: number) => {
    onChange({ ...value, allow: allowRules.filter((_, i) => i !== index) });
  };

  const addDeny = () => {
    const rule = newDeny.trim();
    if (!rule || denyRules.includes(rule)) return;
    onChange({ ...value, deny: [...denyRules, rule] });
    setNewDeny('');
  };

  const removeDeny = (index: number) => {
    onChange({ ...value, deny: denyRules.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      {/* Allow rules */}
      <div>
        <label className="block text-[10px] text-ctp-green uppercase tracking-wider mb-1">Allow</label>
        <div className="space-y-1">
          {allowRules.map((rule, i) => (
            <div key={i} className="flex items-center gap-2 bg-surface-0 rounded px-2 py-1 border border-surface-1">
              <code className="text-xs text-ctp-text flex-1 font-mono">{rule}</code>
              {!readOnly && (
                <button
                  onClick={() => removeAllow(i)}
                  className="text-ctp-subtext0 hover:text-red-400 cursor-pointer"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="flex items-center gap-1">
              <input
                value={newAllow}
                onChange={(e) => setNewAllow(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addAllow()}
                placeholder='e.g. Bash(npm run *)'
                className="flex-1 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-xs text-ctp-text
                  font-mono placeholder-ctp-subtext0/40 focus:outline-none focus:border-ctp-green/50"
              />
              <button
                onClick={addAllow}
                className="px-2 py-1 text-xs rounded bg-ctp-green/15 text-ctp-green hover:bg-ctp-green/25 cursor-pointer"
              >
                +
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Deny rules */}
      <div>
        <label className="block text-[10px] text-red-400 uppercase tracking-wider mb-1">Deny</label>
        <div className="space-y-1">
          {denyRules.map((rule, i) => (
            <div key={i} className="flex items-center gap-2 bg-surface-0 rounded px-2 py-1 border border-surface-1">
              <code className="text-xs text-ctp-text flex-1 font-mono">{rule}</code>
              {!readOnly && (
                <button
                  onClick={() => removeDeny(i)}
                  className="text-ctp-subtext0 hover:text-red-400 cursor-pointer"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="flex items-center gap-1">
              <input
                value={newDeny}
                onChange={(e) => setNewDeny(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addDeny()}
                placeholder='e.g. Bash(rm -rf *)'
                className="flex-1 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-xs text-ctp-text
                  font-mono placeholder-ctp-subtext0/40 focus:outline-none focus:border-red-400/50"
              />
              <button
                onClick={addDeny}
                className="px-2 py-1 text-xs rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 cursor-pointer"
              >
                +
              </button>
            </div>
          )}
        </div>
      </div>

      {allowRules.length === 0 && denyRules.length === 0 && (
        <div className="text-xs text-ctp-subtext0">
          No permission rules configured. Add rules using glob patterns.
        </div>
      )}
    </div>
  );
}
