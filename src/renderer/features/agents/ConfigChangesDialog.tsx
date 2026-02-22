import { useState, useEffect, useCallback } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { ConfigDiffCategory, ConfigDiffAction } from '../../../shared/types';

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
  'permissions-allow': 'Permissions (Allow)',
  'permissions-deny': 'Permissions (Deny)',
  'mcp': 'MCP Servers',
  'skills': 'Skills',
  'agent-templates': 'Agent Templates',
};

const ACTION_BADGE: Record<ConfigDiffAction, { label: string; cls: string }> = {
  added: { label: '+', cls: 'bg-green-500/20 text-green-300' },
  removed: { label: '\u2212', cls: 'bg-red-500/20 text-red-300' },
  modified: { label: '~', cls: 'bg-yellow-500/20 text-yellow-300' },
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

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [closeDialog]);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={closeDialog}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[540px] shadow-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-ctp-subtext0 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <>
            <h2 className="text-base font-semibold text-ctp-text mb-2">
              No config changes detected
            </h2>
            <p className="text-sm text-ctp-subtext0 mb-4">
              {agentName || agent?.name || 'Agent'} has no configuration changes to propagate.
            </p>
            <div className="flex justify-end">
              <button
                onClick={closeDialog}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 cursor-pointer"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-ctp-text mb-1">
              Config changes detected
            </h2>
            <p className="text-xs text-ctp-subtext0 mb-3">
              {agentName || agent?.name} accumulated config changes during this session.
              Save them to Clubhouse so all agents benefit on next wake.
            </p>

            {/* Select all / deselect all */}
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={toggleAll}
                className="text-xs text-ctp-link hover:underline cursor-pointer"
              >
                {selectedIds.size === items.length ? 'Deselect all' : 'Select all'}
              </button>
              <span className="text-xs text-ctp-subtext0">
                {selectedIds.size} of {items.length} selected
              </span>
            </div>

            {/* Grouped items */}
            <div className="flex-1 overflow-y-auto min-h-0 mb-3 space-y-3">
              {Array.from(grouped.entries()).map(([category, categoryItems]) => (
                <div key={category}>
                  <div className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                    {CATEGORY_LABELS[category as ConfigDiffCategory] || category}
                  </div>
                  <div className="space-y-1">
                    {categoryItems.map((item) => {
                      const badge = ACTION_BADGE[item.action as ConfigDiffAction] || { label: '?', cls: 'bg-gray-500/20 text-gray-300' };
                      const isExpanded = expandedItems.has(item.id);
                      const canExpand = hasExpandableContent(item);

                      return (
                        <div key={item.id} className="bg-surface-0 rounded border border-surface-0">
                          <div className="flex items-center gap-2 px-2.5 py-1.5">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleItem(item.id)}
                              className="accent-ctp-accent flex-shrink-0"
                            />
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold flex-shrink-0 ${badge.cls}`}>
                              {badge.label}
                            </span>
                            <span className="text-xs text-ctp-text truncate flex-1">
                              {item.label}
                            </span>
                            {canExpand && (
                              <button
                                onClick={() => toggleExpand(item.id)}
                                className="text-[10px] text-ctp-subtext0 hover:text-ctp-text cursor-pointer flex-shrink-0"
                              >
                                {isExpanded ? 'Hide diff' : 'View diff'}
                              </button>
                            )}
                          </div>
                          {isExpanded && canExpand && (
                            <div className="px-2.5 pb-2 border-t border-surface-0">
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
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex justify-between gap-2">
              <button
                onClick={handleDiscard}
                disabled={executing}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 cursor-pointer disabled:opacity-50"
              >
                Discard
              </button>
              <div className="flex gap-2">
                <button
                  onClick={handleKeepForAgent}
                  disabled={executing}
                  className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                    hover:bg-surface-2 cursor-pointer disabled:opacity-50"
                >
                  Keep for this agent
                </button>
                <button
                  onClick={handleSave}
                  disabled={executing || selectedIds.size === 0}
                  className="px-4 py-1.5 text-xs rounded bg-ctp-accent/80 text-ctp-base
                    hover:bg-ctp-accent cursor-pointer font-medium disabled:opacity-50 flex items-center gap-1.5"
                >
                  {executing && <span className="w-3 h-3 border-2 border-ctp-base/50 border-t-ctp-base rounded-full animate-spin" />}
                  Save to Clubhouse
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
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
    <div className="mt-1.5 max-h-[200px] overflow-auto text-[11px] font-mono leading-relaxed">
      {diffLines.map((line, i) => (
        <div
          key={i}
          className={`px-1.5 ${
            line.type === 'added'
              ? 'bg-green-500/10 text-green-300'
              : line.type === 'removed'
                ? 'bg-red-500/10 text-red-300'
                : 'text-ctp-subtext0'
          }`}
        >
          <span className="select-none mr-1.5 text-ctp-subtext0/50">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          {line.text || '\u00A0'}
        </div>
      ))}
    </div>
  );
}
