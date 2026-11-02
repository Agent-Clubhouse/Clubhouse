/**
 * Something that decides whether `cli: "auto"` is allowed has changed: a
 * project's `off`, an orchestrator's switch, a persona, MCP (#2671). The writers
 * call this, and helper-routing moves the revision and tells open pages, so a
 * phone's stale write is refused with fresh values. It's a module of its own
 * because those writers sit below helper-routing, which reads them.
 */

type Listener = () => void;

let listener: Listener | null = null;

export function setRoutingPolicyListener(next: Listener | null): void {
  listener = next;
}

export function noteRoutingPolicyChanged(): void {
  listener?.();
}
