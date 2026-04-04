import { useState, type ReactNode } from 'react';
import { PERSONA_TEMPLATES, type PersonaTemplate } from '../assistant/content/personas';
import { getAgentColorHex } from '../../../shared/name-generator';

/** SVG icons for each persona — simple role-suggestive shapes */
const PERSONA_ICONS: Record<string, ReactNode> = {
  'project-manager': (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  'qa': (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  ),
  'ui-lead': (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r="2.5" />
      <path d="M17 2l4 4-4 4" />
      <path d="M2 12l4-4 4 4" />
      <path d="M12 22l-4-4 4-4" />
    </svg>
  ),
  'quality-auditor': (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  ),
  'executor-pr-only': (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <line x1="12" y1="2" x2="12" y2="22" opacity="0.3" />
    </svg>
  ),
  'executor-merge': (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  'doc-updater': (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
};

/** Default color assignments for each persona */
const PERSONA_COLORS: Record<string, string> = {
  'project-manager': 'indigo',
  'qa': 'red',
  'ui-lead': 'pink',
  'quality-auditor': 'amber',
  'executor-pr-only': 'emerald',
  'executor-merge': 'cyan',
  'doc-updater': 'blue',
};

interface Props {
  onClose: () => void;
  onCreate: (persona: PersonaTemplate, color: string) => void;
}

export function AgentGalleryDialog({ onClose, onCreate }: Props) {
  const [selected, setSelected] = useState<PersonaTemplate | null>(null);

  const getColorHex = (personaId: string): string => {
    return getAgentColorHex(PERSONA_COLORS[personaId] || 'indigo');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-ctp-base border border-surface-0 rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-0">
          <h2 className="text-sm font-semibold text-ctp-text">Create Agent from Template</h2>
          <button
            onClick={onClose}
            className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Gallery grid */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          <div className="grid grid-cols-2 gap-3">
            {PERSONA_TEMPLATES.map((persona) => {
              const isSelected = selected?.id === persona.id;
              const colorHex = getColorHex(persona.id);
              return (
                <button
                  key={persona.id}
                  onClick={() => setSelected(persona)}
                  className={`text-left p-3 rounded-lg border-2 transition-all cursor-pointer ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-surface-0 hover:border-surface-0/80 hover:bg-surface-0/30'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: `${colorHex}20`, color: colorHex }}
                    >
                      {PERSONA_ICONS[persona.id] || (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="10" />
                        </svg>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-ctp-text truncate">{persona.name}</div>
                      <div className="text-[10px] text-ctp-subtext0 mt-0.5 line-clamp-2 leading-tight">
                        {persona.description}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-surface-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-ctp-subtext1 hover:text-ctp-text rounded transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (selected) {
                onCreate(selected, PERSONA_COLORS[selected.id] || 'indigo');
              }
            }}
            disabled={!selected}
            className={`px-4 py-1.5 text-xs rounded font-medium transition-colors cursor-pointer ${
              selected
                ? 'bg-indigo-500 text-white hover:bg-indigo-600'
                : 'bg-surface-0 text-ctp-subtext0 cursor-not-allowed'
            }`}
          >
            Create Agent
          </button>
        </div>
      </div>
    </div>
  );
}
