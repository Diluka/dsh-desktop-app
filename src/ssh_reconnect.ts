import type { Logger } from "pino";
import type { ServerProfile } from "./profiles.ts";
import { type SshTunnel, TunnelError } from "./ssh_tunnel.ts";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const TERMINAL_CODES = new Set([
  "AUTH_FAILED",
  "HOST_KEY_FAILED",
  "SSH_NOT_FOUND",
  "DSH_LOGIN_REQUIRED",
]);

export interface SshReconnectProgress {
  phase: "waiting" | "connecting";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export async function reconnectSshTunnel(
  profile: ServerProfile,
  logger: Logger,
  options: {
    signal: AbortSignal;
    start: (signal: AbortSignal) => Promise<SshTunnel>;
    onProgress: (progress: SshReconnectProgress) => void;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<SshTunnel> {
  const { signal } = options;
  for (const [index, delayMs] of RETRY_DELAYS_MS.entries()) {
    throwIfAborted(signal);
    const attempt = index + 1;
    const progress = { attempt, maxAttempts: RETRY_DELAYS_MS.length, delayMs };
    options.onProgress({ ...progress, phase: "waiting" });
    await waitForReconnect(() => (options.delay ?? sleep)(delayMs, signal), signal);
    throwIfAborted(signal);
    options.onProgress({ ...progress, phase: "connecting" });
    throwIfAborted(signal);

    let candidate: SshTunnel | undefined;
    try {
      // Wait for the starter to finish cleaning up, even after cancellation.
      // A starter that ignores the signal may still return a tunnel; stop it below.
      candidate = await options.start(signal);
      throwIfAborted(signal);
      logger.info({
        event: "ssh.reconnect_ready",
        profileId: profile.id,
        attempt,
      }, "SSH tunnel reconnected");
      throwIfAborted(signal);
      return candidate;
    } catch (error) {
      if (signal.aborted && candidate) {
        // Cleanup failure must not replace the cancellation result.
        await candidate.stop().catch(() => undefined);
      }
      throwIfAborted(signal);
      logger.warn({
        event: "ssh.reconnect_failed",
        profileId: profile.id,
        attempt,
        errorCode: error instanceof TunnelError ? error.code : "UNKNOWN",
      }, "SSH tunnel reconnect attempt failed");
      if (
        !(error instanceof TunnelError) || TERMINAL_CODES.has(error.code) ||
        attempt === RETRY_DELAYS_MS.length
      ) throw error;
    }
  }
  // Every final attempt either returns a tunnel or throws its error.
  throw new Error("SSH reconnect attempts exhausted");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("SSH reconnect cancelled", "AbortError");
}

async function waitForReconnect<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("SSH reconnect cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return operation();
      }),
    ]);
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("SSH reconnect cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
