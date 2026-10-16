/**
 * Ring buffer of the last exported items, post-redaction (spec §6.1). Backs
 * the Settings "Preview data" dialog in Phase 2: users see exactly what left
 * the machine, not what instrumentation tried to send.
 */

export interface PreviewItem {
  signal: 'traces' | 'metrics' | 'logs';
  name: string;
  /** Epoch milliseconds. */
  time: number;
  attributes: Record<string, string | number | boolean>;
  value?: number;
}

export const PREVIEW_CAPACITY = 200;

export class PreviewTee {
  private readonly items: PreviewItem[] = [];
  private next = 0;

  constructor(private readonly capacity = PREVIEW_CAPACITY) {}

  push(item: PreviewItem): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      this.items[this.next] = item;
    }
    this.next = (this.next + 1) % this.capacity;
  }

  /** Oldest first. */
  snapshot(): PreviewItem[] {
    if (this.items.length < this.capacity) return [...this.items];
    return [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
  }

  clear(): void {
    this.items.length = 0;
    this.next = 0;
  }
}
