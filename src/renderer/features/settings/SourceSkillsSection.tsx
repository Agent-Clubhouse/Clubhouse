import { useEffect, useState, useCallback } from 'react';
import { SkillEntry } from '../../../shared/types';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';
import { Modal } from '../../components/Modal';
import { SettingsSection, SettingsBlock, settingsInput, settingsHelp } from './SettingsLayout';
import { Button } from '../../components/Button';

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
    const saveDisabled = saving || (isCreate && !skillName.trim());
    return (
      <SettingsSection
        title={isCreate ? 'New skill' : `Edit ${editingSkill}`}
        actions={
          <>
            <Button
              onClick={() => { setView('list'); setEditingSkill(null); }}
              kind="quiet"
            >
              Cancel
            </Button>
            <Button
              onClick={isCreate ? handleSaveNew : handleSaveEdit}
              disabled={saveDisabled}
              kind="primary"
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </>
        }
      >
        <SettingsBlock className="space-y-2">
          {isCreate && (
            <input
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              placeholder="skill-name (lowercase, hyphens)"
              aria-label="Name"
              className={`${settingsInput} w-full font-mono`}
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
        </SettingsBlock>
      </SettingsSection>
    );
  }

  // List view
  return (
    <SettingsSection
      title="Skills"
      meta={<span className="font-mono">.clubhouse/skills/</span>}
      actions={
        <Button onClick={handleCreate} kind="ghost">
          New skill
        </Button>
      }
    >
      {skills.length === 0 ? (
        <SettingsBlock>
          <p className={settingsHelp}>No skills defined.</p>
        </SettingsBlock>
      ) : (
        <div>
          {skills.map((skill) => (
            <div
              key={skill.name}
              className="flex items-center gap-3 min-h-[38px] border-t border-surface-0"
            >
              <button
                type="button"
                onClick={() => handleEdit(skill.name)}
                className="flex-1 min-w-0 text-[13px] text-ctp-text font-mono truncate hover:text-ctp-accent cursor-pointer transition-colors text-left"
                title="Click to edit"
              >
                {skill.name}
              </button>
              <div className="flex gap-0.5 flex-shrink-0">
                <Button
                  onClick={() => handleEdit(skill.name)}
                  kind="quiet" className="w-7 px-0 text-ctp-subtext0"
                  title="Edit skill"
                  aria-label="Edit skill {skill.name}"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </Button>
                <Button
                  onClick={() => handleOpenFolder(skill.path)}
                  kind="quiet" className="w-7 px-0 text-ctp-subtext0"
                  title="Open in file manager"
                  aria-label="Open {skill.name} in file manager"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </Button>
                <Button
                  onClick={() => setDeleteTarget(skill.name)}
                  kind="quiet" className="w-7 px-0 text-ctp-subtext0 hover:text-ctp-error"
                  title="Delete skill"
                  aria-label="Delete skill {skill.name}"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete skill?"
        width="w-[400px] max-w-[calc(100vw-32px)]"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)} kind="ghost">
              Cancel
            </Button>
            <Button
              onClick={() => { if (deleteTarget) handleDelete(deleteTarget); }}
              kind="danger-solid"
            >
              Delete
            </Button>
          </>
        }
      >
        <div>
          <p className={settingsHelp}>
            Delete <span className="font-mono text-ctp-text">{deleteTarget}</span>?
          </p>
          <p className="text-xs text-ctp-error mt-1">
            This permanently deletes the skill folder. You can’t undo this.
          </p>
        </div>
      </Modal>
    </SettingsSection>
  );
}
