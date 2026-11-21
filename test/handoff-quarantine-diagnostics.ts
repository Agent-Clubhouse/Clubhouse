/** Hosted-test failure output: copy only closed allocator fields, never log arguments. */
export function quarantineFailureCapture() {
  const events: Record<string, string | number | boolean>[] = [];
  let dropped = 0;
  const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000;
  return {
    record(namespace: string, message: string, meta: Record<string, unknown> = {}) {
      if (namespace !== 'core:handoff') return;
      const event: Record<string, string | number | boolean> = {};
      if (message === 'Handoff quarantine root rejected') {
        event.event = 'root_rejected';
        if (typeof meta.failure === 'string' && /^(canonical|mkdir|identity|verify|recover|child):(timeout|permission|busy|other)$/.test(meta.failure)) event.failure = meta.failure;
        if (number(meta.attempt) && meta.attempt >= 1 && meta.attempt <= 3) event.attempt = meta.attempt;
        for (const key of ['created', 'recovery']) if (typeof meta[key] === 'boolean') event[key] = meta[key];
      } else if (message === 'Handoff quarantine allocation rejected') {
        event.event = 'allocation_rejected';
        for (const key of ['eligible', 'canonical', 'fitting']) if (number(meta[key])) event[key] = meta[key];
        if (typeof meta.admitted === 'boolean') event.admitted = meta.admitted;
      } else return;
      if (number(meta.elapsedMs)) event.elapsedMs = meta.elapsedMs;
      if (events.length < 32) events.push(event);
      else dropped = Math.min(dropped + 1, 86_400_000);
    },
    snapshot: () => ({ events: events.map((event) => ({ ...event })), dropped }),
  };
}
