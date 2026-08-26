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
      message: sanitizeText(message, 2_000),
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
    consoleMethod(
      `[${entry.timestamp}] ${level.toUpperCase()} ${event}: ${truncate(entry.message, 500)}`,
    );
    return write;
  }
}

export function errorContext(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: sanitizeText(error.message, 2_000),
      errorStack: sanitizeText(error.stack ?? "", 4_000),
    };
  }
  return { errorMessage: sanitizeText(String(error), 2_000) };
}

function sanitizeContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value !== "string"
        ? value
        : /password|passphrase|token|secret|authorization/iu.test(key)
        ? "[REDACTED]"
        : sanitizeText(value, 4_000),
    ]),
  );
}

function sanitizeText(value: string, maxLength: number): string {
  const redacted = value
    .replace(
      /\bauthorization\s*:\s*bearer\s+[^\s,;]+/giu,
      "Authorization: Bearer [REDACTED]",
    )
    .replace(/\bbearer\s+[a-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(
      /\b(password|passphrase|token|secret)\b(\s*[:=]\s*)[^\s,;]+/giu,
      "$1$2[REDACTED]",
    )
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/-----END [^-\r\n]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]");
  return truncate(redacted, maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
