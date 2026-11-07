/** An error code fit for the log (#2901): never a message, a path or a name. */
export function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : 'failed';
}
