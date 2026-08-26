import { join } from "node:path";
import pino, { type Logger } from "pino";

const REDACTED = "[REDACTED]";
const SENSITIVE_PATHS = [
  "password",
  "passphrase",
  "token",
  "secret",
  "authorization",
  "Authorization",
  "err.password",
  "err.passphrase",
  "err.token",
  "err.secret",
  "err.authorization",
  "err.Authorization",
];

export async function createLogger(logDirectory: string): Promise<Logger> {
  await Deno.mkdir(logDirectory, { recursive: true });
  const startedAt = Temporal.Now.instant()
    .toString({ fractionalSecondDigits: 9 })
    .replaceAll(":", "-");
  const destination = pino.destination({
    dest: join(logDirectory, `dsh-desktop-${startedAt}.jsonl`),
    sync: true,
  });

  return pino({
    base: { pid: Deno.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: SENSITIVE_PATHS,
      censor: REDACTED,
    },
    serializers: {
      detail: (detail) => typeof detail === "string" ? sanitizeText(detail, 4_000) : detail,
      err: (error) => {
        const serialized = pino.stdSerializers.err(error);
        if (typeof serialized === "string") return sanitizeText(serialized, 2_000);
        if (!serialized || typeof serialized !== "object") return serialized;
        return {
          ...serialized,
          ...(typeof serialized.message === "string"
            ? { message: sanitizeText(serialized.message, 2_000) }
            : {}),
          ...(typeof serialized.stack === "string"
            ? { stack: sanitizeText(serialized.stack, 4_000) }
            : {}),
        };
      },
    },
  }, destination);
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
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}...`;
}
