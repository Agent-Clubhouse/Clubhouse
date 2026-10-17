import { useEffect, useState, useCallback } from 'react';
import { SkillEntry } from '../../../shared/types';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';

interface Props {
  worktreePath: string;
  projectPath?: string;
  disabled: boolean;
  refreshKey: number;
  pathLabel?: string;
  /** The page title already names the section (agent settings pages in the new chrome). */
  hideTitle?: boolean;
}

type View = 'list' | 'create' | 'edit';

export function SkillsSection({ worktreePath, projectPath, disabled, refreshKey, pathLabel, hideTitle }: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [view, setView] = useState<View>('list');
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [skillName, setSkillName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    if (!worktreePath) return;
    try {
      const list = await window.clubhouse.agentSettings.listSkills(worktreePath, projectPath);
      setSkills(list);
    } catch {
      setSkills([]);
    }
  }, [worktreePath, projectPath]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills, refreshKey]);

  const handleCreate = () => {
    setView('create');
    setSkillName('');
    setEditorContent('# Skill Name\n\nDescribe what this skill does.\n');
  };

  const handleEdit = async (name: string) => {
    const content = await window.clubhouse.agentSettings.readSkillContent(worktreePath, name, projectPath);
    setEditingSkill(name);
    setEditorContent(content);
    setView('edit');
  };

  const handleSaveNew = async () => {
    const name = skillName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeSkillContent(worktreePath, name, editorContent, projectPath);
    setSaving(false);
    setView('list');
    await loadSkills();
  };

  const handleSaveEdit = async () => {
    if (!editingSkill) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeSkillContent(worktreePath, editingSkill, editorContent, projectPath);
    setSaving(false);
    setView('list');
    setEditingSkill(null);
    await loadSkills();
  };

  const handleDelete = async (name: string) => {
    await window.clubhouse.agentSettings.deleteSkill(worktreePath, name, projectPath);
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
      <section className={hideTitle ? 'mt-3' : 'mt-[22px]'}>
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-[13px] font-semibold text-ctp-text">
            {isCreate ? 'New skill' : `Edit: ${editingSkill}`}
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => { setView('list'); setEditingSkill(null); }}
              className="h-7 px-2.5 rounded-md text-xs font-medium text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={isCreate ? handleSaveNew : handleSaveEdit}
              disabled={saving || (isCreate && !skillName.trim())}
              className={`h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${
                saving || (isCreate && !skillName.trim())
                  ? 'bg-surface-0 text-ctp-overlay0 cursor-default'
                  : 'bg-ctp-accent text-ctp-crust hover:bg-ctp-accent/85 cursor-pointer'
              }`}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        {isCreate && (
          <input
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            placeholder="skill-name (lowercase, hyphens)"
            className="w-full h-7 mb-2 rounded-md border border-surface-1 bg-ctp-crust px-2.5 text-xs text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-accent"
            spellCheck={false}
          />
        )}
        <SettingsMonacoEditor
          value={editorContent}
          language="markdown"
          onChange={setEditorContent}
          height="280px"
          editorKey={isCreate ? 'new-skill' : `edit-${editingSkill}`}
        />
      </section>
    );
  }

  // List view
  return (
    <section className={hideTitle ? 'mt-3' : 'mt-[22px]'}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          {!hideTitle && <h3 className="text-[13px] font-semibold text-ctp-text">Skills</h3>}
          <span className="text-xs text-ctp-overlay1 font-mono">{pathLabel || '.claude/skills/'}</span>
        </div>
        <button
          onClick={handleCreate}
          disabled={disabled}
          className="h-7 px-2.5 rounded-md border border-surface-1 text-xs font-medium text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          New skill
        </button>
      </div>

      {skills.length === 0 ? (
        <p className="text-xs text-ctp-overlay1 py-2">No skills defined.</p>
      ) : (
        <div>
          {skills.map((skill) => (
            <div
              key={skill.name}
              className="min-h-[30px] py-1 flex items-center justify-between border-t border-surface-0"
            >
              <button
                onClick={() => handleEdit(skill.name)}
                className="text-[13px] text-ctp-text font-mono truncate hover:text-ctp-accent cursor-pointer transition-colors text-left"
                title="Click to edit"
              >
                {skill.name}
              </button>
              <div className="flex gap-1 flex-shrink-0 ml-2">
                <button
                  onClick={() => handleEdit(skill.name)}
                  disabled={disabled}
                  className={`p-1 transition-colors ${
                    disabled
                      ? 'text-ctp-subtext0/30 cursor-not-allowed'
                      : 'text-ctp-subtext0 hover:text-ctp-accent cursor-pointer'
                  }`}
                  title="Edit skill"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
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
                  disabled={disabled}
                  className={`p-1 transition-colors ${
                    disabled
                      ? 'text-ctp-subtext0/30 cursor-not-allowed'
                      : 'text-ctp-subtext0 hover:text-ctp-error cursor-pointer'
                  }`}
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
        // eslint-disable-next-line no-restricted-syntax
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50">
          <div className="bg-ctp-base border border-surface-1 rounded-lg p-4 max-w-sm mx-4 shadow-xl">
            <h4 className="text-sm font-semibold text-ctp-text mb-2">Delete skill</h4>
            <p className="text-xs text-ctp-subtext0 mb-1">
              Are you sure you want to delete <span className="font-mono text-ctp-text">{deleteTarget}</span>?
            </p>
            <p className="text-xs text-ctp-error mb-4">
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
                className="text-xs px-3 py-1.5 rounded bg-ctp-error/20 text-ctp-error hover:bg-ctp-error/30 cursor-pointer transition-colors border border-ctp-error/30"
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
