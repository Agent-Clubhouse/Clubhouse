/** Deterministic no-authority-effect refusal; never wrap unknown filesystem errors. */
export class NoticeLedgerValidationError extends Error {
  constructor(message: string, public readonly original?: unknown) { super(message); }
}
