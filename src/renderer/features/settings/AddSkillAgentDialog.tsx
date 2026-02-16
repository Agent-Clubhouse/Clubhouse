import { useState, useRef, useEffect } from 'react';

interface Props {
  kind: 'skill' | 'agent-template';
  onCancel: () => void;
  onCreate: (name: string, method: 'manual' | 'generate', prompt?: string) => void;
}

export function AddSkillAgentDialog({ kind, onCancel, onCreate }: Props) {
  const label = kind === 'skill' ? 'Skill' : 'Agent Template';
  const [name, setName] = useState('');
  const [method, setMethod] = useState<'manual' | 'generate'>('manual');
  const [prompt, setPrompt] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, method, method === 'generate' ? prompt : undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && name.trim()) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="bg-ctp-base border border-surface-2 rounded-lg p-5 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ctp-text mb-4">New {label}</h3>

        {/* Name input */}
        <div className="mb-4">
          <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">Name</label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '-'))}
            onKeyDown={handleKeyDown}
            placeholder={kind === 'skill' ? 'my-skill' : 'my-agent-template'}
            className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
              placeholder-ctp-subtext0/50 focus:outline-none focus:border-indigo-500"
          />
        </div>

        {/* Method toggle */}
        <div className="mb-4">
          <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">Method</label>
          <div className="flex gap-2">
            <button
              onClick={() => setMethod('manual')}
              className={`flex-1 px-3 py-2 text-xs rounded-lg border cursor-pointer transition-colors ${
                method === 'manual'
                  ? 'bg-indigo-500/15 border-indigo-500/50 text-indigo-400'
                  : 'bg-surface-0 border-surface-2 text-ctp-subtext0 hover:border-surface-1'
              }`}
            >
              Manual
            </button>
            <button
              onClick={() => setMethod('generate')}
              className={`flex-1 px-3 py-2 text-xs rounded-lg border cursor-pointer transition-colors ${
                method === 'generate'
                  ? 'bg-green-500/15 border-green-500/50 text-green-400'
                  : 'bg-surface-0 border-surface-2 text-ctp-subtext0 hover:border-surface-1'
              }`}
            >
              Generate with Agent
            </button>
          </div>
        </div>

        {/* Generate prompt */}
        {method === 'generate' && (
          <div className="mb-4">
            <label className="block text-xs text-ctp-subtext0 uppercase tracking-wider mb-1.5">
              Describe what to create
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`Describe what this ${kind === 'skill' ? 'skill' : 'agent template'} should do...`}
              rows={3}
              className="w-full bg-surface-0 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
                placeholder-ctp-subtext0/50 resize-y focus:outline-none focus:border-green-500"
            />
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface-0 border border-surface-2
              text-ctp-text hover:bg-surface-1 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium cursor-pointer transition-colors ${
              !name.trim()
                ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed'
                : method === 'generate'
                  ? 'bg-green-500/20 border border-green-500/50 text-green-400 hover:bg-green-500/30'
                  : 'bg-indigo-500 text-white hover:bg-indigo-600'
            }`}
          >
            {method === 'generate' ? 'Generate' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
