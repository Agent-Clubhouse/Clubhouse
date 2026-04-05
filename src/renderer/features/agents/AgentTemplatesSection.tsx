import { useEffect, useState, useCallback } from 'react';
import { AgentTemplateEntry } from '../../../shared/types';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';
import {
  getPluginAgentTemplatesByPlugin,
  onTemplateRegistryChange,
  type RegisteredPluginAgentTemplate,
} from '../../plugins/plugin-agent-template-registry';

interface Props {
  worktreePath: string;
  projectPath?: string;
  disabled: boolean;
  refreshKey: number;
  pathLabel?: string;
  onCreateFromPluginTemplate?: (template: RegisteredPluginAgentTemplate) => void;
}

type View = 'list' | 'create' | 'edit';

export function AgentTemplatesSection({ worktreePath, projectPath, disabled, refreshKey, pathLabel, onCreateFromPluginTemplate }: Props) {
  const [templates, setTemplates] = useState<AgentTemplateEntry[]>([]);
  const [view, setView] = useState<View>('list');
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Plugin-contributed templates
  const [pluginTemplateGroups, setPluginTemplateGroups] = useState<Map<string, RegisteredPluginAgentTemplate[]>>(
    () => getPluginAgentTemplatesByPlugin(),
  );

  const loadTemplates = useCallback(async () => {
    if (!worktreePath) return;
    try {
      const list = await window.clubhouse.agentSettings.listAgentTemplateFiles(worktreePath, projectPath);
      setTemplates(list);
    } catch {
      setTemplates([]);
    }
  }, [worktreePath, projectPath]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates, refreshKey]);

  // Subscribe to plugin template registry changes
  useEffect(() => {
    const disposable = onTemplateRegistryChange(() => {
      setPluginTemplateGroups(getPluginAgentTemplatesByPlugin());
    });
    return () => disposable.dispose();
  }, []);

  const handleCreate = () => {
    setView('create');
    setTemplateName('');
    setEditorContent('# Agent Name\n\nDescribe what this agent does and its capabilities.\n');
  };

  const handleEdit = async (name: string) => {
    const content = await window.clubhouse.agentSettings.readAgentTemplateContent(worktreePath, name, projectPath);
    setEditingTemplate(name);
    setEditorContent(content);
    setView('edit');
  };

  const handleSaveNew = async () => {
    const name = templateName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeAgentTemplateContent(worktreePath, name, editorContent, projectPath);
    setSaving(false);
    setView('list');
    await loadTemplates();
  };

  const handleSaveEdit = async () => {
    if (!editingTemplate) return;
    setSaving(true);
    await window.clubhouse.agentSettings.writeAgentTemplateContent(worktreePath, editingTemplate, editorContent, projectPath);
    setSaving(false);
    setView('list');
    setEditingTemplate(null);
    await loadTemplates();
  };

  const handleDelete = async (name: string) => {
    await window.clubhouse.agentSettings.deleteAgentTemplate(worktreePath, name, projectPath);
    setDeleteTarget(null);
    await loadTemplates();
  };

  const handleOpenFolder = (templatePath: string) => {
    window.clubhouse.file.showInFolder(templatePath);
  };

  // Editor view (create or edit)
  if (view === 'create' || view === 'edit') {
    const isCreate = view === 'create';
    return (
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
            {isCreate ? 'New Agent Definition' : `Edit: ${editingTemplate}`}
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => { setView('list'); setEditingTemplate(null); }}
              className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={isCreate ? handleSaveNew : handleSaveEdit}
              disabled={saving || (isCreate && !templateName.trim())}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                saving || (isCreate && !templateName.trim())
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
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder="agent-name (lowercase, hyphens)"
            className="w-full mb-2 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue"
            spellCheck={false}
          />
        )}
        <SettingsMonacoEditor
          value={editorContent}
          language="markdown"
          onChange={setEditorContent}
          height="280px"
          editorKey={isCreate ? 'new-agent' : `edit-${editingTemplate}`}
        />
      </section>
    );
  }

  const hasPluginTemplates = pluginTemplateGroups.size > 0;

  // List view
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Agent Definitions</h3>
          <span className="text-[10px] text-ctp-subtext0/60 font-mono">{pathLabel || '.claude/agents/'}</span>
        </div>
        <button
          onClick={handleCreate}
          disabled={disabled}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            disabled
              ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed'
              : 'bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer'
          }`}
        >
          + Agent
        </button>
      </div>

      {/* Built-in (filesystem) templates */}
      {hasPluginTemplates && templates.length > 0 && (
        <p className="text-[10px] text-ctp-subtext0/50 uppercase tracking-wider mb-1 mt-2">Built-in</p>
      )}
      {templates.length === 0 && !hasPluginTemplates ? (
        <p className="text-xs text-ctp-subtext0/60 py-2">No agent definitions found.</p>
      ) : (
        <div className="space-y-1">
          {templates.map((tpl) => (
            <div
              key={tpl.name}
              className="flex items-center justify-between py-1.5 px-2 rounded bg-surface-0 border border-surface-1"
            >
              <button
                onClick={() => handleEdit(tpl.name)}
                className="text-sm text-ctp-text font-mono truncate hover:text-ctp-blue cursor-pointer transition-colors text-left"
                title="Click to edit"
              >
                {tpl.name}
              </button>
              <div className="flex gap-1 flex-shrink-0 ml-2">
                <button
                  onClick={() => handleOpenFolder(tpl.path)}
                  className="text-ctp-subtext0 hover:text-ctp-text p-1 cursor-pointer transition-colors"
                  title="Open in file manager"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
                <button
                  onClick={() => setDeleteTarget(tpl.name)}
                  disabled={disabled}
                  className={`p-1 transition-colors ${
                    disabled
                      ? 'text-ctp-subtext0/30 cursor-not-allowed'
                      : 'text-ctp-subtext0 hover:text-red-400 cursor-pointer'
                  }`}
                  title="Delete agent definition"
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

      {/* Plugin-contributed templates, grouped by plugin */}
      {[...pluginTemplateGroups.entries()].map(([pluginId, pluginTemplates]) => {
        const groupName = pluginTemplates[0]?.pluginName || pluginId;
        return (
          <div key={pluginId} className="mt-3" data-testid={`plugin-template-group-${pluginId}`}>
            <p className="text-[10px] text-ctp-subtext0/50 uppercase tracking-wider mb-1">
              {groupName}
            </p>
            <div className="space-y-1">
              {pluginTemplates.map((entry) => (
                <div
                  key={`${pluginId}:${entry.template.name}`}
                  className="flex items-center justify-between py-1.5 px-2 rounded bg-surface-0 border border-surface-1"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {entry.template.icon && (
                      <span
                        className="flex-shrink-0 text-ctp-subtext0 w-4 h-4"
                        dangerouslySetInnerHTML={{ __html: entry.template.icon }}
                      />
                    )}
                    <div className="min-w-0">
                      <span className="text-sm text-ctp-text font-mono truncate block">
                        {entry.template.name}
                      </span>
                      {entry.template.description && (
                        <span className="text-[10px] text-ctp-subtext0/60 truncate block">
                          {entry.template.description}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => onCreateFromPluginTemplate?.(entry)}
                    disabled={disabled}
                    className={`text-xs px-2 py-1 rounded transition-colors flex-shrink-0 ml-2 ${
                      disabled
                        ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed'
                        : 'bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 cursor-pointer'
                    }`}
                    title="Create agent from this template"
                  >
                    Create
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-ctp-base border border-surface-1 rounded-lg p-4 max-w-sm mx-4 shadow-xl">
            <h4 className="text-sm font-semibold text-ctp-text mb-2">Delete Agent Definition</h4>
            <p className="text-xs text-ctp-subtext0 mb-1">
              Are you sure you want to delete <span className="font-mono text-ctp-text">{deleteTarget}</span>?
            </p>
            <p className="text-xs text-red-400 mb-4">
              This will permanently delete the agent definition and cannot be undone.
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
