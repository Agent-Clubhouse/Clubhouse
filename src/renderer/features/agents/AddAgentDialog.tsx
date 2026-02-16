import { useState } from 'react';
import { generateDurableName, AGENT_COLORS } from '../../../shared/name-generator';
import { MODEL_OPTIONS } from '../../../shared/models';

interface Props {
  onClose: () => void;
  onCreate: (name: string, color: string, model: string, useWorktree: boolean) => void;
}

export function AddAgentDialog({ onClose, onCreate }: Props) {
  const [name, setName] = useState(generateDurableName());
  const [color, setColor] = useState<string>(AGENT_COLORS[0].id);
  const [model, setModel] = useState('default');
  const [useWorktree, setUseWorktree] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim(), color, model, useWorktree);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[360px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ctp-text mb-4">New Agent</h2>
        <form onSubmit={handleSubmit}>
          {/* Name */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Name</span>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                  text-ctp-text focus:outline-none focus:border-indigo-500"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setName(generateDurableName())}
                className="px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext0
                  hover:bg-surface-2 hover:text-ctp-text cursor-pointer"
                title="Randomize"
              >
                {'\u21BB'}
              </button>
            </div>
          </label>

          {/* Color */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Color</span>
            <div className="flex gap-2 mt-1.5">
              {AGENT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.id)}
                  className={`w-7 h-7 rounded-full cursor-pointer transition-all ${
                    color === c.id ? 'ring-2 ring-offset-2 ring-offset-ctp-mantle scale-110' : 'opacity-60 hover:opacity-100'
                  }`}
                  style={{ backgroundColor: c.hex, ...(color === c.id ? { boxShadow: `0 0 0 2px ${c.hex}40` } : {}) }}
                  title={c.label}
                />
              ))}
            </div>
          </label>

          {/* Model */}
          <label className="block mb-3">
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-3 py-1.5 text-sm
                text-ctp-text focus:outline-none focus:border-indigo-500"
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </label>

          {/* Use Worktree */}
          <label className="flex items-center gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-indigo-500 focus:ring-indigo-500"
            />
            <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Use git worktree</span>
            <span className="text-[10px] text-ctp-subtext0/70 ml-1">
              (isolated branch + directory)
            </span>
          </label>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                hover:bg-surface-2 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs rounded bg-indigo-500 text-white
                hover:bg-indigo-600 cursor-pointer font-medium"
            >
              Create Agent
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
