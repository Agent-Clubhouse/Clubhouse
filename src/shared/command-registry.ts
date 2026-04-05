/**
 * Unified Command Registry — foundation for converging canvas commands,
 * command palette, MCP tools, and plugin commands into a single dispatch layer.
 *
 * Phase 1: registry core + canvas command migration.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CommandDefinition {
  /** Dot-notation ID: "canvas.create", "canvas.addView" */
  id: string;
  /** Grouping category: "canvas", "agent", "project", etc. */
  category: string;
  /** Human-readable label for palette / UI */
  label: string;
  /** Longer description for MCP/CLI help text */
  description: string;
  /** Optional JSON Schema for arg validation */
  inputSchema?: object;
  /** Where the handler runs */
  process: 'main' | 'renderer';
  /** Command palette integration hints */
  palette?: { keywords?: string[]; shortcut?: string; hidden?: boolean };
  /** MCP tool integration hints */
  mcp?: { scoping: 'global' | 'binding' };
  /** CLI integration hints */
  cli?: { aliases?: string[]; hidden?: boolean };
  /** The actual handler — receives context + args, returns result */
  handler: (context: ExecutionContext, args: Record<string, unknown>) => Promise<CommandResult> | CommandResult;
}

export interface ExecutionContext {
  /** How the command was invoked */
  source: 'palette' | 'mcp' | 'ipc' | 'cli' | 'plugin';
  agentId?: string;
  projectId?: string;
}

export interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface Disposable {
  dispose(): void;
}

export type CommandEvent<T> = (listener: (value: T) => void) => Disposable;

/* ------------------------------------------------------------------ */
/*  Event emitter helper                                               */
/* ------------------------------------------------------------------ */

function createEvent<T>(): [CommandEvent<T>, (value: T) => void] {
  const listeners = new Set<(value: T) => void>();
  const event: CommandEvent<T> = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  const fire = (value: T) => {
    for (const listener of listeners) {
      listener(value);
    }
  };
  return [event, fire];
}

/* ------------------------------------------------------------------ */
/*  CommandRegistry                                                    */
/* ------------------------------------------------------------------ */

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  readonly onDidRegister: CommandEvent<CommandDefinition>;
  readonly onDidUnregister: CommandEvent<string>;

  private readonly fireRegister: (def: CommandDefinition) => void;
  private readonly fireUnregister: (id: string) => void;

  constructor() {
    const [onReg, fireReg] = createEvent<CommandDefinition>();
    const [onUnreg, fireUnreg] = createEvent<string>();
    this.onDidRegister = onReg;
    this.onDidUnregister = onUnreg;
    this.fireRegister = fireReg;
    this.fireUnregister = fireUnreg;
  }

  /**
   * Register a command. Returns a Disposable to unregister.
   * Throws if a command with the same ID is already registered.
   */
  register(def: CommandDefinition): Disposable {
    if (this.commands.has(def.id)) {
      throw new Error(`Command already registered: ${def.id}`);
    }
    this.commands.set(def.id, def);
    this.fireRegister(def);
    return {
      dispose: () => {
        if (this.commands.delete(def.id)) {
          this.fireUnregister(def.id);
        }
      },
    };
  }

  /** Look up a command by ID. */
  get(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  /** List commands, optionally filtered by category and/or process. */
  list(filter?: { category?: string; process?: string }): CommandDefinition[] {
    let result = Array.from(this.commands.values());
    if (filter?.category) {
      const cat = filter.category.toLowerCase();
      result = result.filter((c) => c.category.toLowerCase() === cat);
    }
    if (filter?.process) {
      result = result.filter((c) => c.process === filter.process);
    }
    return result;
  }

  /**
   * Execute a command by ID. Resolves the handler and passes context + args.
   * Returns an error result if the command is not found.
   */
  async execute(
    id: string,
    context: ExecutionContext,
    args: Record<string, unknown> = {},
  ): Promise<CommandResult> {
    const def = this.commands.get(id);
    if (!def) {
      return { success: false, error: `Unknown command: ${id}` };
    }
    try {
      return await def.handler(context, args);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Number of registered commands. */
  get size(): number {
    return this.commands.size;
  }

  /** Remove all commands (useful for testing). */
  clear(): void {
    const ids = Array.from(this.commands.keys());
    this.commands.clear();
    for (const id of ids) {
      this.fireUnregister(id);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                          */
/* ------------------------------------------------------------------ */

/** Global command registry instance shared across the process. */
export const commandRegistry = new CommandRegistry();
