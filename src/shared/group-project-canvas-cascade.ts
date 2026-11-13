/** Remove a group's canvas references while preserving every unrelated field. */
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function removeGroupProjectCanvasReferences(
  instances: unknown,
  wires: unknown,
  zoneWires: unknown,
  groupProjectId: string,
): { instances: unknown[]; wires: unknown[]; zoneWires: unknown[] } {
  if (!Array.isArray(instances) || !Array.isArray(wires) || !Array.isArray(zoneWires)) {
    throw new Error('Canvas inventory is incomplete. Repair the canvas before deleting.');
  }
  const nextInstances = instances.map((raw) => {
    if (!record(raw) || !Array.isArray(raw.views)) throw new Error('Canvas inventory is incomplete. Repair the canvas before deleting.');
    const removed = new Set<string>();
    for (const view of raw.views) {
      if (!record(view) || typeof view.id !== 'string') throw new Error('Canvas inventory is incomplete. Repair the canvas before deleting.');
      if (view.type === 'plugin' && view.pluginWidgetType === 'plugin:group-project:group-project'
        && record(view.metadata) && view.metadata.groupProjectId === groupProjectId) removed.add(view.id);
    }
    const views = raw.views.filter((view) => !removed.has((view as RecordValue).id as string)).map((view) => {
      const item = view as RecordValue;
      if (item.type !== 'zone' || !Array.isArray(item.containedViewIds)) return item;
      return { ...item, containedViewIds: item.containedViewIds.filter((id) => !removed.has(String(id))) };
    });
    const result: RecordValue = { ...raw, views };
    for (const field of ['selectedViewId', 'zoomedViewId', 'layoutCenterId']) {
      if (typeof result[field] === 'string' && removed.has(result[field] as string)) result[field] = null;
    }
    if (Array.isArray(raw.deferredWires)) {
      result.deferredWires = raw.deferredWires.filter((wire) => {
        if (!record(wire)) throw new Error('Canvas inventory is incomplete. Repair the canvas before deleting.');
        return !removed.has(String(wire.sourceViewId)) && !removed.has(String(wire.targetViewId));
      });
    }
    return result;
  });
  const nextWires = wires.filter((wire) => {
    if (!record(wire)) throw new Error('Canvas wires are unreadable. Repair the canvas before deleting.');
    return wire.targetKind !== 'group-project' || wire.targetId !== groupProjectId;
  });
  const nextZoneWires = zoneWires.filter((wire) => {
    if (!record(wire)) throw new Error('Canvas zone wires are unreadable. Repair the canvas before deleting.');
    return wire.targetType !== 'group-project' || wire.targetId !== groupProjectId;
  });
  return { instances: nextInstances, wires: nextWires, zoneWires: nextZoneWires };
}

/** Strip deleted references from a late canvas key write. */
export function isGroupProjectCanvasKey(key: string): boolean {
  return key === 'canvas-instances' || key === 'canvas-instances-backup' || key.startsWith('canvas-instances-recovery-')
    || key === 'canvas-wires' || key === 'canvas-zone-wires';
}

export function stripDeletedGroupProjectsFromCanvasKey(key: string, value: unknown, deletedIds: Iterable<string>): unknown {
  const instancesKey = key === 'canvas-instances' || key === 'canvas-instances-backup' || key.startsWith('canvas-instances-recovery-');
  if (!isGroupProjectCanvasKey(key)) return value;
  const deleted = new Set(deletedIds);
  if (!Array.isArray(value)) return value;
  if (instancesKey) return value.map((raw) => {
    if (!record(raw) || !Array.isArray(raw.views)) return raw;
    const removed = new Set(raw.views.filter((view) => record(view) && typeof view.id === 'string'
      && view.type === 'plugin' && view.pluginWidgetType === 'plugin:group-project:group-project'
      && record(view.metadata) && typeof view.metadata.groupProjectId === 'string' && deleted.has(view.metadata.groupProjectId))
      .map((view) => (view as RecordValue).id as string));
    if (!removed.size) return raw;
    const views = raw.views.filter((view) => !record(view) || typeof view.id !== 'string' || !removed.has(view.id)).map((view) => {
      if (!record(view) || view.type !== 'zone' || !Array.isArray(view.containedViewIds)) return view;
      return { ...view, containedViewIds: view.containedViewIds.filter((id) => typeof id !== 'string' || !removed.has(id)) };
    });
    const result: RecordValue = { ...raw, views };
    for (const field of ['selectedViewId', 'zoomedViewId', 'layoutCenterId']) {
      if (typeof result[field] === 'string' && removed.has(result[field] as string)) result[field] = null;
    }
    if (Array.isArray(raw.deferredWires)) result.deferredWires = raw.deferredWires.filter((wire) => !record(wire)
      || (!removed.has(String(wire.sourceViewId)) && !removed.has(String(wire.targetViewId))));
    return result;
  });
  return value.filter((wire) => !record(wire) || typeof wire.targetId !== 'string' || !deleted.has(wire.targetId)
    || (key === 'canvas-wires' ? wire.targetKind !== 'group-project' : wire.targetType !== 'group-project'));
}
