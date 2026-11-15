/** Logging only: never pass these summaries back to a process or transport. */
export function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Keep summaries stable when the local diag tier redacts them again.
    return /^<redacted: \d+ chars>$/.test(value) ? value : `<redacted: ${value.length} chars>`;
  }
  if (Array.isArray(value)) return `<redacted: ${value.length} items>`;
  if (value && typeof value === 'object') return `<redacted: ${Object.keys(value).length} keys>`;
  return value;
}

// Everything else, including unknown/provider-specific flags and positional
// prompts, is private by default. Do not add config/JSON or shell command flags.
const SAFE_VALUE_FLAGS = new Set([
  '--model', '-m', '--cwd', '--cd', '-C', '--effort', '--permission-mode',
  '--output-format', '--input-format', '--color', '--sandbox', '--approval-policy',
  '--ask-for-approval', '--log-level', '--listen',
]);

/** Preserve flag names; redact their values and all positional arguments. */
export function redactSpawnArgs(args: readonly string[]): string[] {
  let safeValue = false;
  let positional = false;
  let promptValue = false;
  const promptFlags = new Set(['-p', '--print', '--prompt', '--system-prompt', '--append-system-prompt', '--mission', '--message', '--instructions']);
  return args.map((arg) => {
    if (promptValue) {
      promptValue = false;
      return String(redactLogValue(arg));
    }
    if (!positional && arg === '--') {
      positional = true;
      safeValue = false;
      return arg;
    }
    if (!positional && /^--?[a-zA-Z][\w-]*(?:=|$)/.test(arg)) {
      const eq = arg.indexOf('=');
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      safeValue = SAFE_VALUE_FLAGS.has(flag);
      if (eq < 0) {
        promptValue = promptFlags.has(flag);
        return flag;
      }
      const value = arg.slice(eq + 1);
      const result = `${flag}=${safeValue ? value : redactLogValue(value)}`;
      safeValue = false;
      return result;
    }
    const result = safeValue ? arg : String(redactLogValue(arg));
    safeValue = false;
    return result;
  });
}

/** Per-run content scrubber: retain short diagnostic prose, never known prompts. */
export class LogRedactor {
  private readonly content = new Set<string>();

  constructor(args: readonly string[] = [], content: readonly string[] = []) {
    for (const text of content) this.rememberText(text);
    const safe = redactSpawnArgs(args);
    args.forEach((arg, i) => {
      if (arg === safe[i]) return;
      const eq = arg.indexOf('=');
      const value = arg.startsWith('-') && eq >= 0 ? arg.slice(eq + 1) : arg;
      this.rememberText(value);
      // Codex passes developer instructions as a -c key="JSON string" override.
      const assignment = /^([^=]+)=([\s\S]*)$/.exec(value);
      if (assignment && /prompt|mission|instruction/i.test(assignment[1])) {
        let content: unknown = assignment[2];
        try { content = JSON.parse(assignment[2]); } catch { /* A plain CLI value. */ }
        this.remember(content, true);
      }
    });
  }

  rememberText(text: string): void {
    if (!text) return;
    this.content.add(text);
    this.content.add(JSON.stringify(text).slice(1, -1));
    // Providers sometimes echo just one line of a multi-line system prompt.
    for (const line of text.split(/\r?\n/)) if (line.trim()) this.content.add(line);
  }

  /** Extract content strings from request structures, without retaining safe config values. */
  remember(value: unknown, content = false): void {
    if (typeof value === 'string') { if (content) this.rememberText(value); return; }
    if (Array.isArray(value)) { for (const v of value) this.remember(v, content); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (['type', 'role', 'id', 'method', 'model', 'mimeType'].includes(key)) continue;
      this.remember(v, content || /prompt|mission|instruction|^(text|content|input|message|messages|task|query|body|append)$/i.test(key));
    }
  }

  text(input: string, limit = 2000): string {
    let out = input;
    for (const content of [...this.content].sort((a, b) => b.length - a.length)) {
      out = out.split(content).join(String(redactLogValue(content)));
    }
    return out.length > limit ? `${out.slice(0, limit)}…[cut]` : out;
  }

  meta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!meta) return meta;
    return Object.fromEntries(Object.entries(meta).map(([key, value]) => [key,
      key === 'args' && Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? redactSpawnArgs(value)
        : ['data', 'line', 'stdout', 'params', 'prompt', 'mission', 'systemPrompt'].includes(key)
          ? redactLogValue(value)
          : typeof value === 'string' ? this.text(value) : value,
    ]));
  }
}
