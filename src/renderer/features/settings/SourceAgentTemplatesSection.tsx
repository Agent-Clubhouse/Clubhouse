import { useEffect, useState, useCallback } from 'react';
import { AgentTemplateEntry } from '../../../shared/types';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';
import { Modal } from '../../components/Modal';
import { SettingsSection, SettingsBlock, settingsInput, settingsHelp } from './SettingsLayout';
import { Button } from '../../components/Button';

interface Props {
  projectPath: string;
}

type View = 'list' | 'create' | 'edit';

export function SourceAgentTemplatesSection({ projectPath }: Props) {
  const [templates, setTemplates] = useState<AgentTemplateEntry[]>([]);
  const [view, setView] = useState<View>('list');
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    if (!projectPath) return;
    try {
      const list = await window.clubhouse.agentSettings.listSourceAgentTemplates(projectPath);
      setTemplates(list);
    } catch {
      setTemplates([]);
    }
  }, [projectPath]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const handleCreate = () => {
    setView('create');
    setTemplateName('');
    setEditorContent('# Agent Name\n\nDescribe what this agent does and its capabilities.\n');
  };

  const handleEdit = async (name: string) => {
    const content = await window.clubhouse.agentSettings.readSourceAgentTemplateContent(projectPath, name);
    setEditingTemplate(name);
    setEditorContent(content);
    setView('edit');
  };

  const handleSaveNew = async () => {
    const name = templateName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeSourceAgentTemplateContent(projectPath, name, editorContent);
    setSaving(false);
    setView('list');
    await loadTemplates();
  };

  const handleSaveEdit = async () => {
    if (!editingTemplate) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeSourceAgentTemplateContent(projectPath, editingTemplate, editorContent);
    setSaving(false);
    setView('list');
    setEditingTemplate(null);
    await loadTemplates();
  };

  const handleDelete = async (name: string) => {
    await window.clubhouse.agentSettings.deleteSourceAgentTemplate(projectPath, name);
    setDeleteTarget(null);
    await loadTemplates();
  };

  const handleOpenFolder = (templatePath: string) => {
    window.clubhouse.file.showInFolder(templatePath);
  };

  // Editor view (create or edit)
  if (view === 'create' || view === 'edit') {
    const isCreate = view === 'create';
    const saveDisabled = saving || (isCreate && !templateName.trim());
    return (
      <SettingsSection
        title={isCreate ? 'New agent definition' : `Edit ${editingTemplate}`}
        actions={
          <>
            <Button
              onClick={() => { setView('list'); setEditingTemplate(null); }}
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
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="agent-name (lowercase, hyphens)"
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
            editorKey={isCreate ? 'new-source-agent' : `edit-source-${editingTemplate}`}
          />
        </SettingsBlock>
      </SettingsSection>
    );
  }

  // List view
  return (
    <SettingsSection
      title="Agent definitions"
      meta={<span className="font-mono">.clubhouse/agent-templates/</span>}
      actions={
        <Button onClick={handleCreate} kind="ghost">
          New definition
        </Button>
      }
    >
      {templates.length === 0 ? (
        <SettingsBlock>
          <p className={settingsHelp}>No agent definitions found.</p>
        </SettingsBlock>
      ) : (
        <div>
          {templates.map((tpl) => (
            <div
              key={tpl.name}
              className="flex items-center gap-3 min-h-[38px] border-t border-surface-0"
            >
              <button
                type="button"
                onClick={() => handleEdit(tpl.name)}
                className="flex-1 min-w-0 text-[13px] text-ctp-text font-mono truncate hover:text-ctp-accent cursor-pointer transition-colors text-left"
                title="Click to edit"
              >
                {tpl.name}
              </button>
              <div className="flex gap-0.5 flex-shrink-0">
                <Button
                  onClick={() => handleOpenFolder(tpl.path)}
                  kind="quiet" className="w-7 px-0 text-ctp-subtext0"
                  title="Open in file manager"
                  aria-label="Open {tpl.name} in file manager"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </Button>
                <Button
                  onClick={() => setDeleteTarget(tpl.name)}
                  kind="quiet" className="w-7 px-0 text-ctp-subtext0 hover:text-ctp-error"
                  title="Delete agent definition"
                  aria-label="Delete agent definition {tpl.name}"
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
        title="Delete agent definition?"
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
            This permanently deletes the agent definition. You can’t undo this.
          </p>
        </div>
      </Modal>
    </SettingsSection>
  );
}
