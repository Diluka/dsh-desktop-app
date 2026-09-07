import { loopbackDshWebUrl } from "./dsh_web.ts";
import { probeHttp } from "./loopback_http.ts";
import type { ServerProfile } from "./profiles.ts";
import {
  type RecoveredRemoteDshWebToken,
  recoverRemoteDshWebToken,
} from "./remote_dsh_token_probe.ts";

export class DshConnectionError extends Error {
  override name = "DshConnectionError";

  constructor(readonly code: "DSH_LOGIN_REQUIRED" | "DSH_UNAVAILABLE", message: string) {
    super(message);
  }
}

/** Checks the service only; it has no ownership of the forwarding process. */
export async function connectDshWeb(
  profile: ServerProfile,
  localPort: number,
  options: {
    signal: AbortSignal;
    probe?: (url: string) => Promise<number>;
    recoverToken?: () => Promise<RecoveredRemoteDshWebToken | undefined>;
    startupTimeoutMs?: number;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
  },
): Promise<{ url: string; recovered?: RecoveredRemoteDshWebToken }> {
  throwIfAborted(options.signal);
  const timeoutMs = options.startupTimeoutMs ?? 20_000;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const timer = setTimeout(() => lifetime.abort(), timeoutMs);
  const now = options.now ?? Date.now;
  const probe = options.probe ??
    ((url: string) => probeHttp(url, { signal, accept: "text/html", validateStatus: () => true }));
  const recoverToken = options.recoverToken ??
    (() => recoverRemoteDshWebToken(profile, localPort, { signal, probe }));
  try {
    const url = loopbackDshWebUrl(localPort, profile.dshWebToken);
    const startedAt = now();
    while (now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      let status = 0;
      try {
        status = await waitForConnection(() => probe(url), signal);
      } catch {
        throwIfAborted(signal);
        // Connection refusal and transient service errors share the bounded wait.
      }
      throwIfAborted(signal);
      if (status === 401) {
        let recovered: RecoveredRemoteDshWebToken | undefined;
        try {
          // Recovery may own an auxiliary process. Never race past its cleanup,
          // even on cancellation. The default utility receives our lifetime signal.
          recovered = await recoverToken();
        } catch {
          throwIfAborted(signal);
        }
        throwIfAborted(signal);
        if (recovered) {
          // The recovery utility returns only an HTTP-verified candidate. The app
          // decides whether this generation still owns it before persisting it.
          return { url: loopbackDshWebUrl(localPort, recovered.token), recovered };
        }
        throw new DshConnectionError(
          "DSH_LOGIN_REQUIRED",
          "远端 DSH Web 要求登录，请输入新的 token 后重试",
        );
      }
      if (status >= 200 && status < 400) return { url };
      await waitForConnection(() => (options.delay ?? sleep)(150, signal), signal);
    }
    throw unavailable();
  } catch (error) {
    throwIfAborted(options.signal);
    if (error instanceof DshConnectionError) throw error;
    // Do not expose tokens/URLs from underlying HTTP or recovery exceptions.
    throw unavailable();
  } finally {
    clearTimeout(timer);
    lifetime.abort();
  }
}

function unavailable(): DshConnectionError {
  return new DshConnectionError(
    "DSH_UNAVAILABLE",
    "远端 DSH Web 未在限定时间内响应；请检查远端服务和端口配置",
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("DSH connection cancelled", "AbortError");
}

async function waitForConnection<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("DSH connection cancelled", "AbortError"));
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
      reject(new DOMException("DSH connection cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
