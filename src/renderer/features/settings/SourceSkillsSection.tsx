import { useEffect, useState, useCallback } from 'react';
import { SkillEntry } from '../../../shared/types';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';

interface Props {
  projectPath: string;
}

type View = 'list' | 'create' | 'edit';

export function SourceSkillsSection({ projectPath }: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [view, setView] = useState<View>('list');
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [skillName, setSkillName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    if (!projectPath) return;
    try {
      const list = await window.clubhouse.agentSettings.listSourceSkills(projectPath);
      setSkills(list);
    } catch {
      setSkills([]);
    }
  }, [projectPath]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const handleCreate = () => {
    setView('create');
    setSkillName('');
    setEditorContent('# Skill Name\n\nDescribe what this skill does.\n');
  };

  const handleEdit = async (name: string) => {
    const content = await window.clubhouse.agentSettings.readSourceSkillContent(projectPath, name);
    setEditingSkill(name);
    setEditorContent(content);
    setView('edit');
  };

  const handleSaveNew = async () => {
    const name = skillName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeSourceSkillContent(projectPath, name, editorContent);
    setSaving(false);
    setView('list');
    await loadSkills();
  };

  const handleSaveEdit = async () => {
    if (!editingSkill) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeSourceSkillContent(projectPath, editingSkill, editorContent);
    setSaving(false);
    setView('list');
    setEditingSkill(null);
    await loadSkills();
  };

  const handleDelete = async (name: string) => {
    await window.clubhouse.agentSettings.deleteSourceSkill(projectPath, name);
    setDeleteTarget(null);
    await loadSkills();
  };

  const handleOpenFolder = (skillPath: string) => {
    window.clubhouse.file.showInFolder(skillPath);
  };

  // Editor view (create or edit)
  if (view === 'create' || view === 'edit') {
    const isCreate = view === 'create';
    return (
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
            {isCreate ? 'New Skill' : `Edit: ${editingSkill}`}
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => { setView('list'); setEditingSkill(null); }}
              className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={isCreate ? handleSaveNew : handleSaveEdit}
              disabled={saving || (isCreate && !skillName.trim())}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                saving || (isCreate && !skillName.trim())
                  ? 'bg-surface-1 text-ctp-subtext0 cursor-default'
                  : 'bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer'
              }`}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        {isCreate && (
          <input
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            placeholder="skill-name (lowercase, hyphens)"
            className="w-full mb-2 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue"
            spellCheck={false}
          />
        )}
        <SettingsMonacoEditor
          value={editorContent}
          language="markdown"
          onChange={setEditorContent}
          height="280px"
          editorKey={isCreate ? 'new-source-skill' : `edit-source-${editingSkill}`}
        />
      </section>
    );
  }

  // List view
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Skills</h3>
          <span className="text-[10px] text-ctp-subtext0/60 font-mono">.clubhouse/skills/</span>
        </div>
        <button
          onClick={handleCreate}
          className="text-xs px-2 py-1 rounded transition-colors bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer"
        >
          + Skill
        </button>
      </div>

      {skills.length === 0 ? (
        <p className="text-xs text-ctp-subtext0/60 py-2">No skills defined.</p>
      ) : (
        <div className="space-y-1">
          {skills.map((skill) => (
            <div
              key={skill.name}
              className="flex items-center justify-between py-1.5 px-2 rounded bg-surface-0 border border-surface-1"
            >
              <button
                onClick={() => handleEdit(skill.name)}
                className="text-sm text-ctp-text font-mono truncate hover:text-ctp-blue cursor-pointer transition-colors text-left"
                title="Click to edit"
              >
                {skill.name}
              </button>
              <div className="flex gap-1 flex-shrink-0 ml-2">
                <button
                  onClick={() => handleOpenFolder(skill.path)}
                  className="text-ctp-subtext0 hover:text-ctp-text p-1 cursor-pointer transition-colors"
                  title="Open in file manager"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
                <button
                  onClick={() => setDeleteTarget(skill.name)}
                  className="text-ctp-subtext0 hover:text-red-400 p-1 cursor-pointer transition-colors"
                  title="Delete skill"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-ctp-base border border-surface-1 rounded-lg p-4 max-w-sm mx-4 shadow-xl">
            <h4 className="text-sm font-semibold text-ctp-text mb-2">Delete Skill</h4>
            <p className="text-xs text-ctp-subtext0 mb-1">
              Are you sure you want to delete <span className="font-mono text-ctp-text">{deleteTarget}</span>?
            </p>
            <p className="text-xs text-red-400 mb-4">
              This will permanently delete the skill directory and cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-xs px-3 py-1.5 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteTarget)}
                className="text-xs px-3 py-1.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 cursor-pointer transition-colors border border-red-500/30"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
