import { useState, useEffect, useCallback } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { ConfigDiffCategory, ConfigDiffAction } from '../../../shared/types';
import { Spinner } from '../../components/Spinner';
import { Modal } from '../../components/Modal';
import { settingsButton } from '../settings/SettingsLayout';

interface DiffItem {
  id: string;
  category: string;
  action: string;
  label: string;
  agentValue?: string;
  defaultValue?: string;
  rawAgentValue?: string;
}

const CATEGORY_LABELS: Record<ConfigDiffCategory, string> = {
  'instructions': 'Instructions',
  'permissions-allow': 'Allowed permissions',
  'permissions-deny': 'Denied permissions',
  'mcp': 'MCP servers',
  'skills': 'Skills',
  'agent-templates': 'Agent templates',
};

/** A plain colored symbol per change: + added, \u2212 removed, ~ modified. */
const ACTION_MARK: Record<ConfigDiffAction, { label: string; title: string; cls: string }> = {
  added: { label: '+', title: 'Added', cls: 'text-ctp-success' },
  removed: { label: '\u2212', title: 'Removed', cls: 'text-ctp-error' },
  modified: { label: '~', title: 'Changed', cls: 'text-ctp-warning' },
};

export function ConfigChangesDialog() {
  const agentId = useAgentStore((s) => s.configChangesDialogAgent);
  const projectPath = useAgentStore((s) => s.configChangesProjectPath);
  const closeDialog = useAgentStore((s) => s.closeConfigChangesDialog);
  const agents = useAgentStore((s) => s.agents);

  const [items, setItems] = useState<DiffItem[]>([]);
  const [agentName, setAgentName] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const agent = agentId ? agents[agentId] : null;

  const fetchDiff = useCallback(async () => {
    if (!agentId || !projectPath) return;
    setLoading(true);
    try {
      const result = await window.clubhouse.agentSettings.computeConfigDiff(projectPath, agentId);
      setItems(result.items);
      setAgentName(result.agentName);
      // Default: select all items
      setSelectedIds(new Set(result.items.map((i) => i.id)));
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, [agentId, projectPath]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  if (!agentId || !projectPath) return null;

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    setExecuting(true);
    try {
      await window.clubhouse.agentSettings.propagateConfigChanges(
        projectPath,
        agentId,
        Array.from(selectedIds),
      );
    } catch {
      // silent
    }
    setExecuting(false);
    closeDialog();
  };

  const handleKeepForAgent = async () => {
    setExecuting(true);
    try {
      await window.clubhouse.agent.updateDurableConfig(projectPath, agentId, {
        clubhouseModeOverride: true,
      });
    } catch {
      // silent
    }
    setExecuting(false);
    closeDialog();
  };

  const handleDiscard = () => {
    closeDialog();
  };

  // Group items by category
  const grouped = new Map<string, DiffItem[]>();
  for (const item of items) {
    const list = grouped.get(item.category) || [];
    list.push(item);
    grouped.set(item.category, list);
  }

  const hasExpandableContent = (item: DiffItem) =>
    item.category === 'instructions' || item.category === 'skills' || item.category === 'agent-templates';

  const title = loading
    ? 'Checking for config changes'
    : items.length === 0
      ? 'No config changes detected'
      : 'Config changes detected';

  return (
    <Modal open={true} onClose={closeDialog} title={title} width="w-[540px] max-w-[calc(100vw-2rem)]">
      <div className="max-h-[70vh] flex flex-col">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <>
            <p className="text-[13px] text-ctp-subtext1">
              {agentName || agent?.name || 'Agent'} has no configuration changes to propagate.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={closeDialog} className={settingsButton.ghost}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] text-ctp-subtext1">
              {agentName || agent?.name} picked up config changes during this session.
              Save them to Clubhouse so every agent gets them on next wake.
            </p>

            {/* Select all / deselect all */}
            <div className="flex items-center gap-2 mt-3 mb-1">
              <button onClick={toggleAll} className={`${settingsButton.quiet} -ml-2.5`}>
                {selectedIds.size === items.length ? 'Deselect all' : 'Select all'}
              </button>
              <span className="text-xs text-ctp-overlay1">
                {selectedIds.size} of {items.length} selected
              </span>
            </div>

            {/* Grouped items */}
            <div className="flex-1 overflow-y-auto min-h-0 space-y-3">
              {Array.from(grouped.entries()).map(([category, categoryItems]) => (
                <div key={category}>
                  <div className="text-xs font-medium text-ctp-subtext0 mb-0.5">
                    {CATEGORY_LABELS[category as ConfigDiffCategory] || category}
                  </div>
                  {categoryItems.map((item) => {
                    const mark = ACTION_MARK[item.action as ConfigDiffAction] || { label: '?', title: item.action, cls: 'text-ctp-overlay1' };
                    const isExpanded = expandedItems.has(item.id);
                    const canExpand = hasExpandableContent(item);

                    return (
                      <div key={item.id} className="border-t border-surface-0">
                        <div className="flex items-center gap-2 min-h-[30px]">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(item.id)}
                            onChange={() => toggleItem(item.id)}
                            aria-label={item.label}
                            className="w-3.5 h-3.5 accent-ctp-accent flex-shrink-0"
                          />
                          <span className={`w-3 text-center text-xs font-mono flex-shrink-0 ${mark.cls}`} title={mark.title}>
                            {mark.label}
                          </span>
                          <span className="text-[13px] text-ctp-text truncate flex-1">
                            {item.label}
                          </span>
                          {canExpand && (
                            <button
                              onClick={() => toggleExpand(item.id)}
                              className={settingsButton.quiet}
                            >
                              {isExpanded ? 'Hide diff' : 'View diff'}
                            </button>
                          )}
                        </div>
                        {isExpanded && canExpand && (
                          <div className="pb-2">
                            <DiffView
                              agentValue={item.agentValue || ''}
                              defaultValue={item.defaultValue || ''}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex justify-between gap-2 mt-4">
              <button onClick={handleDiscard} disabled={executing} className={settingsButton.quiet}>
                Discard
              </button>
              <div className="flex gap-2">
                <button onClick={handleKeepForAgent} disabled={executing} className={settingsButton.ghost}>
                  Keep for this agent
                </button>
                <button
                  onClick={handleSave}
                  disabled={executing || selectedIds.size === 0}
                  className={settingsButton.primary}
                >
                  {executing && <Spinner size="xs" />}
                  Save to Clubhouse
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Simple line-by-line diff view with red/green highlighting.
 */
function DiffView({ agentValue, defaultValue }: { agentValue: string; defaultValue: string }) {
  const agentLines = agentValue.split('\n');
  const defaultLines = defaultValue.split('\n');

  // Simple line-by-line comparison
  const maxLen = Math.max(agentLines.length, defaultLines.length);
  const diffLines: Array<{ text: string; type: 'same' | 'added' | 'removed' }> = [];

  for (let i = 0; i < maxLen; i++) {
    const a = agentLines[i];
    const d = defaultLines[i];
    if (a === d) {
      diffLines.push({ text: a || '', type: 'same' });
    } else {
      if (d !== undefined) {
        diffLines.push({ text: d, type: 'removed' });
      }
      if (a !== undefined) {
        diffLines.push({ text: a, type: 'added' });
      }
    }
  }

  return (
    <div className="mt-1 max-h-[200px] overflow-auto rounded-md bg-ctp-crust text-[11px] font-mono leading-relaxed">
      {diffLines.map((line, i) => (
        <div
          key={i}
          className={`px-1.5 ${
            line.type === 'added'
              ? 'bg-ctp-success/10 text-ctp-success'
              : line.type === 'removed'
                ? 'bg-ctp-error/10 text-ctp-error'
                : 'text-ctp-subtext0'
          }`}
        >
          <span className="select-none mr-1.5 text-ctp-overlay0">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          {line.text || '\u00A0'}
        </div>
      ))}
    </div>
  );
}
