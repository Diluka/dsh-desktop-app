import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;
export type LogContext = Readonly<Record<string, LogValue>>;

interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly sessionId: string;
  readonly event: string;
  readonly message: string;
  readonly context?: LogContext;
}

export class JsonlLogger {
  #pending: Promise<void> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    private readonly sessionId: string,
    private readonly now: () => Date,
  ) {}

  static async create(
    logDirectory: string,
    options: { sessionId?: string; now?: () => Date } = {},
  ): Promise<JsonlLogger> {
    const now = options.now ?? (() => new Date());
    await Deno.mkdir(logDirectory, { recursive: true });
    const day = now().toISOString().slice(0, 10);
    return new JsonlLogger(
      join(logDirectory, `dsh-desktop-${day}.jsonl`),
      options.sessionId ?? crypto.randomUUID(),
      now,
    );
  }

  debug(event: string, message: string, context?: LogContext): Promise<void> {
    return this.#write("debug", event, message, context);
  }

  info(event: string, message: string, context?: LogContext): Promise<void> {
    return this.#write("info", event, message, context);
  }

  warn(event: string, message: string, context?: LogContext): Promise<void> {
    return this.#write("warn", event, message, context);
  }

  error(event: string, message: string, context?: LogContext): Promise<void> {
    return this.#write("error", event, message, context);
  }

  flush(): Promise<void> {
    return this.#pending;
  }

  #write(
    level: LogLevel,
    event: string,
    message: string,
    context?: LogContext,
  ): Promise<void> {
    const entry: LogEntry = {
      timestamp: this.now().toISOString(),
      level,
      sessionId: this.sessionId,
      event,
      message: truncate(message, 2_000),
      ...(context ? { context: sanitizeContext(context) } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    const write = this.#pending.then(async () => {
      await Deno.writeTextFile(this.filePath, line, { append: true });
    });
    this.#pending = write.catch((error) => {
      console.error("Failed to write DSH Desktop log", error);
    });

    const consoleMethod = level === "error"
      ? console.error
      : level === "warn"
      ? console.warn
      : console.log;
    consoleMethod(`[${entry.timestamp}] ${level.toUpperCase()} ${event}: ${entry.message}`);
    return write;
  }
}

export function errorContext(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: truncate(error.message, 2_000),
      errorStack: truncate(error.stack ?? "", 4_000),
    };
  }
  return { errorMessage: truncate(String(error), 2_000) };
}

function sanitizeContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value === "string" ? truncate(value, 4_000) : value,
    ]),
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
